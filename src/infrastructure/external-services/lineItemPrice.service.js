import SyncLineItemPrices from '../../application/use-cases/SyncLineItemPrices.js';
import HubspotLineItemPriceClient from './HubspotLineItemPriceClient.js';
import SapLineItemPriceClient from './SapLineItemPriceClient.js';
import TenantLineItemPriceConfigRepository from '../repositories/TenantLineItemPriceConfigRepository.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from '../sync/syncLog.service.js';

function createSyncLineItemPricesUseCase() {
  return new SyncLineItemPrices({
    credentialRepository: new TenantLineItemPriceConfigRepository(),
    sapPriceClient: new SapLineItemPriceClient(),
    hubspotPriceClient: new HubspotLineItemPriceClient(),
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
  });
}

const lineItemPriceService = {
  async syncPrices(payload, context) {
    const syncLineItemPrices = createSyncLineItemPricesUseCase();
    return syncLineItemPrices.execute(payload, context);
  },
};

export default lineItemPriceService;
