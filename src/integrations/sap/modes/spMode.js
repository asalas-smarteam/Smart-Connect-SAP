import { getConnection } from '../../../utils/externalDb.js';
import logger from '../../../core/logger.js';

const spMode = {
  async execute(config) {
    try {
      const { storeProcedureName } = config || {};

      if (!storeProcedureName) {
        return [];
      }

      const externalSequelize = getConnection(config);
      const result = await externalSequelize.query(`EXEC ${storeProcedureName}`);
      return result;
    } catch (error) {
      logger.error('Error executing SAP stored procedure', { error });
      return [];
    }
  },
};

export default spMode;
