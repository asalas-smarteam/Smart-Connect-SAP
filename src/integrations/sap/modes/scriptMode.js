import logger from '../../../core/logger.js';
import { getConnection } from '../../../utils/externalDb.js';

const scriptMode = {
  async execute(config) {
    try {
      if (!config?.sqlQuery) {
        return [];
      }

      const externalSequelize = getConnection(config);

      const result = await externalSequelize.query(config.sqlQuery, {
        type: externalSequelize.QueryTypes.SELECT,
      });

      return result;
    } catch (error) {
      logger.error('Error executing SAP script mode query', { error });
      return [];
    }
  },
};

export default scriptMode;
