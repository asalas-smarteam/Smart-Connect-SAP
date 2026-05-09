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

function resolveValueByPath(inputData, sourceField) {
  if (!sourceField) {
    return null;
  }

  const pathParts = String(sourceField)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (pathParts.length === 0) {
    return null;
  }

  let currentValue = inputData;

  for (const segment of pathParts) {
    if (currentValue === null || typeof currentValue === 'undefined') {
      return null;
    }

    if (Array.isArray(currentValue)) {
      currentValue = currentValue[0];
      if (currentValue === null || typeof currentValue === 'undefined') {
        return null;
      }
    }

    currentValue = currentValue?.[segment];
  }

  if (Array.isArray(currentValue)) {
    return currentValue[0] ?? null;
  }

  return currentValue ?? null;
}

function mapFields(inputData, mappings, objectType) {
  const result = {};
  const resolvedInput = inputData ?? {};

  mappings
    .filter((mapping) => mapping.isActive ?? true)
    .forEach((mapping) => {
      result[mapping.targetField] = resolveValueByPath(resolvedInput, mapping.sourceField);
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
  constructor({ fieldMappingRepository, logger = console }) {
    this.fieldMappingRepository = fieldMappingRepository;
    this.logger = logger;
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

      return records.map((record) => mapFields(record, mappings, objectType));
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
      const mappings = await this.getMappings(
        hubspotCredentialId,
        objectType,
        tenantModels,
        sourceContext
      );

      return mapFields(inputData, mappings, objectType);
    } catch (error) {
      this.logger.error?.('Failed to apply mappings:', error);
      return {};
    }
  }

  async applyDealWebhookMapping(payload, hubspotCredentialId, tenantModels) {
    try {
      const [dealMappings, contactMappings, companyMappings, productMappings] = await Promise.all([
        this.getMappings(hubspotCredentialId, 'deal', tenantModels),
        this.getMappings(hubspotCredentialId, 'contact', tenantModels),
        this.getMappings(hubspotCredentialId, 'company', tenantModels),
        this.getMappings(hubspotCredentialId, 'product', tenantModels),
      ]);

      const dealPayload = payload?.deal ?? null;
      const contactPayload = payload?.contact ?? null;
      const companyPayload = payload?.company ?? null;
      const lineItemsPayload = normalizeAssociations(payload?.line_items ?? []);

      const dealMapped = mapFields(dealPayload, dealMappings, 'deal');
      const contactMapped = contactPayload
        ? mapFields(contactPayload, contactMappings, 'contact').properties
        : null;
      const companyMapped = companyPayload
        ? mapFields(companyPayload, companyMappings, 'company').properties
        : null;
      const productMapped = lineItemsPayload.map(
        (item) => mapFields(item, productMappings, 'product').properties
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
