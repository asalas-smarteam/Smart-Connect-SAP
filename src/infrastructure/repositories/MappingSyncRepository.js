import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
import DynamicDescriptionConfigRepository from '#infrastructure/config/DynamicDescriptionConfigRepository.js';
import MappingFallbackConfigRepository from '#infrastructure/config/MappingFallbackConfigRepository.js';
import { applyDynamicDescription } from '#domain/sync/dynamic-description.service.js';
import { DEFAULT_INVOICE_MAPPINGS } from '#application/services/defaultClientConfigMappings.service.js';
import {
  buildMappedProperties,
  resolveValueByPath,
} from '#application/services/mappingValueResolver.service.js';

const DEFAULT_PRODUCT_MAPPINGS = Object.freeze([
  { sourceField: 'ItemCode', targetField: 'hs_sku', sourceContext: 'product' },
  { sourceField: 'ItemName', targetField: 'name', sourceContext: 'product' },
  {
    sourceField: 'QuantityOnStock',
    targetField: 'quantity',
    sourceContext: 'product',
    includeInServiceLayerSelect: false,
  },
  {
    sourceField: 'Price',
    targetField: 'price',
    sourceContext: 'product',
    includeInServiceLayerSelect: false,
  },
]);

const DEFAULT_MAPPINGS_BY_OBJECT_TYPE = Object.freeze({
  product: DEFAULT_PRODUCT_MAPPINGS,
  invoice: DEFAULT_INVOICE_MAPPINGS,
});

function resolveTenantModels(tenantContext) {
  const tenantModels = tenantContext?.tenantModels;

  if (!tenantModels?.FieldMapping) {
    throw new Error('Tenant context with FieldMapping model is required');
  }

  return tenantModels;
}

function resolveSourceContext(objectType, sourceContext) {
  if (objectType === 'product') {
    return 'product';
  }

  return sourceContext || 'businessPartner';
}

async function resolveDocuments(query) {
  const result = typeof query?.lean === 'function' ? await query.lean() : await query;
  return Array.isArray(result) ? result : [];
}

function toMappingDto(mapping) {
  return {
    id: mapping?.id ?? mapping?._id ?? null,
    sourceField: mapping?.sourceField ?? null,
    targetField: mapping?.targetField ?? null,
    objectType: mapping?.objectType ?? null,
    sourceContext: mapping?.sourceContext ?? null,
    includeInServiceLayerSelect: mapping?.includeInServiceLayerSelect,
    isActive: mapping?.isActive ?? true,
  };
}

function mapFields(
  inputData,
  mappings,
  objectType,
  dynamicDescriptionConfig = null,
  sourceContext = null,
  fallbackConfig = null
) {
  const properties = buildMappedProperties({
    input: inputData ?? {},
    mappings,
    fallbackConfig,
  });

  // Runs after the 1:1 pass so a composed value deliberately overwrites the
  // plain mapping that targets the same HubSpot property.
  applyDynamicDescription({
    properties,
    record: inputData,
    objectType,
    sourceContext,
    config: dynamicDescriptionConfig,
    resolveField: resolveValueByPath,
  });

  const mappedFields = { properties };

  if (objectType === 'deal' && inputData) {
    ['associatedContacts', 'associatedCompanies', 'associatedProducts'].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(inputData, field)) {
        mappedFields[field] = inputData[field];
      }
    });
  }

  return mappedFields;
}

export class MappingSyncRepository {
  constructor({
    fieldMappingRepository = new TenantFieldMappingRepository(),
    dynamicDescriptionConfigRepository = new DynamicDescriptionConfigRepository(),
    mappingFallbackConfigRepository = new MappingFallbackConfigRepository(),
  } = {}) {
    this.fieldMappingRepository = fieldMappingRepository;
    this.dynamicDescriptionConfigRepository = dynamicDescriptionConfigRepository;
    this.mappingFallbackConfigRepository = mappingFallbackConfigRepository;
  }

