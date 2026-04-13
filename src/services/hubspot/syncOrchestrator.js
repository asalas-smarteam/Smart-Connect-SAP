import hubspotAuthService from '../hubspotAuthService.js';
import * as hubspotClient from '../hubspotClient.js';
import associationRegistryService from '../associationRegistryService.js';
import associationOrchestrator from './associationOrchestrator.js';
import sapSyncAdapter from './sapSyncAdapter.js';
import contactHandler from './handlers/contact.handler.js';
import companyHandler from './handlers/company.handler.js';
import dealHandler from './handlers/deal.handler.js';
import productHandler from './handlers/product.handler.js';

const HANDLERS = {
  contact: contactHandler,
  company: companyHandler,
  deal: dealHandler,
  product: productHandler,
};

function getHandler(objectType) {
  return HANDLERS[objectType] ?? null;
}

function getSapIdForRegistry(objectType, item) {
  if (objectType === 'product') {
    return item?.properties?.hs_sku;
  }

  return item?.properties?.idsap;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryRequest(fn, retries = 5) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.response?.status ?? err?.details?.status ?? err?.cause?.response?.status;

    if (status === 429 && retries > 0) {
      const delay = 1000 * (6 - retries);
      await sleep(delay);
      return retryRequest(fn, retries - 1);
    }

    throw err;
  }
}

async function registerBaseMapping(clientConfig, objectType, sapId, hubspotId, tenantModels) {
  if (!sapId) {
    return null;
  }

  return associationRegistryService.registerBaseObjectMapping(
    clientConfig.hubspotCredentialId,
    objectType,
    sapId,
    hubspotId,
    tenantModels
  );
}

async function processSingleItem({
  getToken,
  objectType,
  item,
  clientConfig,
  tenantModels,
  handler,
}) {
  try {
    if (handler.preprocess) {
      await handler.preprocess({ item, clientConfig, tenantModels });
    }

    const token = await getToken();

    if (!item?.properties?.email && objectType !== 'product') {
      await registerBaseMapping(
        clientConfig,
        objectType,
        item?.properties?.idsap,
        '',
        tenantModels
      );

      return { ok: true };
    }

    const existing = await handler.find({ token, item, clientConfig, tenantModels });
    let created;

    if (existing) {
      await handler.update({
        token,
        id: existing.id,
        item,
        clientConfig,
        tenantModels,
      });
    } else {
      created = await handler.create({ token, item, clientConfig, tenantModels });

      await sapSyncAdapter.updateHubspotIdInSap({
        clientConfig,
        objectType,
        sapRecord: item?.properties ?? {},
        hubspotId: created?.id,
        tenantModels,
      });

      await registerBaseMapping(
        clientConfig,
        objectType,
        getSapIdForRegistry(objectType, item),
        created?.id,
        tenantModels
      );
    }

    await associationOrchestrator.handleAssociations({
      objectType,
      token,
      item,
      clientConfig,
      tenantModels,
      hubspotId: existing?.id ?? created?.id,
    });

    return { ok: true };
  } catch (error) {
    console.error('processSingleItem error:', error);
    return { ok: false };
  }
}

