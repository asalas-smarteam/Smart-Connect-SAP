import axios from 'axios';
import logger from '../../../core/logger.js';

const apiMode = {
  async execute(config) {
    try {
      const { apiUrl, apiToken } = config || {};

      if (!apiUrl) {
        return [];
      }

      const headers = {};

      if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
      }

      const response = await axios.get(apiUrl, { headers });
      return response.data;
    } catch (error) {
      logger.error('Error executing SAP API mode request', { error });
      return [];
    }
  },
};

export default apiMode;
