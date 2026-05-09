import { buildSapSyncDataAdapter } from '#composition/sap-data.composition.js';

const sapService = {
  async fetchData(clientConfigId, tenantModels, fetchOptions = {}) {
    const adapter = buildSapSyncDataAdapter();
    return adapter.fetchData({ clientConfigId, tenantModels, fetchOptions });
  },
};

export default sapService;
