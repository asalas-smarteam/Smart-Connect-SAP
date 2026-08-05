import SyncDropdownOptionsToHubspot from '#application/use-cases/SyncDropdownOptionsToHubspot.js';
import { ClientConfigRepositoryPort } from '#application/ports/database/client-config-repository.port.js';
import { DropdownOptionsConfigPort } from '#application/ports/database/dropdown-options-config.port.js';
import { DropdownTargetRepositoryPort } from '#application/ports/database/dropdown-target-repository.port.js';
import { SyncLogRepositoryPort } from '#application/ports/database/sync-log-repository.port.js';
import { SyncWarningRepositoryPort } from '#application/ports/database/sync-warning-repository.port.js';
import { HubspotCredentialRepositoryPort } from '#application/ports/hubspot/hubspot-credential-repository.port.js';
import { HubspotPropertyPort } from '#application/ports/hubspot/hubspot-property.port.js';
import { SapDropdownCatalogPort } from '#application/ports/sap/sap-dropdown-catalog.port.js';
import { assertPort } from '#application/ports/port-validator.js';
import DropdownOptionsConfigRepository from '#infrastructure/config/DropdownOptionsConfigRepository.js';
import SapFlavorConfigRepository from '#infrastructure/config/SapFlavorConfigRepository.js';
import MongooseClientConfigRepository from '#infrastructure/database/repositories/MongooseClientConfigRepository.js';
import MongooseDropdownTargetRepository from '#infrastructure/database/repositories/MongooseDropdownTargetRepository.js';
import MongooseHubspotCredentialRepository from '#infrastructure/database/repositories/MongooseHubspotCredentialRepository.js';
import MongooseSyncLogRepository from '#infrastructure/database/repositories/MongooseSyncLogRepository.js';
import MongooseSyncWarningRepository from '#infrastructure/database/repositories/MongooseSyncWarningRepository.js';
import HubspotPropertyAdapter from '#infrastructure/hubspot/HubspotPropertyAdapter.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import B1DropdownCatalogAdapter from '#infrastructure/sap/B1DropdownCatalogAdapter.js';

export function buildSyncDropdownOptionsToHubspot() {
  return new SyncDropdownOptionsToHubspot({
    dropdownConfigRepository: assertPort(
      new DropdownOptionsConfigRepository(),
      DropdownOptionsConfigPort
    ),
    dropdownCatalog: assertPort(new B1DropdownCatalogAdapter(), SapDropdownCatalogPort),
    dropdownTargetRepository: assertPort(
      new MongooseDropdownTargetRepository(),
      DropdownTargetRepositoryPort
    ),
    hubspotPropertyGateway: assertPort(new HubspotPropertyAdapter(), HubspotPropertyPort),
    hubspotCredentialRepository: assertPort(
      new MongooseHubspotCredentialRepository(),
      HubspotCredentialRepositoryPort
    ),
    clientConfigRepository: assertPort(
      new MongooseClientConfigRepository(),
      ClientConfigRepositoryPort
    ),
    syncLogRepository: assertPort(new MongooseSyncLogRepository(), SyncLogRepositoryPort),
    syncWarningRepository: assertPort(
      new MongooseSyncWarningRepository(),
      SyncWarningRepositoryPort
    ),
    sapFlavorRepository: new SapFlavorConfigRepository(),
    logger,
  });
}

export default buildSyncDropdownOptionsToHubspot;
