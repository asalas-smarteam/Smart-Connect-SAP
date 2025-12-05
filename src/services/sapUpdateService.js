import { DataTypes } from 'sequelize';
import { getConnection } from '../utils/externalDb.js';
import FieldMapping from '../db/models/FieldMapping.js';
import { sequelize } from '../config/database.js';

const FieldMappingModel =
  sequelize.models.FieldMapping || FieldMapping({ sequelize }, DataTypes);

export const sapUpdateService = {
  async updateHubspotIdInSap(clientConfig, objectType, sapRecord, hubspotId) {
    try {
      if (!clientConfig?.requireUpdateHubspotID) {
        return;
      }

      const mapping = await FieldMappingModel.findOne({
        where: {
          objectType,
          hubspotCredentialId: clientConfig?.hubspotCredentialId,
          targetField: 'id_sap',
        },
      });

      const sapIdField = mapping?.sourceField;
      const idSap = sapIdField ? sapRecord?.[sapIdField] : undefined;

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
        const query = `UPDATE ${clientConfig.updateTableName} SET id_hubspot = :hubspotId WHERE id_sap = :idSap`;
        await connection.query(query, { replacements: { hubspotId, idSap } });
      }
    } catch (error) {
      console.error('Failed to update HubSpot ID in SAP', error);
    }
  },
};

