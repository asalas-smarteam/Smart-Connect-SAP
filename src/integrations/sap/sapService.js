import logger from '../../core/logger.js';
import spMode from './modes/spMode.js';
import scriptMode from './modes/scriptMode.js';
import apiMode from './modes/apiMode.js';
import mappingService from '../../services/mapping.service.js';
import serviceLayerService from '../../services/serviceLayer.service.js';

const sapService = {
  async fetchData(clientConfigId, tenantModels) {
    try {
      if (!tenantModels) {
        throw new Error('Tenant models are required to fetch SAP data');
      }

      const { ClientConfig } = tenantModels;
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
        case 'SERVICE_LAYER': {
          const mappings = await mappingService.getMappingsByObjectType(
            config.hubspotCredentialId,
            config.objectType,
            'businessPartner',
            tenantModels
          );
          return serviceLayerService.execute(config, mappings);
        }
        default:
          return null;
      }
    } catch (error) {
      logger.error('Error fetching SAP data', { error });
      return null;
    }
  },
};

export default sapService;
