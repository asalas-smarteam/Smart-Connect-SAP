import { getConnection } from '../database/externalDb.js';
import sapBusinessPartnerAdapter from './sap-business-partner.adapter.js';

function getTenantFieldMapping(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for SAP update operations');
  }
  return tenantModels.FieldMapping;
}

function toPlainObject(value) {
  return typeof value?.toObject === 'function' ? value.toObject() : value;
}

async function resolveQuery(query) {
  if (typeof query?.lean === 'function') {
    return query.lean();
  }

  return query;
}

async function getActiveMappings({ tenantModels, clientConfig, objectType }) {
  const FieldMapping = getTenantFieldMapping(tenantModels);
  const mappings = await resolveQuery(FieldMapping.find({
    objectType,
    hubspotCredentialId: clientConfig?.hubspotCredentialId,
    isActive: true,
  }));

  return Array.isArray(mappings) ? mappings.map(toPlainObject) : [];
}

function normalizeText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function resolveSapId({ item, existing, mappings }) {
  const properties = item?.properties ?? {};
  const hubspotProperties = existing?.properties ?? {};
  const sapIdSource = mappings.find((mapping) =>
    ['idsap', 'idSap'].includes(mapping?.targetField)
  )?.sourceField;

  return normalizeText(
    properties?.idsap
      ?? properties?.idSap
      ?? hubspotProperties?.idsap
      ?? hubspotProperties?.idSap
      ?? (sapIdSource ? item?.rawSapData?.[sapIdSource] : null)
  );
}

function isSqlIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ''));
}

function shouldSkipReverseMapping(mapping) {
  return (
    !mapping?.sourceField
    || !mapping?.targetField
    || String(mapping.sourceField).includes('.')
    || ['idsap', 'idSap', 'hs_object_id'].includes(mapping.targetField)
  );
}

function buildSapPayloadFromHubspot({ hubspotProperties, mappings }) {
  return mappings.reduce((payload, mapping) => {
    if (shouldSkipReverseMapping(mapping)) {
      return payload;
    }

    if (!Object.prototype.hasOwnProperty.call(hubspotProperties, mapping.targetField)) {
      return payload;
    }

    const value = hubspotProperties[mapping.targetField];
    if (value === null || typeof value === 'undefined' || value === '') {
      return payload;
    }

    return {
      ...payload,
      [mapping.sourceField]: value,
    };
  }, {});
}

async function buildServiceLayerConfig(clientConfig, tenantModels) {
  const config = toPlainObject(clientConfig) ?? {};
  const query = tenantModels?.SapCredentials?.find?.();
  const credentials = query ? await resolveQuery(query) : [];
  const sapCredentials = Array.isArray(credentials) ? credentials[0] : credentials;

  return {
    ...(toPlainObject(sapCredentials) ?? {}),
    ...config,
  };
}

async function updateBusinessPartnerWithScript({ clientConfig, mappings, sapId, payload }) {
  const sapIdSource = mappings.find((mapping) =>
    ['idsap', 'idSap'].includes(mapping?.targetField)
  )?.sourceField;
  const entries = Object.entries(payload)
    .filter(([field]) => isSqlIdentifier(field));

  if (
    clientConfig?.updateMethod !== 'script'
    || !clientConfig?.updateTableName
    || !isSqlIdentifier(clientConfig.updateTableName)
    || !isSqlIdentifier(sapIdSource)
    || entries.length === 0
  ) {
    return null;
  }

  const replacements = { idSap: sapId };
  const assignments = entries.map(([field, value], index) => {
    const key = `field${index}`;
    replacements[key] = value;
    return `${field} = :${key}`;
  });

  const connection = getConnection(clientConfig);
  const query = `UPDATE ${clientConfig.updateTableName} SET ${assignments.join(', ')} WHERE ${sapIdSource} = :idSap`;

  await connection.query(query, { replacements });
  return { updated: true, method: 'script' };
}

async function updateBusinessPartnerWithServiceLayer({ clientConfig, tenantModels, sapId, payload }) {
  const sapConfig = await buildServiceLayerConfig(clientConfig, tenantModels);

  if (!sapConfig?.serviceLayerBaseUrl || Object.keys(payload).length === 0) {
    return null;
  }

  await sapBusinessPartnerAdapter.updateBusinessPartner({
    sapConfig,
    cardCode: sapId,
    payload,
  });

  return { updated: true, method: 'serviceLayer' };
}

export const sapUpdateService = {
  async updateHubspotIdInSap(clientConfig, objectType, sapRecord, hubspotId, tenantModels) {
    try {
      if (!clientConfig?.requireUpdateHubspotID) {
        return;
      }

      const FieldMapping = getTenantFieldMapping(tenantModels);
      const mapping = await FieldMapping.find({
        objectType,
        hubspotCredentialId: clientConfig?.hubspotCredentialId,
      }).lean();

      const hsObjectIdSource = mapping.find(m => m.targetField === "hs_object_id")?.sourceField;
      const sapIdSource = mapping.find(m => m.targetField === "idsap")?.sourceField;

      const idSap = sapRecord?.idsap;

      if (!idSap) {
        return;
      }

      const connection = getConnection(clientConfig);

      if (clientConfig.updateMethod === 'sp' && clientConfig.updateSpName) {
        const query = `EXEC ${clientConfig.updateSpName} @idSap=:idSap, @idHubspot=:idHubspot`;
        await connection.query(query, {
          replacements: { idSap, idHubspot: hubspotId },
        });
        return;
      }

      if (clientConfig.updateMethod === 'script' && clientConfig.updateTableName) {
        const query = `UPDATE ${clientConfig.updateTableName} SET ${hsObjectIdSource} = :hubspotId WHERE ${sapIdSource} = :idSap`;
        await connection.query(query, { replacements: { hubspotId, idSap } });
      }
    } catch (error) {
      console.error('Failed to update HubSpot ID in SAP', error);
    }
  },

  async updateBusinessPartnerInSapFromHubspot(clientConfig, objectType, item, existing, tenantModels) {
    try {
      if (!['contact', 'company'].includes(objectType)) {
        return null;
      }

      const mappings = await getActiveMappings({ tenantModels, clientConfig, objectType });
      const sapId = resolveSapId({ item, existing, mappings });
      const payload = buildSapPayloadFromHubspot({
        hubspotProperties: existing?.properties ?? {},
        mappings,
      });

      if (!sapId || Object.keys(payload).length === 0) {
        return null;
      }

      const scriptResult = await updateBusinessPartnerWithScript({
        clientConfig,
        mappings,
        sapId,
        payload,
      });

      if (scriptResult) {
        return scriptResult;
      }

      return updateBusinessPartnerWithServiceLayer({
        clientConfig,
        tenantModels,
        sapId,
        payload,
      });
    } catch (error) {
      console.error('Failed to update SAP BusinessPartner from HubSpot', error);
      return null;
    }
  },
};
