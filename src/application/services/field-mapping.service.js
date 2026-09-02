import { applyDynamicDescription } from '#domain/sync/dynamic-description.service.js';
import {
  buildMappedProperties,
  resolveValueByPath,
} from '#application/services/mappingValueResolver.service.js';

function resolveSourceContext(objectType, sourceContext) {
  if (objectType === 'product') {
    return 'product';
  }

  return sourceContext || 'businessPartner';
}

function normalizeAssociations(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function mapFields(
  inputData,
  mappings,
  objectType,
  dynamicDescriptionConfig = null,
  sourceContext = null,
  fallbackConfig = null,
  phoneConfig = null
) {
  const resolvedInput = inputData ?? {};
  const result = buildMappedProperties({
    input: resolvedInput,
    mappings,
    fallbackConfig,
    phoneConfig,
  });

  // Runs after the 1:1 pass so a composed value deliberately overwrites the
  // plain mapping that targets the same HubSpot property.
  applyDynamicDescription({
    properties: result,
    record: resolvedInput,
    objectType,
    sourceContext,
    config: dynamicDescriptionConfig,
    resolveField: resolveValueByPath,
  });

  const mappedFields = { properties: result };

  if (objectType === 'deal' && inputData) {
    ['associatedContacts', 'associatedCompanies', 'associatedProducts'].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(inputData, field)) {
        mappedFields[field] = inputData[field];
      }
    });
  }

  return mappedFields;
}

export class FieldMappingService {
  constructor({
    fieldMappingRepository,
    dynamicDescriptionConfigRepository = null,
    mappingFallbackConfigRepository = null,
    phoneNormalizationConfigRepository = null,
    logger = console,
  }) {
    this.fieldMappingRepository = fieldMappingRepository;
    this.dynamicDescriptionConfigRepository = dynamicDescriptionConfigRepository;
    this.mappingFallbackConfigRepository = mappingFallbackConfigRepository;
    this.phoneNormalizationConfigRepository = phoneNormalizationConfigRepository;
    this.logger = logger;
  }

  // Returns null (conducta histórica: solo se limpia lo cosmético de `phone`)
  // when no repository was injected.
  async getPhoneNormalizationConfig(tenantModels) {
    if (typeof this.phoneNormalizationConfigRepository?.getPhoneNormalizationConfig !== 'function') {
      return null;
    }

    try {
      return await this.phoneNormalizationConfigRepository.getPhoneNormalizationConfig({
        tenantModels,
      });
    } catch (error) {
      this.logger.error?.('Failed to fetch phone normalization config:', error);
      return null;
    }
  }

  // Returns the legacy behaviour (chain off) when no repository was injected.
  async getMappingFallbackConfig(tenantModels) {
    if (typeof this.mappingFallbackConfigRepository?.getMappingFallbackConfig !== 'function') {
      return null;
    }

    try {
      return await this.mappingFallbackConfigRepository.getMappingFallbackConfig({ tenantModels });
    } catch (error) {
      this.logger.error?.('Failed to fetch mapping fallback config:', error);
      return null;
    }
  }

  // Returns null (composition disabled) when no repository was injected.
  async getDynamicDescriptionConfig(tenantModels) {
    if (typeof this.dynamicDescriptionConfigRepository?.getDynamicDescriptionConfig !== 'function') {
      return null;
    }

    try {
      return await this.dynamicDescriptionConfigRepository.getDynamicDescriptionConfig({ tenantModels });
    } catch (error) {
      this.logger.error?.('Failed to fetch dynamic description config:', error);
      return null;
    }
  }

  async getMappings(hubspotCredentialId, objectType, tenantModels, sourceContext) {
    try {
      if (!hubspotCredentialId) {
        return [];
      }

      const resolvedSourceContext = resolveSourceContext(objectType, sourceContext);
      let mappings = await this.fieldMappingRepository.findByCredentialObjectAndContext({
        tenantModels,
        hubspotCredentialId,
        objectType,
        sourceContext: resolvedSourceContext,
        includeMissingBusinessPartner: resolvedSourceContext === 'businessPartner',
      });

      if (mappings.length === 0 && resolvedSourceContext !== 'businessPartner') {
        mappings = await this.fieldMappingRepository.findByCredentialObjectAndContext({
          tenantModels,
          hubspotCredentialId,
          objectType,
          sourceContext: 'businessPartner',
          includeMissingBusinessPartner: true,
        });
      }

      return mappings;
    } catch (error) {
      this.logger.error?.('Failed to fetch mappings:', error);
      return [];
    }
  }

