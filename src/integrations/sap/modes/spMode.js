import createExternalConnection from '../../../utils/externalDb.js';
import logger from '../../../core/logger.js';

const spMode = {
  async execute(config) {
    let externalSequelize;

    try {
      const { storeProcedureName } = config || {};

      if (!storeProcedureName) {
        return [];
      }

      externalSequelize = createExternalConnection(config);
      const result = await externalSequelize.query(`EXEC ${storeProcedureName}`);
      await externalSequelize.close();
      return result;
    } catch (error) {
      logger.error('Error executing SAP stored procedure', { error });

      if (externalSequelize) {
        try {
          await externalSequelize.close();
        } catch (closeError) {
          logger.error('Error closing external database connection', { closeError });
        }
      }

      return [];
    }
  },
};

export default spMode;
