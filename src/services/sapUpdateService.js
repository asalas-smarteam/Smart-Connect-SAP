import { getConnection } from '../utils/externalDb.js';

function getTenantFieldMapping(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for SAP update operations');
  }
  return tenantModels.FieldMapping;
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
};
