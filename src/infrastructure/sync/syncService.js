import { buildSyncSapConfigToHubspot } from '#composition/sap-sync.composition.js';

const syncService = {
  async run(config, tenantModels) {
    const useCase = buildSyncSapConfigToHubspot();
    return useCase.execute({ config, tenantModels });
  },
};

export default syncService;
