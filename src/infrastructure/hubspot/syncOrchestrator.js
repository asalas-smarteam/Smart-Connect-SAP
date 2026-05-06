import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import SendMappedItemsToHubspot from '../../application/use-cases/SendMappedItemsToHubspot.js';
import hubspotAuthService from './hubspotAuthService.js';
import * as hubspotClient from './hubspotClient.js';
import associationRegistryService from './associationRegistryService.js';
import associationOrchestrator from './associationOrchestrator.js';
import sapSyncAdapter from './sapSyncAdapter.js';
import contactHandler from './handlers/contact.handler.js';
import companyHandler from './handlers/company.handler.js';
import dealHandler from './handlers/deal.handler.js';
import productHandler from './handlers/product.handler.js';

const validationFailuresFile = path.resolve(
  process.cwd(),
  'logs',
  'hubspot-validation-failures.txt'
);

const validationFailureWriter = {
  async write(line) {
    try {
      await mkdir(path.dirname(validationFailuresFile), { recursive: true });
      await appendFile(validationFailuresFile, line, 'utf8');
    } catch (error) {
      console.error('appendValidationFailureLine error:', error);
    }
  },
};

function createSendMappedItemsToHubspot() {
  return new SendMappedItemsToHubspot({
    tokenProvider: hubspotAuthService,
    productBatchClient: hubspotClient,
    associationRegistry: associationRegistryService,
    associationHandler: associationOrchestrator,
    sapHubspotIdUpdater: sapSyncAdapter,
    validationFailureWriter,
    handlers: {
      contact: contactHandler,
      company: companyHandler,
      deal: dealHandler,
      product: productHandler,
    },
  });
}

export async function sendToHubSpot(
  mappedItems,
  clientConfig,
  objectType,
  tenantModels,
  credentials
) {
  return createSendMappedItemsToHubspot().execute({
    mappedItems,
    clientConfig,
    objectType,
    tenantModels,
    credentials,
  });
}

export default {
  sendToHubSpot,
};
