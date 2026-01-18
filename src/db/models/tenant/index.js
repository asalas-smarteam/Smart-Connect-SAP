import { createAssociationRegistryModel } from './AssociationRegistry.js';
import { createClientConfigModel } from './ClientConfig.js';
import { createDealOwnerMappingModel } from './DealOwnerMapping.js';
import { createDealPipelineMappingModel } from './DealPipelineMapping.js';
import { createDealStageMappingModel } from './DealStageMapping.js';
import { createFieldMappingModel } from './FieldMapping.js';
import { createHubspotCredentialsModel } from './HubspotCredentials.js';
import { createIntegrationModeModel } from './IntegrationMode.js';
import { createLogEntryModel } from './LogEntry.js';
import { createSyncLogModel } from './SyncLog.js';

export function registerTenantModels(connection) {
  if (!connection) {
    throw new Error('Tenant connection is required to register models');
  }

  return {
    AssociationRegistry: createAssociationRegistryModel(connection),
    ClientConfig: createClientConfigModel(connection),
    DealOwnerMapping: createDealOwnerMappingModel(connection),
    DealPipelineMapping: createDealPipelineMappingModel(connection),
    DealStageMapping: createDealStageMappingModel(connection),
    FieldMapping: createFieldMappingModel(connection),
    HubspotCredentials: createHubspotCredentialsModel(connection),
    IntegrationMode: createIntegrationModeModel(connection),
    LogEntry: createLogEntryModel(connection),
    SyncLog: createSyncLogModel(connection),
  };
}
