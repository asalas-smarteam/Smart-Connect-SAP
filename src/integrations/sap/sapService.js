import { ClientConfig, IntegrationMode } from '../../config/database.js';
import logger from '../../core/logger.js';
import spMode from './modes/spMode.js';
import scriptMode from './modes/scriptMode.js';
import apiMode from './modes/apiMode.js';

const sapService = {
  async fetchData(clientConfigId) {
    try {
      const config = await ClientConfig.findByPk(clientConfigId, {
        include: [
          {
            model: IntegrationMode,
            attributes: ['name'],
          },
        ],
      });

      if (!config) {
        return null;
      }

      switch (config?.IntegrationMode?.name) {
        case 'STORE_PROCEDURE':
          return spMode.execute(config);
        case 'SQL_SCRIPT':
          return scriptMode.execute(config);
        case 'API':
          return apiMode.execute(config);
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