  async mapRecords({ sapRecords, hubspotCredentialId, objectType, tenantContext, sourceContext }) {
    if (!Array.isArray(sapRecords)) {
      throw new Error('sapRecords must be an array');
    }

    const resolvedSourceContext = resolveSourceContext(objectType, sourceContext);
    const mappings = await this.findMappings({
      tenantContext,
      hubspotCredentialId,
      objectType,
      sourceContext: resolvedSourceContext,
    });

    if (mappings.length === 0) {
      return [];
    }

    // Read once per run, not per record.
    const [dynamicDescriptionConfig, fallbackConfig] = await Promise.all([
      this.getDynamicDescriptionConfig({ tenantContext }),
      this.getMappingFallbackConfig({ tenantContext }),
    ]);

    return sapRecords.map(
      (record) => mapFields(
        record,
        mappings,
        objectType,
        dynamicDescriptionConfig,
        resolvedSourceContext,
        fallbackConfig
      )
    );
  }

  async getMappingFallbackConfig({ tenantContext }) {
    if (typeof this.mappingFallbackConfigRepository?.getMappingFallbackConfig !== 'function') {
      return null;
    }

    return this.mappingFallbackConfigRepository.getMappingFallbackConfig({ tenantContext });
  }

  async getDynamicDescriptionConfig({ tenantContext }) {
    if (typeof this.dynamicDescriptionConfigRepository?.getDynamicDescriptionConfig !== 'function') {
      return null;
    }

    return this.dynamicDescriptionConfigRepository.getDynamicDescriptionConfig({ tenantContext });
  }

  async ensureDefaultMappings({
    tenantContext,
    hubspotCredentialId,
    objectType,
    clientConfig,
  }) {
    const tenantModels = resolveTenantModels(tenantContext);

    if (!hubspotCredentialId) {
      throw new Error('hubspotCredentialId is required to ensure default mappings');
    }

    if (!objectType) {
      throw new Error('objectType is required to ensure default mappings');
    }

    const defaultMappings = DEFAULT_MAPPINGS_BY_OBJECT_TYPE[objectType];

    if (!defaultMappings) {
      return [];
    }

    const clientConfigId = clientConfig?._id ?? clientConfig?.id;

    if (!clientConfigId) {
      throw new Error(`clientConfig is required to ensure ${objectType} default mappings`);
    }

    const createdOrUpdated = [];

    for (const mapping of defaultMappings) {
      const existing = await tenantModels.FieldMapping.findOne({
        hubspotCredentialId,
        objectType,
        sourceContext: mapping.sourceContext,
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
      });

      if (!existing) {
        const created = await tenantModels.FieldMapping.create({
          ...mapping,
          objectType,
          clientConfigId,
          hubspotCredentialId,
          editable: false,
        });
        createdOrUpdated.push(toMappingDto(created));
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(mapping, 'includeInServiceLayerSelect')) {
        const includeInServiceLayerSelect = Boolean(mapping.includeInServiceLayerSelect);
        if (Boolean(existing.includeInServiceLayerSelect) !== includeInServiceLayerSelect) {
          await tenantModels.FieldMapping.updateOne(
            { _id: existing._id },
            { $set: { includeInServiceLayerSelect } }
          );
          createdOrUpdated.push({
            ...toMappingDto(existing),
            includeInServiceLayerSelect,
          });
        }
      }
    }

    return createdOrUpdated;
  }

  async findMappings({ tenantContext, hubspotCredentialId, objectType, sourceContext }) {
    const tenantModels = resolveTenantModels(tenantContext);

    if (!hubspotCredentialId) {
      throw new Error('hubspotCredentialId is required to find mappings');
    }

    if (!objectType) {
      throw new Error('objectType is required to find mappings');
    }

    const resolvedSourceContext = resolveSourceContext(objectType, sourceContext);
    let mappingQuery = await this.fieldMappingRepository.findByCredentialObjectAndContext({
        tenantModels,
        hubspotCredentialId,
        objectType,
        sourceContext: resolvedSourceContext,
        activeOnly: true,
        includeMissingBusinessPartner: resolvedSourceContext === 'businessPartner',
      });
    let mappings = await resolveDocuments(mappingQuery);

    if (mappings.length === 0 && resolvedSourceContext !== 'businessPartner') {
      mappingQuery = await this.fieldMappingRepository.findByCredentialObjectAndContext({
          tenantModels,
          hubspotCredentialId,
          objectType,
          sourceContext: 'businessPartner',
          activeOnly: true,
          includeMissingBusinessPartner: true,
        });
      mappings = await resolveDocuments(mappingQuery);
    }

    return mappings.map(toMappingDto);
  }
}

export default MappingSyncRepository;
