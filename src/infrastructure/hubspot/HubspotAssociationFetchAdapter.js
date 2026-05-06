import axios from 'axios';
import { getConnection } from '../database/externalDb.js';

export class HubspotAssociationFetchAdapter {
  async fetch({ config, clientConfig }) {
    const fetchType = config?.associationFetchType;
    const fetchConfig = config?.associationFetchConfig;

    if (!fetchType || !fetchConfig) {
      return {};
    }

    if (fetchType === 'api') {
      const response = await axios({
        method: fetchConfig.method || 'GET',
        url: fetchConfig.url,
      });

      return response?.data ?? response;
    }

    if (fetchType === 'sp') {
      const storedProcedure =
        fetchConfig.storedProcedure || fetchConfig.storeProcedureName;

      if (!storedProcedure) {
        return {};
      }

      const externalSequelize = getConnection(clientConfig);
      const [results] = await externalSequelize.query(`EXEC ${storedProcedure}`);

      return results ?? {};
    }

    return {};
  }
}

export default HubspotAssociationFetchAdapter;
