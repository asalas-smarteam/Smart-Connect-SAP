import FieldMappingService from '#application/services/field-mapping.service.js';
import HandleHubspotAssociations from '#application/use-cases/HandleHubspotAssociations.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
import HubspotAssociationFetchAdapter from '#infrastructure/hubspot/HubspotAssociationFetchAdapter.js';
import associationRegistryService from '#infrastructure/hubspot/associationRegistryService.js';
import associationService from '#infrastructure/hubspot/associationService.js';
import contactHandler from '#infrastructure/hubspot/handlers/contact.handler.js';
import { generateFallbackEmail } from '#infrastructure/hubspot/utils/email.utils.js';

export function buildHandleHubspotAssociations() {
  return new HandleHubspotAssociations({
    associationFetcher: new HubspotAssociationFetchAdapter(),
    associationRegistry: associationRegistryService,
    associationService,
    fieldMappingService: new FieldMappingService({
      fieldMappingRepository: new TenantFieldMappingRepository(),
    }),
    contactHandler,
    fallbackEmailGenerator: generateFallbackEmail,
  });
}

export default buildHandleHubspotAssociations;
