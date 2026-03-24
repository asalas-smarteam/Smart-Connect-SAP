import { createAssociationRegistryModel } from './AssociationRegistry.js';
import { createClientConfigModel } from './ClientConfig.js';
import { createOwnerMappingModel } from './OwnerMapping.js';
import { createDealPipelineMappingModel } from './DealPipelineMapping.js';
import { createDealStageMappingModel } from './DealStageMapping.js';
import { createFieldMappingModel } from './FieldMapping.js';
import { createHubspotCredentialsModel } from './HubspotCredentials.js';
import { createIntegrationModeModel } from './IntegrationMode.js';
import { createLogEntryModel } from './LogEntry.js';
import { createSyncLogModel } from './SyncLog.js';
import { createWebhookConfigModel } from './WebhookConfig.js';
import { createWebhookEventModel } from './WebhookEvent.js';
import { createSapCredentialsModel } from './SapCredentials.js';
import { createSapFilterModel } from '../../../../models/tenant/sapFilter.model.js';

export function registerTenantModels(connection) {
  if (!connection) {
    throw new Error('Tenant connection is required to register models');
  }

  return {
    AssociationRegistry: createAssociationRegistryModel(connection),
    ClientConfig: createClientConfigModel(connection),
    OwnerMapping: createOwnerMappingModel(connection),
    DealPipelineMapping: createDealPipelineMappingModel(connection),
    DealStageMapping: createDealStageMappingModel(connection),
    FieldMapping: createFieldMappingModel(connection),
    HubspotCredentials: createHubspotCredentialsModel(connection),
    IntegrationMode: createIntegrationModeModel(connection),
    LogEntry: createLogEntryModel(connection),
    SapCredentials: createSapCredentialsModel(connection),
    SapFilter: createSapFilterModel(connection),
    SyncLog: createSyncLogModel(connection),
    WebhookConfig: createWebhookConfigModel(connection),
    WebhookEvent: createWebhookEventModel(connection),
  };
}
