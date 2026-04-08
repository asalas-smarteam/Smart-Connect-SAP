import hubspotAuthService from '../hubspotAuthService.js';
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
  token,
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

export async function sendToHubSpot(
  mappedItems,
  clientConfig,
  objectType,
  tenantModels,
  credentials
) {
  const token = await hubspotAuthService.getAccessToken(
    clientConfig.hubspotCredentialId,
    credentials,
    tenantModels
  );
  const handler = getHandler(objectType);

  if (!handler) {
    throw new Error(`Unsupported object type: ${objectType}`);
  }

  let sent = 0;
  let failed = 0;

  for (const item of mappedItems) {
    const result = await processSingleItem({
      token,
      objectType,
      item,
      clientConfig,
      tenantModels,
      handler,
    });

    if (result.ok) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  return { ok: true, sent, failed };
}

export default {
  sendToHubSpot,
};
