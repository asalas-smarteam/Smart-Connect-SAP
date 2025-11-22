import sequelize from '../../../config/database.js';
import logger from '../../../core/logger.js';

const spMode = {
  async execute(config) {
    try {
      const { storeProcedureName } = config || {};

      if (!storeProcedureName) {
        return [];
      }

      const result = await sequelize.query(`CALL ${storeProcedureName}()`);
      return result;
    } catch (error) {
      logger.error('Error executing SAP stored procedure', { error });
      return [];
    }
  },
};

export default spMode;
