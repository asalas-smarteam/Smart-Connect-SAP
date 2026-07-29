import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import SendMappedItemsToHubspot from '#application/use-cases/SendMappedItemsToHubspot.js';
import ProcessCrmObjectBatches from '#application/use-cases/ProcessCrmObjectBatches.js';
import SyncCompanyContactsInBatches from '#application/use-cases/SyncCompanyContactsInBatches.js';
import FieldMappingService from '#application/services/field-mapping.service.js';
import hubspotCrmBatchAdapter from '#infrastructure/hubspot/hubspot-crm-batch.adapter.js';
import { getConfiguredFindProperty } from '#infrastructure/hubspot/handlers/utils/searchCriteria.utils.js';
import { generateFallbackEmail } from '#infrastructure/hubspot/utils/email.utils.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
import BypassEmailConfigRepository from '#infrastructure/config/BypassEmailConfigRepository.js';
import MongooseSyncWarningRepository from '#infrastructure/database/repositories/MongooseSyncWarningRepository.js';
import MainDataInUpdateConfigRepository from '#infrastructure/config/MainDataInUpdateConfigRepository.js';
import associationRegistryService from '#infrastructure/hubspot/associationRegistryService.js';
import companyHandler from '#infrastructure/hubspot/handlers/company.handler.js';
import contactHandler from '#infrastructure/hubspot/handlers/contact.handler.js';
import dealHandler from '#infrastructure/hubspot/handlers/deal.handler.js';
import invoiceHandler from '#infrastructure/hubspot/handlers/invoice.handler.js';
import productHandler from '#infrastructure/hubspot/handlers/product.handler.js';
import hubspotAuthService from '#infrastructure/hubspot/hubspotAuthService.js';
import * as hubspotClient from '#infrastructure/hubspot/hubspotClient.js';
import sapSyncAdapter from '#infrastructure/hubspot/sapSyncAdapter.js';
import logger from '#infrastructure/logger/logger.js';
import { buildHandleHubspotAssociations } from './hubspot-associations.composition.js';

const validationFailuresFile = path.resolve(
  process.cwd(),
  'logs',
  'hubspot-validation-failures.txt'
);

export const validationFailureWriter = {
  async write(line) {
    try {
      await mkdir(path.dirname(validationFailuresFile), { recursive: true });
      await appendFile(validationFailuresFile, line, 'utf8');
    } catch (error) {
      console.error('appendValidationFailureLine error:', error);
    }
  },
};

export function buildSendMappedItemsToHubspot() {
  const handleHubspotAssociations = buildHandleHubspotAssociations();

  const findPropertyResolver = ({ tenantModels }) => getConfiguredFindProperty({ tenantModels });

  const syncCompanyContactsInBatches = new SyncCompanyContactsInBatches({
    crmBatchClient: hubspotCrmBatchAdapter,
    contactHandler,
    associationRegistry: associationRegistryService,
    fieldMappingService: new FieldMappingService({
      fieldMappingRepository: new TenantFieldMappingRepository(),
    }),
    fallbackEmailGenerator: generateFallbackEmail,
    findPropertyResolver,
    bypassEmailConfigRepository: new BypassEmailConfigRepository(),
    syncWarningRepository: new MongooseSyncWarningRepository(),
    logger,
  });

  const crmBatchProcessor = new ProcessCrmObjectBatches({
    crmBatchClient: hubspotCrmBatchAdapter,
    associationRegistry: associationRegistryService,
    sapHubspotIdUpdater: sapSyncAdapter,
    validationFailureWriter,
    findPropertyResolver,
    fetchFallbackAssociations: ({ clientConfig, objectType }) =>
      handleHubspotAssociations.fetchAssociationsIfNeeded(clientConfig, objectType),
    syncCompanyContactsInBatches,
    syncWarningRepository: new MongooseSyncWarningRepository(),
    logger,
  });

  return new SendMappedItemsToHubspot({
    tokenProvider: hubspotAuthService,
    productBatchClient: hubspotClient,
    associationRegistry: associationRegistryService,
    associationHandler: {
      handleAssociations: (input) => handleHubspotAssociations.execute(input),
    },
    sapHubspotIdUpdater: sapSyncAdapter,
    validationFailureWriter,
    crmBatchProcessor,
    mainDataInUpdateConfigRepository: new MainDataInUpdateConfigRepository(),
    bypassEmailConfigRepository: new BypassEmailConfigRepository(),
    syncWarningRepository: new MongooseSyncWarningRepository(),
    logger,
    handlers: {
      contact: contactHandler,
      company: companyHandler,
      deal: dealHandler,
      product: productHandler,
      invoice: invoiceHandler,
    },
  });
}

export default buildSendMappedItemsToHubspot;
