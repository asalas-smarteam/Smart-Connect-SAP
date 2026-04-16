import logger from '../core/logger.js';
import { requireTenantModels } from '../utils/tenantModels.js';
import {
  buildMergedFilters,
  sanitizeIncomingCustomFilters,
} from '../services/tenant/clientConfigFilters.service.js';
import {
  ensureDefaultCompanyEmployeeMappings,
  ensureDefaultContactEmployeeMappings,
  ensureDefaultDealMappings,
  ensureDefaultProductMappings,
} from '../services/tenant/defaultClientConfigMappings.service.js';
import { syncScheduledJob } from '../services/scheduler/sapSyncScheduler.service.js';

function applyCustomFilterPatch(existingCustomFilters, incomingFilters) {
  const customByProperty = new Map(existingCustomFilters.map((f) => [f.property, f]));

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

export const createClientConfig = async (req, reply) => {
  try {
    const { ClientConfig, FieldMapping, IntegrationMode, SapFilter } = requireTenantModels(req);
    const { integrationModeId } = req.body;

    if (!integrationModeId) {
      return reply.send({
        ok: false,
        message: 'integrationModeId is required',
      });
    }

    const integrationModeExists = await IntegrationMode.exists({ _id: integrationModeId });
    if (!integrationModeExists) {
      return reply.send({
        ok: false,
        message: 'integrationModeId is invalid',
      });
    }

    const payload = { ...req.body };

    const customFilters = sanitizeIncomingCustomFilters(payload.filters);
    const defaultFilters = await SapFilter.find({
      objectType: payload.objectType,
      active: true,
    }).lean();

    const merged = buildMergedFilters({
      defaultFilters,
      customFilters,
    });
    payload.filters = merged.filters;

    logger.info({
      msg: 'Integrated default SAP filters into ClientConfig creation',
      objectType: payload.objectType,
      defaultCount: merged.defaultCount,
      customCount: merged.customCount,
    });

    const data = await ClientConfig.create(payload);
    await ensureDefaultCompanyEmployeeMappings({
      FieldMapping,
      clientConfig: data,
    });
    await ensureDefaultContactEmployeeMappings({
      FieldMapping,
      clientConfig: data,
    });
    await ensureDefaultDealMappings({
      FieldMapping,
      clientConfig: data,
    });
    await ensureDefaultProductMappings({
      FieldMapping,
      clientConfig: data,
    });

    try {
      await syncScheduledJob({
        tenantKey: req.tenantKey,
        config: data,
      });
    } catch (syncError) {
      logger.error({
        msg: 'Failed syncing scheduler after ClientConfig create',
        tenantKey: req.tenantKey,
        clientConfigId: data?._id?.toString(),
        error: syncError.message,
      });
    }

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    logger.error({ msg: 'Failed creating ClientConfig', error: error.message });
    const statusCode = /filters|Custom filter|mode|executionTime|intervalMinutes|ValidationError/.test(error.message) ? 400 : 500;
    return reply.code(statusCode).send({
      ok: false,
      message: error.message,
    });
  }
};

export const getClientConfig = async (req, reply) => {
  try {
    const { ClientConfig } = requireTenantModels(req);
    const data = await ClientConfig.find().populate('integrationModeId');

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};

export const createIntegrationMode = async (req, reply) => {
  try {
    const { name, description } = req.body;
    const allowedNames = ['API', 'STORE_PROCEDURE', 'SQL_SCRIPT', 'SERVICE_LAYER'];

    if (name && !allowedNames.includes(name)) {
      return reply.send({
        ok: false,
        message: `Integration mode must be one of: ${allowedNames.join(', ')}`,
      });
    }

    const { IntegrationMode } = requireTenantModels(req);
    const data = await IntegrationMode.create({ name, description });

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};

export const getIntegrationModes = async (req, reply) => {
  try {
    const { IntegrationMode } = requireTenantModels(req);
    const data = await IntegrationMode.find().lean();
    const payload = data.map((mode) => ({
      id: mode._id,
      name: mode.name,
      description: mode.description,
    }));

    return reply.send({
      ok: true,
      data: payload,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};


export const patchClientConfig = async (req, reply) => {
  try {
    const { ClientConfig } = requireTenantModels(req);
    const { id } = req.params;
    const payload = { ...req.body };


    const config = await ClientConfig.findById(id);
    if (!config) {
      return reply.code(404).send({
        ok: false,
        message: 'ClientConfig not found',
      });
    }

    const existingFilters = Array.isArray(config.filters) ? config.filters : [];
    const existingDefaults = existingFilters.filter((filter) => filter?.isDefault === true);
    const existingCustom = existingFilters.filter((filter) => filter?.isDefault !== true);

    if (Object.prototype.hasOwnProperty.call(payload, 'filters')) {
      if (!Array.isArray(payload.filters)) {
        return reply.code(400).send({ ok: false, message: 'filters must be an array' });
      }

      if (payload.filters.some((filter) => filter?.isDefault === true)) {
        logger.warn({ msg: 'Client attempted to modify default filters', clientConfigId: id });
        return reply.code(403).send({
          ok: false,
          message: 'Default filters cannot be modified or removed',
        });
      }

      const incomingCustomFilters = sanitizeIncomingCustomFilters(payload.filters);
      const updatedCustomFilters = applyCustomFilterPatch(existingCustom, incomingCustomFilters);

      payload.filters = [
        ...existingDefaults.map((filter) => ({
          operator: filter.operator,
          property: filter.property,
          value: filter.value,
          isDefault: true,
          isDynamic: Boolean(filter.isDynamic),
          editable: false,
        })),
        ...updatedCustomFilters,
      ];
    }

    const previousConfig = config.toObject();

    delete payload._id;
    delete payload.integrationModeId;

    Object.assign(config, payload);
    await config.save();

    try {
      await syncScheduledJob({
        tenantKey: req.tenantKey,
        config,
        previousConfig,
      });
    } catch (syncError) {
      logger.error({
        msg: 'Failed syncing scheduler after ClientConfig patch',
        tenantKey: req.tenantKey,
        clientConfigId: config?._id?.toString(),
        error: syncError.message,
      });
    }

    return reply.send({ ok: true, data: config });
  } catch (error) {
    logger.error({ msg: 'Failed patching ClientConfig', error: error.message });
    const statusCode = /filters|mode|executionTime|intervalMinutes|ValidationError/.test(error.message) ? 400 : 500;
    return reply.code(statusCode).send({
      ok: false,
      message: error.message,
    });
  }
};