  async mapRecords(records, hubspotCredentialId, objectType, tenantModels, sourceContext) {
    try {
      const resolvedSourceContext = resolveSourceContext(objectType, sourceContext);
      let mappings = await this.getMappingsByObjectType(
        hubspotCredentialId,
        objectType,
        resolvedSourceContext,
        tenantModels
      );

      if (mappings.length === 0 && resolvedSourceContext !== 'businessPartner') {
        mappings = await this.getMappingsByObjectType(
          hubspotCredentialId,
          objectType,
          'businessPartner',
          tenantModels
        );
      }

      if (mappings.length === 0) {
        return [];
      }

      // Read once per batch, not per record.
      const [dynamicDescriptionConfig, fallbackConfig, phoneConfig] = await Promise.all([
        this.getDynamicDescriptionConfig(tenantModels),
        this.getMappingFallbackConfig(tenantModels),
        this.getPhoneNormalizationConfig(tenantModels),
      ]);

      return records.map(
        (record) => mapFields(
          record,
          mappings,
          objectType,
          dynamicDescriptionConfig,
          resolvedSourceContext,
          fallbackConfig,
          phoneConfig
        )
      );
    } catch (error) {
      this.logger.error?.('Failed to apply mappings:', error);
      return [];
    }
  }

  resolvePath(obj, path) {
    return resolveValueByPath(obj, path);
  }

  async getActiveMappingsByClientConfig(clientConfigId, tenantModels) {
    try {
      if (!clientConfigId) {
        return [];
      }

      return this.fieldMappingRepository.findActiveByClientConfig({
        tenantModels,
        clientConfigId,
      });
    } catch (error) {
      this.logger.error?.('Failed to fetch mappings by clientConfig:', error);
      return [];
    }
  }

  async getMappingsByObjectType(hubspotCredentialId, objectType, sourceContext, tenantModels) {
    try {
      if (!hubspotCredentialId || !objectType) {
        return [];
      }

      const resolvedSourceContext = resolveSourceContext(objectType, sourceContext);
      let mappings = await this.fieldMappingRepository.findByCredentialObjectAndContext({
        tenantModels,
        hubspotCredentialId,
        objectType,
        sourceContext: resolvedSourceContext,
        activeOnly: true,
      });

      if (mappings.length === 0 && resolvedSourceContext !== 'businessPartner') {
        mappings = await this.fieldMappingRepository.findByCredentialObjectAndContext({
          tenantModels,
          hubspotCredentialId,
          objectType,
          sourceContext: 'businessPartner',
          activeOnly: true,
        });
      }

      return mappings;
    } catch (error) {
      this.logger.error?.('Failed to fetch mappings by objectType:', error);
      return [];
    }
  }

  async applyMapping(inputData, hubspotCredentialId, objectType, tenantModels, sourceContext) {
    try {
      // La config de teléfono también acá: este es el endpoint con el que se
      // prueba un mapeo, y una prueba que no normaliza igual que el sync real
      // hace perder la tarde buscando una diferencia que no existe.
      const [mappings, dynamicDescriptionConfig, phoneConfig] = await Promise.all([
        this.getMappings(hubspotCredentialId, objectType, tenantModels, sourceContext),
        this.getDynamicDescriptionConfig(tenantModels),
        this.getPhoneNormalizationConfig(tenantModels),
      ]);

      return mapFields(
        inputData,
        mappings,
        objectType,
        dynamicDescriptionConfig,
        resolveSourceContext(objectType, sourceContext),
        null,
        phoneConfig
      );
    } catch (error) {
      this.logger.error?.('Failed to apply mappings:', error);
      return {};
    }
  }

  async applyDealWebhookMapping(payload, hubspotCredentialId, tenantModels) {
    try {
      const [
        dealMappings,
        contactMappings,
        companyMappings,
        productMappings,
        dynamicConfig,
      ] = await Promise.all([
        this.getMappings(hubspotCredentialId, 'deal', tenantModels),
        this.getMappings(hubspotCredentialId, 'contact', tenantModels),
        this.getMappings(hubspotCredentialId, 'company', tenantModels),
        this.getMappings(hubspotCredentialId, 'product', tenantModels),
        this.getDynamicDescriptionConfig(tenantModels),
      ]);

      const dealPayload = payload?.deal ?? null;
      const contactPayload = payload?.contact ?? null;
      const companyPayload = payload?.company ?? null;
      const lineItemsPayload = normalizeAssociations(payload?.line_items ?? []);

      const dealMapped = mapFields(dealPayload, dealMappings, 'deal', dynamicConfig, 'businessPartner');
      const contactMapped = contactPayload
        ? mapFields(contactPayload, contactMappings, 'contact', dynamicConfig, 'businessPartner').properties
        : null;
      const companyMapped = companyPayload
        ? mapFields(companyPayload, companyMappings, 'company', dynamicConfig, 'businessPartner').properties
        : null;
      const productMapped = lineItemsPayload.map(
        (item) => mapFields(item, productMappings, 'product', dynamicConfig, 'product').properties
      );

      return {
        properties: dealMapped.properties,
        associations: {
          contacts: normalizeAssociations(contactMapped),
          companies: normalizeAssociations(companyMapped),
          products: productMapped,
        },
      };
    } catch (error) {
      this.logger.error?.('Failed to apply deal webhook mappings:', error);
      return { properties: {}, associations: { contacts: [], companies: [], products: [] } };
    }
  }
}

export default FieldMappingService;