async function processItemsSequentially(items, context) {
  let sent = 0;
  let failed = 0;

  for (const item of items) {
    const result = await processSingleItem({
      ...context,
      item,
    });

    if (result.ok) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  return { sent, failed };
}

async function finalizeCreatedProductBatch({
  createdResults,
  createdItems,
  clientConfig,
  tenantModels,
}) {
  const itemsBySku = new Map(
    createdItems
      .map((item) => [item?.properties?.hs_sku, item])
      .filter(([sku]) => sku)
  );

  for (const [index, created] of createdResults.entries()) {
    const item = itemsBySku.get(created?.properties?.hs_sku) ?? createdItems[index];

    if (!item || !created?.id) {
      continue;
    }

    await sapSyncAdapter.updateHubspotIdInSap({
      clientConfig,
      objectType: 'product',
      sapRecord: item?.properties ?? {},
      hubspotId: created.id,
      tenantModels,
    });

    await registerBaseMapping(
      clientConfig,
      'product',
      getSapIdForRegistry('product', item),
      created.id,
      tenantModels
    );
  }
}

async function processProductBatch({
  items,
  clientConfig,
  tenantModels,
  handler,
  getToken,
}) {
  let sent = 0;
  let failed = 0;
  const createEntries = [];
  const updateEntries = [];

  // HubSpot batch read could reduce find calls further, but the current handler.find
  // contract is item-by-item. We keep that contract intact here and rely on
  // throttling/retry plus the existing batch create/update flow.
  for (const item of items) {
    try {
      if (handler.preprocess) {
        await handler.preprocess({ item, clientConfig, tenantModels });
      }

      const token = await getToken();
      const existing = await retryRequest(() =>
        handler.find({ token, item, clientConfig, tenantModels })
      );

      if (existing) {
        updateEntries.push({ existing, item });
      } else {
        createEntries.push({ item });
      }

      await sleep(200);
    } catch (error) {
      console.error('processProductBatch item error:', error);
      failed += 1;
    }
  }

  if (createEntries.length > 0) {
    try {
      const token = await getToken();
      const response = await hubspotClient.batchCreateProducts(token, {
        inputs: createEntries.map(({ item }) => item),
      });

      await finalizeCreatedProductBatch({
        createdResults: Array.isArray(response?.results) ? response.results : [],
        createdItems: createEntries.map(({ item }) => item),
        clientConfig,
        tenantModels,
      });

      sent += createEntries.length;
    } catch (error) {
      console.error('processProductBatch create error:', error);
      const fallbackResult = await processItemsSequentially(
        createEntries.map(({ item }) => item),
        {
          objectType: 'product',
          clientConfig,
          tenantModels,
          handler,
          getToken,
        }
      );

      sent += fallbackResult.sent;
      failed += fallbackResult.failed;
    }
  }

  if (updateEntries.length > 0) {
    try {
      const token = await getToken();
      await hubspotClient.batchUpdateProducts(token, {
        inputs: updateEntries.map(({ existing, item }) => ({
          id: existing.id,
          properties: item?.properties ?? {},
        })),
      });

      sent += updateEntries.length;
    } catch (error) {
      console.error('processProductBatch update error:', error);
      const fallbackResult = await processItemsSequentially(
        updateEntries.map(({ item }) => item),
        {
          objectType: 'product',
          clientConfig,
          tenantModels,
          handler,
          getToken,
        }
      );

      sent += fallbackResult.sent;
      failed += fallbackResult.failed;
    }
  }

  return { sent, failed };
}

export async function sendToHubSpot(
  mappedItems,
  clientConfig,
  objectType,
  tenantModels,
  credentials
) {
  const handler = getHandler(objectType);

  if (!handler) {
    throw new Error(`Unsupported object type: ${objectType}`);
  }

  const getToken = () => hubspotAuthService.getAccessToken(
    credentials?._id ?? clientConfig.hubspotCredentialId,
    credentials,
    tenantModels
  );

  let sent = 0;
  let failed = 0;

  if (objectType === 'product' && Number(clientConfig?.hubspotBatchSize) > 1) {
    const batchSize = Number(clientConfig?.hubspotBatchSize);

    for (let index = 0; index < mappedItems.length; index += batchSize) {
      const batch = mappedItems.slice(index, index + batchSize);
      const batchResult = await processProductBatch({
        items: batch,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });

      sent += batchResult.sent;
      failed += batchResult.failed;
    }
  } else {
    const result = await processItemsSequentially(mappedItems, {
      objectType,
      clientConfig,
      tenantModels,
      handler,
      getToken,
    });

    sent = result.sent;
    failed = result.failed;
  }

  return { ok: true, sent, failed };
}

export default {
  sendToHubSpot,
};
