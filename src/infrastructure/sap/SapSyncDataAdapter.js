import logger from '../logger/logger.adapter.js';
import spMode from './modes/spMode.js';
import scriptMode from './modes/scriptMode.js';
import apiMode from './modes/apiMode.js';
import serviceLayerService from './serviceLayer.service.js';

export class SapSyncDataAdapter {
  async fetchData({ clientConfigId, clientConfig = null, tenantContext, fetchOptions = {} }) {
    try {
      const tenantModels = tenantContext?.tenantModels;

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
          return this.fetchServiceLayerData({ config, SapCredentials, fetchOptions });
        default:
          return null;
      }
    } catch (error) {
      logger.error('Error fetching SAP data', { error });
      throw new Error(`Failed to fetch SAP data: ${error.message}`);
    }
  }

  async fetchServiceLayerData({ config, SapCredentials, fetchOptions }) {
    const sapCredentials = await SapCredentials.find().lean();

    if (!sapCredentials || sapCredentials.length === 0) {
      throw new Error('SAP credentials not found for SERVICE_LAYER mode');
    }

    const mappings = Array.isArray(fetchOptions.mappings) ? fetchOptions.mappings : [];
    const mergedConfig = {
      ...sapCredentials[0],
      ...(typeof config.toObject === 'function' ? config.toObject() : config),
    };

    return serviceLayerService.execute(mergedConfig, mappings, fetchOptions);
  }
}

export default SapSyncDataAdapter;
