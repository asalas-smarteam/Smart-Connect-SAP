const CLIENT_CONFIG_REQUIRED = 'CLIENT_CONFIG_REQUIRED';
const DUPLICATE_MAPPING = 'DUPLICATE_MAPPING';
const SOURCE_CONTEXT_REQUIRED = 'SOURCE_CONTEXT_REQUIRED';

function resolveSourceContext(objectType, sourceContext) {
  return sourceContext || (objectType === 'product' ? 'product' : 'businessPartner');
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || String(error?.message || '').includes('E11000');
}

export class ManageFieldMappings {
  constructor({ mappingManagementRepository, fieldMappingService }) {
    this.mappingManagementRepository = mappingManagementRepository;
    this.fieldMappingService = fieldMappingService;
  }

  async createTenantMapping({ tenantModels, payload }) {
    const {
      sourceField,
      targetField,
      objectType,
      clientConfigId,
      sourceContext,
      includeInServiceLayerSelect,
    } = payload;
    const resolvedSourceContext = resolveSourceContext(objectType, sourceContext);
    const config = await this.mappingManagementRepository.findActiveClientConfig({
      tenantModels,
      objectType,
    });

    if (!config?.hubspotCredentialId) {
      return {
        ok: false,
        reason: CLIENT_CONFIG_REQUIRED,
        message: 'You must create a client task before creating mappings.',
      };
    }

    const existing = await this.mappingManagementRepository.findDuplicate({
      tenantModels,
      hubspotCredentialId: config.hubspotCredentialId,
      objectType,
      sourceContext: resolvedSourceContext,
      sourceField,
    });

    if (existing) {
      return {
        ok: false,
        reason: DUPLICATE_MAPPING,
        message: 'Mapping already exists for this sourceField and objectType.',
      };
    }

    const data = await this.mappingManagementRepository.create({
      tenantModels,
      data: {
        sourceField,
        targetField,
        objectType,
        clientConfigId,
        hubspotCredentialId: config.hubspotCredentialId,
        sourceContext: resolvedSourceContext,
        includeInServiceLayerSelect,
      },
    });

    return { ok: true, data };
  }

  async createAdminMapping({ tenantModels, payload }) {
    const {
      sourceField,
      targetField,
      objectType,
      sourceContext,
      clientConfigId,
      hubspotCredentialId,
      includeInServiceLayerSelect,
    } = payload;

    if (!sourceContext) {
      return {
        ok: false,
        reason: SOURCE_CONTEXT_REQUIRED,
        message: 'sourceContext is required',
      };
    }

    try {
      const data = await this.mappingManagementRepository.create({
        tenantModels,
        data: {
          sourceField,
          targetField,
          objectType,
          sourceContext,
          clientConfigId,
          hubspotCredentialId,
          includeInServiceLayerSelect,
        },
      });

      return { ok: true, data };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return {
          ok: false,
          reason: DUPLICATE_MAPPING,
          message: 'Mapping already exists for this sourceField and objectType.',
        };
      }

      throw error;
    }
  }

  async listMappings({ tenantModels, query }) {
    const { hubspotCredentialId, objectType } = query;
    const filter = {};

    if (hubspotCredentialId && objectType) {
      filter.hubspotCredentialId = hubspotCredentialId;
      filter.objectType = objectType;
    }

    const data = await this.mappingManagementRepository.list({ tenantModels, filter });
    return { ok: true, data };
  }

  async applyMappingTest({ tenantModels, payload }) {
    const { data, hubspotCredentialId, objectType } = payload;
    const mapped = await this.fieldMappingService.applyMapping(
      data,
      hubspotCredentialId,
      objectType,
      tenantModels
    );

    return { ok: true, mapped };
  }
}

export const fieldMappingReasons = Object.freeze({
  CLIENT_CONFIG_REQUIRED,
  DUPLICATE_MAPPING,
  SOURCE_CONTEXT_REQUIRED,
});

export default ManageFieldMappings;
