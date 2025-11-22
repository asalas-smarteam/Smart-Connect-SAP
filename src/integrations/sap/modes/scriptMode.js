import sequelize from '../../../config/database.js';
import logger from '../../../core/logger.js';

const scriptMode = {
  async execute(config) {
    try {
      const { sqlQuery } = config || {};

      if (!sqlQuery) {
        return [];
      }

      const result = await sequelize.query(sqlQuery, {
        type: sequelize.QueryTypes.SELECT,
      });
      return result;
    } catch (error) {
      logger.error('Error executing SAP script mode query', { error });
      return [];
    }
  },
};

export default scriptMode;
