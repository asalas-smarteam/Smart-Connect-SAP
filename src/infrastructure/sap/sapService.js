import SapSyncDataAdapter from './SapSyncDataAdapter.js';

const sapService = {
  async fetchData(clientConfigId, tenantModels, fetchOptions = {}) {
    const adapter = new SapSyncDataAdapter();
    return adapter.fetchData({ clientConfigId, tenantModels, fetchOptions });
  },
};

export default sapService;

