function getHandler(handlers, objectType) {
  return handlers[objectType] ?? null;
}

function getSapIdForRegistry(objectType, item) {
  if (objectType === 'product') {
    return item?.properties?.hs_sku;
  }

  return item?.properties?.idsap;
}

function getValidationFailureIdentifier(objectType, item) {
  if (objectType === 'product') {
    return item?.properties?.idsap ?? item?.properties?.hs_sku ?? '';
  }

  return item?.properties?.idsap ?? '';
}

export class SendMappedItemsToHubspot {
  constructor({
    tokenProvider,
    productBatchClient,
    associationRegistry,
    associationHandler,
    sapHubspotIdUpdater,
    handlers,
    validationFailureWriter,
    sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.tokenProvider = tokenProvider;
    this.productBatchClient = productBatchClient;
    this.associationRegistry = associationRegistry;
    this.associationHandler = associationHandler;
    this.sapHubspotIdUpdater = sapHubspotIdUpdater;
    this.handlers = handlers;
    this.validationFailureWriter = validationFailureWriter;
    this.sleeper = sleeper;
  }

  async execute({ mappedItems, clientConfig, objectType, tenantModels, credentials }) {
    const handler = getHandler(this.handlers, objectType);

    if (!handler) {
      throw new Error(`Unsupported object type: ${objectType}`);
    }

    const getToken = () => this.tokenProvider.getAccessToken(
      credentials?._id ?? clientConfig.hubspotCredentialId,
      credentials,
      tenantModels
    );

    if (objectType === 'product' && Number(clientConfig?.hubspotBatchSize) > 1) {
      return this.processProductBatches({
        mappedItems,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });
    }

    const result = await this.processItemsSequentially(mappedItems, {
      objectType,
      clientConfig,
      tenantModels,
      handler,
      getToken,
    });

    return { ok: true, ...result };
  }

  async retryRequest(fn, retries = 5) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status ?? err?.details?.status ?? err?.cause?.response?.status;

      if (status === 429 && retries > 0) {
        const delay = 1000 * (6 - retries);
        await this.sleeper(delay);
        return this.retryRequest(fn, retries - 1);
      }

      throw err;
    }
  }

  async registerBaseMapping(clientConfig, objectType, sapId, hubspotId, tenantModels) {
    if (!sapId) {
      return null;
    }

    return this.associationRegistry.registerBaseObjectMapping(
      clientConfig.hubspotCredentialId,
      objectType,
      sapId,
      hubspotId,
      tenantModels
    );
  }

  async writeValidationFailure(objectType, item) {
    const identifier = String(getValidationFailureIdentifier(objectType, item) ?? '').trim();
    const email = String(item?.properties?.email ?? '').trim();
    const line = objectType === 'product'
      ? `${identifier}\n`
      : `${identifier}, ${email}\n`;

    if (!identifier) {
      return;
    }

    await this.validationFailureWriter.write(line);
  }

  async processSingleItem({ getToken, objectType, item, clientConfig, tenantModels, handler }) {
    try {
      if (handler.preprocess) {
        await handler.preprocess({ item, clientConfig, tenantModels });
      }

      const token = await getToken();

      if (!item?.properties?.email && objectType !== 'product') {
        await this.writeValidationFailure(objectType, item);
        await this.registerBaseMapping(
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
          existing,
          item,
          clientConfig,
          tenantModels,
        });
      } else {
        created = await handler.create({ token, item, clientConfig, tenantModels });

        await this.sapHubspotIdUpdater.updateHubspotIdInSap({
          clientConfig,
          objectType,
          sapRecord: item?.properties ?? {},
          hubspotId: created?.id,
          tenantModels,
        });

        await this.registerBaseMapping(
          clientConfig,
          objectType,
          getSapIdForRegistry(objectType, item),
          created?.id,
          tenantModels
        );
      }

      await this.associationHandler.handleAssociations({
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

  async processItemsSequentially(items, context) {
    let sent = 0;
    let failed = 0;

    for (const item of items) {
      const result = await this.processSingleItem({ ...context, item });

      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    }

    return { sent, failed };
  }

  async finalizeCreatedProductBatch({ createdResults, createdItems, clientConfig, tenantModels }) {
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

      await this.sapHubspotIdUpdater.updateHubspotIdInSap({
        clientConfig,
        objectType: 'product',
        sapRecord: item?.properties ?? {},
        hubspotId: created.id,
        tenantModels,
      });

      await this.registerBaseMapping(
        clientConfig,
        'product',
        getSapIdForRegistry('product', item),
        created.id,
        tenantModels
      );
    }
  }

  async processProductBatch({ items, clientConfig, tenantModels, handler, getToken }) {
    let sent = 0;
    let failed = 0;
    const createEntries = [];
    const updateEntries = [];

    for (const item of items) {
      try {
        if (handler.preprocess) {
          await handler.preprocess({ item, clientConfig, tenantModels });
        }

        const token = await getToken();
        const existing = await this.retryRequest(() =>
          handler.find({ token, item, clientConfig, tenantModels })
        );

        if (existing) {
          updateEntries.push({ existing, item });
        } else {
          createEntries.push({ item });
        }

        await this.sleeper(200);
      } catch (error) {
        console.error('processProductBatch item error:', error);
        failed += 1;
      }
    }

    if (createEntries.length > 0) {
      try {
        const token = await getToken();
        const response = await this.productBatchClient.batchCreateProducts(token, {
          inputs: createEntries.map(({ item }) => item),
        });

        await this.finalizeCreatedProductBatch({
          createdResults: Array.isArray(response?.results) ? response.results : [],
          createdItems: createEntries.map(({ item }) => item),
          clientConfig,
          tenantModels,
        });

        sent += createEntries.length;
      } catch (error) {
        console.error('processProductBatch create error:', error);
        const fallbackResult = await this.processItemsSequentially(
          createEntries.map(({ item }) => item),
          { objectType: 'product', clientConfig, tenantModels, handler, getToken }
        );

        sent += fallbackResult.sent;
        failed += fallbackResult.failed;
      }
    }

    if (updateEntries.length > 0) {
      try {
        const token = await getToken();
        await this.productBatchClient.batchUpdateProducts(token, {
          inputs: updateEntries.map(({ existing, item }) => ({
            id: existing.id,
            properties: item?.properties ?? {},
          })),
        });

        sent += updateEntries.length;
      } catch (error) {
        console.error('processProductBatch update error:', error);
        const fallbackResult = await this.processItemsSequentially(
          updateEntries.map(({ item }) => item),
          { objectType: 'product', clientConfig, tenantModels, handler, getToken }
        );

        sent += fallbackResult.sent;
        failed += fallbackResult.failed;
      }
    }

    return { sent, failed };
  }

  async processProductBatches({ mappedItems, clientConfig, tenantModels, handler, getToken }) {
    const batchSize = Number(clientConfig?.hubspotBatchSize);
    let sent = 0;
    let failed = 0;

    for (let index = 0; index < mappedItems.length; index += batchSize) {
      const batch = mappedItems.slice(index, index + batchSize);
      const batchResult = await this.processProductBatch({
        items: batch,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });

      sent += batchResult.sent;
      failed += batchResult.failed;
    }

    return { ok: true, sent, failed };
  }
}

export default SendMappedItemsToHubspot;
