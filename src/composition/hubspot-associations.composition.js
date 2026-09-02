import { SyncWarningRepositoryPort } from '#application/ports/database/sync-warning-repository.port.js';
import { assertPort } from '#application/ports/port-validator.js';
import FieldMappingService from '#application/services/field-mapping.service.js';
import HandleHubspotAssociations from '#application/use-cases/HandleHubspotAssociations.js';
import BypassEmailConfigRepository from '#infrastructure/config/BypassEmailConfigRepository.js';
import MongooseSyncWarningRepository from '#infrastructure/database/repositories/MongooseSyncWarningRepository.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
import DynamicDescriptionConfigRepository from '#infrastructure/config/DynamicDescriptionConfigRepository.js';
import PhoneNormalizationConfigRepository from '#infrastructure/config/PhoneNormalizationConfigRepository.js';
import HubspotAssociationFetchAdapter from '#infrastructure/hubspot/HubspotAssociationFetchAdapter.js';
import associationRegistryService from '#infrastructure/hubspot/associationRegistryService.js';
import associationService from '#infrastructure/hubspot/associationService.js';
import contactHandler from '#infrastructure/hubspot/handlers/contact.handler.js';
import { generateFallbackEmail } from '#infrastructure/hubspot/utils/email.utils.js';
import logger from '#infrastructure/logger/logger.js';

export function buildHandleHubspotAssociations() {
  return new HandleHubspotAssociations({
    associationFetcher: new HubspotAssociationFetchAdapter(),
    associationRegistry: associationRegistryService,
    associationService,
    fieldMappingService: new FieldMappingService({
      fieldMappingRepository: new TenantFieldMappingRepository(),
      dynamicDescriptionConfigRepository: new DynamicDescriptionConfigRepository(),
      phoneNormalizationConfigRepository: new PhoneNormalizationConfigRepository(),
    }),
    contactHandler,
    fallbackEmailGenerator: generateFallbackEmail,
    bypassEmailConfigRepository: new BypassEmailConfigRepository(),
    syncWarningRepository: assertPort(
      new MongooseSyncWarningRepository(),
      SyncWarningRepositoryPort
    ),
    logger,
  });
}

export default buildHandleHubspotAssociations;
