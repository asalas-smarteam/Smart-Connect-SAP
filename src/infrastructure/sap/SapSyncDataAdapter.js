import logger from '../logger/logger.adapter.js';
import spMode from './modes/spMode.js';
import scriptMode from './modes/scriptMode.js';
import apiMode from './modes/apiMode.js';
import mappingService from '../database/repositories/mapping.service.js';
import serviceLayerService from './serviceLayer.service.js';
import { ensureDefaultProductMappings } from '#application/services/defaultClientConfigMappings.service.js';

export class SapSyncDataAdapter {
  async fetchData({ clientConfigId, tenantModels, fetchOptions = {} }) {
    try {
      if (!tenantModels) {
        throw new Error('Tenant models are required to fetch SAP data');
      }

      const { ClientConfig, SapCredentials } = tenantModels;
      const config = await ClientConfig.findById(clientConfigId).populate({
        path: 'integrationModeId',
        select: 'name',
      });

      if (!config) {
        return null;
      }

      switch (config?.integrationModeId?.name) {
        case 'STORE_PROCEDURE':
          return spMode.execute(config);
        case 'SQL_SCRIPT':
          return scriptMode.execute(config);
        case 'API':
          return apiMode.execute(config);
        case 'SERVICE_LAYER':
          return this.fetchServiceLayerData({ config, tenantModels, SapCredentials, fetchOptions });
        default:
          return null;
      }
    } catch (error) {
      logger.error('Error fetching SAP data', { error });
      return null;
    }
  }

  async fetchServiceLayerData({ config, tenantModels, SapCredentials, fetchOptions }) {
    const sapCredentials = await SapCredentials.find().lean();

    if (!sapCredentials || sapCredentials.length === 0) {
      throw new Error('SAP credentials not found for SERVICE_LAYER mode');
    }

    if (config.objectType === 'product') {
      await ensureDefaultProductMappings({
        FieldMapping: tenantModels.FieldMapping,
        clientConfig: config,
      });
    }

    const mappings = await mappingService.getMappingsByObjectType(
      config.hubspotCredentialId,
      config.objectType,
      'businessPartner',
      tenantModels
    );
    const mergedConfig = {
      ...sapCredentials[0],
      ...config.toObject(),
    };

    return serviceLayerService.execute(mergedConfig, mappings, fetchOptions);
  }
}

export default SapSyncDataAdapter;

