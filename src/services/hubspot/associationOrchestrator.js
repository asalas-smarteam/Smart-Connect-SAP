import HandleHubspotAssociations, {
  ASSOCIATION_MAP,
} from '../../application/use-cases/HandleHubspotAssociations.js';
import FieldMappingService from '../../application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '../../infrastructure/database/repositories/TenantFieldMappingRepository.js';
import HubspotAssociationFetchAdapter from '../../infrastructure/hubspot/HubspotAssociationFetchAdapter.js';
import associationRegistryService from '../associationRegistryService.js';
import associationService from '../associationService.js';
import contactHandler from './handlers/contact.handler.js';
import { generateFallbackEmail } from './utils/email.utils.js';

function createHandleHubspotAssociations() {
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

export async function handleAssociations({
  objectType,
  token,
  item,
  clientConfig,
  tenantModels,
  hubspotId,
}) {
  return createHandleHubspotAssociations().execute({
    objectType,
    token,
    item,
    clientConfig,
    tenantModels,
    hubspotId,
  });
}

export { ASSOCIATION_MAP };

export default {
  ASSOCIATION_MAP,
  handleAssociations,
};
