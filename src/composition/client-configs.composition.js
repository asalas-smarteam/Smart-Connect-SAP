import ManageClientConfigs from '#application/use-cases/ManageClientConfigs.js';
import logger from '#infrastructure/logger/logger.js';
import * as filterPolicy from '#infrastructure/config/ClientConfigFilterPolicyAdapter.js';
import DefaultClientConfigMappingInitializer from '#infrastructure/config/DefaultClientConfigMappingInitializer.js';
import SapFlavorConfigRepository from '#infrastructure/config/SapFlavorConfigRepository.js';
import TenantClientConfigRepository from '#infrastructure/database/repositories/TenantClientConfigRepository.js';
import * as scheduler from '#infrastructure/scheduler/SapSyncSchedulerAdapter.js';

export function buildManageClientConfigs() {
  return new ManageClientConfigs({
    clientConfigRepository: new TenantClientConfigRepository(),
    filterPolicy,
    defaultMappingInitializer: new DefaultClientConfigMappingInitializer(),
    scheduler,
    sapFlavorRepository: new SapFlavorConfigRepository(),
    logger,
  });
}

export default buildManageClientConfigs;
