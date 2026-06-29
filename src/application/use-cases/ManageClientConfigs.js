const clientConfigReasons = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
});

const allowedIntegrationModeNames = Object.freeze([
  'API',
  'STORE_PROCEDURE',
  'SQL_SCRIPT',
  'SERVICE_LAYER',
]);

function applyCustomFilterPatch(existingCustomFilters, incomingFilters) {
  const customByProperty = new Map(existingCustomFilters.map((filter) => [filter.property, filter]));

  for (const filter of incomingFilters) {
    customByProperty.set(filter.property, {
      operator: filter.operator,
      property: filter.property,
      value: filter.value ?? null,
      isDefault: false,
      isDynamic: false,
      editable: true,
    });
  }

  return Array.from(customByProperty.values());
}

function isConfigValidationError(error) {
  return /filters|Custom filter|mode|executionTime|executionDays|startTime|endTime|intervalMinutes|ValidationError/.test(error.message);
}

export class ManageClientConfigs {
  constructor({
    clientConfigRepository,
    filterPolicy,
    defaultMappingInitializer,
    scheduler,
    logger = console,
  }) {
    this.clientConfigRepository = clientConfigRepository;
    this.filterPolicy = filterPolicy;
    this.defaultMappingInitializer = defaultMappingInitializer;
    this.scheduler = scheduler;
    this.logger = logger;
  }

  async createClientConfig({ tenantModels, tenantKey, payload }) {
    try {
      const { integrationModeId } = payload;

      if (!integrationModeId) {
        return {
          ok: false,
          reason: clientConfigReasons.BAD_REQUEST,
          message: 'integrationModeId is required',
        };
      }

      const integrationModeExists = await this.clientConfigRepository.integrationModeExists({
        tenantModels,
        id: integrationModeId,
      });
      if (!integrationModeExists) {
        return {
          ok: false,
          reason: clientConfigReasons.BAD_REQUEST,
          message: 'integrationModeId is invalid',
        };
      }

      const createPayload = { ...payload };
      const customFilters = this.filterPolicy.sanitizeIncomingCustomFilters(createPayload.filters);
      const defaultFilters = await this.clientConfigRepository.findDefaultSapFilters({
        tenantModels,
        objectType: createPayload.objectType,
      });
      const merged = this.filterPolicy.buildMergedFilters({ defaultFilters, customFilters });
      createPayload.filters = merged.filters;

      this.logger.info?.({
        msg: 'Integrated default SAP filters into ClientConfig creation',
        objectType: createPayload.objectType,
        defaultCount: merged.defaultCount,
        customCount: merged.customCount,
      });

      const data = await this.clientConfigRepository.createClientConfig({
        tenantModels,
        payload: createPayload,
      });

      await this.defaultMappingInitializer.ensureAll({
        FieldMapping: tenantModels.FieldMapping,
        clientConfig: data,
      });

      await this.syncScheduler({ tenantKey, config: data });

      return { ok: true, data };
    } catch (error) {
      if (isConfigValidationError(error)) {
        return {
          ok: false,
          reason: clientConfigReasons.BAD_REQUEST,
          message: error.message,
        };
      }

      throw error;
    }
  }

  async listClientConfigs({ tenantModels }) {
    const data = await this.clientConfigRepository.listClientConfigs({ tenantModels });
    return { ok: true, data };
  }

  async createIntegrationMode({ tenantModels, payload }) {
    const { name, description } = payload;

    if (name && !allowedIntegrationModeNames.includes(name)) {
      return {
        ok: false,
        reason: clientConfigReasons.BAD_REQUEST,
        message: `Integration mode must be one of: ${allowedIntegrationModeNames.join(', ')}`,
      };
    }

    const data = await this.clientConfigRepository.createIntegrationMode({
      tenantModels,
      payload: { name, description },
    });
    return { ok: true, data };
  }

  async listIntegrationModes({ tenantModels }) {
    const data = await this.clientConfigRepository.listIntegrationModes({ tenantModels });
    const payload = data.map((mode) => ({
      id: mode._id,
      name: mode.name,
      description: mode.description,
    }));

    return { ok: true, data: payload };
  }

  async patchClientConfig({ tenantModels, tenantKey, id, payload }) {
    try {
      const config = await this.clientConfigRepository.findClientConfigById({
        tenantModels,
        id,
      });

      if (!config) {
        return {
          ok: false,
          reason: clientConfigReasons.NOT_FOUND,
          message: 'ClientConfig not found',
        };
      }

      const patchPayload = { ...payload };
      const existingFilters = Array.isArray(config.filters) ? config.filters : [];
      const existingDefaults = existingFilters.filter((filter) => filter?.isDefault === true);
      const existingCustom = existingFilters.filter((filter) => filter?.isDefault !== true);

      if (Object.prototype.hasOwnProperty.call(patchPayload, 'filters')) {
        if (!Array.isArray(patchPayload.filters)) {
          return {
            ok: false,
            reason: clientConfigReasons.BAD_REQUEST,
            message: 'filters must be an array',
          };
        }

        if (patchPayload.filters.some((filter) => filter?.isDefault === true)) {
          this.logger.warn?.({ msg: 'Client attempted to modify default filters', clientConfigId: id });
          return {
            ok: false,
            reason: clientConfigReasons.FORBIDDEN,
            message: 'Default filters cannot be modified or removed',
          };
        }

        const incomingCustomFilters = this.filterPolicy.sanitizeIncomingCustomFilters(
          patchPayload.filters
        );
        const updatedCustomFilters = applyCustomFilterPatch(existingCustom, incomingCustomFilters);

        patchPayload.filters = [
          ...existingDefaults.map((filter) => ({
            operator: filter.operator,
            property: filter.property,
            value: filter.value,
            isDefault: true,
            isDynamic: Boolean(filter.isDynamic),
            dynamicType: filter.dynamicType || 'datetime',
            editable: false,
          })),
          ...updatedCustomFilters,
        ];
      }

      const previousConfig = config.toObject();

      delete patchPayload._id;
      delete patchPayload.integrationModeId;

      Object.assign(config, patchPayload);
      await config.save();

      await this.syncScheduler({ tenantKey, config, previousConfig });

      return { ok: true, data: config };
    } catch (error) {
      if (isConfigValidationError(error)) {
        return {
          ok: false,
          reason: clientConfigReasons.BAD_REQUEST,
          message: error.message,
        };
      }

      throw error;
    }
  }

  async syncScheduler({ tenantKey, config, previousConfig }) {
    try {
      await this.scheduler.syncScheduledJob({ tenantKey, config, previousConfig });
    } catch (syncError) {
      this.logger.error?.({
        msg: previousConfig
          ? 'Failed syncing scheduler after ClientConfig patch'
          : 'Failed syncing scheduler after ClientConfig create',
        tenantKey,
        clientConfigId: config?._id?.toString(),
        error: syncError.message,
      });
    }
  }
}

export { clientConfigReasons };

export default ManageClientConfigs;
