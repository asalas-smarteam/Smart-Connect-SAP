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
import { createSapFilterModel } from '../../../../models/tenant/sapFilter.model.js';

async function warnLegacyOwnerMappingsCollection(connection) {
  try {
    if (!connection?.db) {
      return;
    }

    const collections = await connection.db.listCollections(
      { name: { $in: ['OwnerMappings', 'DealOwnerMappings'] } },
      { nameOnly: true }
    ).toArray();

    const hasOwnerMappings = collections.some((item) => item.name === 'OwnerMappings');
    const hasLegacyOwnerMappings = collections.some((item) => item.name === 'DealOwnerMappings');

    if (!hasLegacyOwnerMappings) {
      return;
    }

    if (!hasOwnerMappings) {
      console.warn(
        '[tenant-models] Legacy collection "DealOwnerMappings" detected. Run the OwnerMappings migration before deploying this version.'
      );
      return;
    }

    const ownerCount = await connection.db.collection('OwnerMappings').estimatedDocumentCount();

    if (ownerCount === 0) {
      console.warn(
        '[tenant-models] "OwnerMappings" is empty while legacy "DealOwnerMappings" exists. Run the OwnerMappings migration before deploying this version.'
      );
    }
  } catch (error) {
    console.warn(`[tenant-models] Unable to verify owner mapping migration status: ${error.message}`);
  }
}

export function registerTenantModels(connection) {
  if (!connection) {
    throw new Error('Tenant connection is required to register models');
  }

  void warnLegacyOwnerMappingsCollection(connection);

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
    SapFilter: createSapFilterModel(connection),
    SyncLog: createSyncLogModel(connection),
    WebhookConfig: createWebhookConfigModel(connection),
    WebhookEvent: createWebhookEventModel(connection),
  };
}
