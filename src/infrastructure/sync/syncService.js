import SyncSapConfigToHubspot from '../../application/use-cases/SyncSapConfigToHubspot.js';
import MongooseSyncLogRepository from '../database/repositories/MongooseSyncLogRepository.js';
import MappingSyncRepository from '../repositories/MappingSyncRepository.js';
import HubspotSyncAdapter from '../hubspot/HubspotSyncAdapter.js';
import SapSyncDataAdapter from '../sap/SapSyncDataAdapter.js';

function createSyncSapConfigToHubspotUseCase() {
  return new SyncSapConfigToHubspot({
    sapDataSource: new SapSyncDataAdapter(),
    mappingRepository: new MappingSyncRepository(),
    hubspotSyncTarget: new HubspotSyncAdapter(),
    syncLogRepository: new MongooseSyncLogRepository(),
  });
}

const syncService = {
  async run(config, tenantModels) {
    const useCase = createSyncSapConfigToHubspotUseCase();
    return useCase.execute({ config, tenantModels });
  },
};

export default syncService;

