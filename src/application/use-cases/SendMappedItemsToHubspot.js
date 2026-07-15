import {
  DEFAULT_MAIN_DATA_IN_UPDATE,
  shouldUpdateSapFromHubspot,
} from '#domain/sync/main-data-in-update.constants.js';
import {
  applyBypassEmail,
  resolveBypassEmail,
} from '#application/services/bypassEmail.service.js';

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

// HubSpot batch endpoints (read/create/update) accept at most 100 inputs per call.
const HUBSPOT_BATCH_INPUT_LIMIT = 100;
// Concurrent batch calls per wave. 4 keeps us well under HubSpot's ~190 requests/10s limit.
const BATCH_CONCURRENCY = 4;

function chunkArray(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

async function runInWaves(chunks, concurrency, worker) {
  const results = [];
  for (const wave of chunkArray(chunks, concurrency)) {
    results.push(...await Promise.all(wave.map(worker)));
  }
  return results;
}

function normalizePropertyValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

// HubSpot returns every property as a string, so numeric values must compare
// numerically ("5.0" equals 5). Empty never equals a number: writing 0 into an
// empty property is a real change.
function propertyValuesEqual(sentValue, existingValue) {
  const a = normalizePropertyValue(sentValue);
  const b = normalizePropertyValue(existingValue);

  if (a === b) {
    return true;
  }
  if (a === '' || b === '') {
    return false;
  }

  const numA = Number(a);
  const numB = Number(b);
  return !Number.isNaN(numA) && !Number.isNaN(numB) && numA === numB;
}

export function productPropertiesUnchanged(sentProperties, existingProperties) {
  return Object.entries(sentProperties ?? {})
    .filter(([key]) => key !== 'hs_object_id')
    .every(([key, value]) => propertyValuesEqual(value, existingProperties?.[key]));
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
    mainDataInUpdateConfigRepository = null,
    bypassEmailConfigRepository = null,
    logger = console,
    sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.tokenProvider = tokenProvider;
    this.productBatchClient = productBatchClient;
    this.associationRegistry = associationRegistry;
    this.associationHandler = associationHandler;
    this.sapHubspotIdUpdater = sapHubspotIdUpdater;
    this.handlers = handlers;
    this.validationFailureWriter = validationFailureWriter;
    this.mainDataInUpdateConfigRepository = mainDataInUpdateConfigRepository;
    this.bypassEmailConfigRepository = bypassEmailConfigRepository;
    this.logger = logger;
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

    if (objectType === 'invoice') {
      return this.processInvoiceItems({
        mappedItems,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });
    }

    if (objectType === 'product' && Number(clientConfig?.hubspotBatchSize) > 1) {
      return this.processProductBatches({
        mappedItems,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });
    }

    const mainDataInUpdate = await this.getMainDataInUpdate(tenantModels);
    const bypassEmail = await this.getBypassEmail({ objectType, tenantModels });
    const result = await this.processItemsSequentially(mappedItems, {
      objectType,
      clientConfig,
      tenantModels,
      handler,
      getToken,
      mainDataInUpdate,
      bypassEmail,
    });

    return { ok: true, ...result };
  }

  async getBypassEmail({ objectType, tenantModels }) {
    return resolveBypassEmail({
      objectType,
      tenantModels,
      bypassEmailConfigRepository: this.bypassEmailConfigRepository,
      logger: this.logger,
    });
  }

  applyBypassEmail({ objectType, item, bypassEmail }) {
    return applyBypassEmail({
      objectType,
      item,
      bypassEmail,
      logger: this.logger,
    });
  }

  async getMainDataInUpdate(tenantModels) {
    if (!this.mainDataInUpdateConfigRepository) {
      return DEFAULT_MAIN_DATA_IN_UPDATE;
    }

    try {
      return await this.mainDataInUpdateConfigRepository.getMainDataInUpdate({ tenantModels });
    } catch (_error) {
      return DEFAULT_MAIN_DATA_IN_UPDATE;
    }
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

  async processSingleItem({
    getToken,
    objectType,
    item,
    clientConfig,
    tenantModels,
    handler,
    mainDataInUpdate = DEFAULT_MAIN_DATA_IN_UPDATE,
    bypassEmail = false,
    preprocessContext = null,
  }) {
    try {
      if (handler.preprocess) {
        await handler.preprocess({ item, clientConfig, tenantModels, preprocessContext });
      }

      const emailWasBypassed = this.applyBypassEmail({ objectType, item, bypassEmail });

      const token = await getToken();

      if (!item?.properties?.email && objectType !== 'product' && objectType !== 'deal' && !emailWasBypassed) {
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
      let resultMetrics;

      if (existing) {
        if (shouldUpdateSapFromHubspot({ mainDataInUpdate, objectType })) {
          await this.sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot({
            clientConfig,
            objectType,
            item,
            existing,
            tenantModels,
          });
          resultMetrics = { created: 0, updated: 1 };
        } else if (mainDataInUpdate === 'HUBSPOT') {
          await handler.update({
            token,
            id: existing.id,
            existing,
            item,
            clientConfig,
            tenantModels,
          });
          resultMetrics = { created: 0, updated: 1 };
        } else {
          resultMetrics = { created: 0, updated: 0 };
        }
      } else {
        created = await handler.create({ token, item, clientConfig, tenantModels });

        /*await this.sapHubspotIdUpdater.updateHubspotIdInSap({
          clientConfig,
          objectType,
          sapRecord: item?.properties ?? {},
          hubspotId: created?.id,
          tenantModels,
        });*/

        await this.registerBaseMapping(
          clientConfig,
          objectType,
          getSapIdForRegistry(objectType, item),
          created?.id,
          tenantModels
        );
        resultMetrics = { created: 1, updated: 0 };
      }

      await this.associationHandler.handleAssociations({
        objectType,
        token,
        item,
        clientConfig,
        tenantModels,
        hubspotId: existing?.id ?? created?.id,
      });

      return { ok: true, ...resultMetrics };
    } catch (error) {
      console.error('processSingleItem error:', error);
      return {
        ok: false,
        created: 0,
        updated: 0,
        error: {
          payloadHubspot: item?.properties ?? null,
          responseHubspot: error?.details?.hubspotResponse ?? null,
        },
      };
    }
  }

  async processItemsSequentially(items, context) {
    let sent = 0;
    let failed = 0;
    let created = 0;
    let updated = 0;
    const errors = [];

    const preprocessContext = context.preprocessContext
      ?? (context.handler?.buildPreprocessContext
        ? await context.handler.buildPreprocessContext({
          clientConfig: context.clientConfig,
          tenantModels: context.tenantModels,
        })
        : null);

    for (const item of items) {
      const result = await this.processSingleItem({ ...context, preprocessContext, item });

      if (result.ok) {
        sent += 1;
        created += result.created ?? 0;
        updated += result.updated ?? 0;
      } else {
        failed += 1;
        if (result.error) {
          errors.push(result.error);
        }
      }
    }

    return { sent, failed, created, updated, errors };
  }

  async processInvoiceItems({ mappedItems, clientConfig, tenantModels, handler, getToken }) {
    if (typeof handler?.process !== 'function') {
      throw new Error('Invoice handler must expose a process() method');
    }

    let sent = 0;
    let failed = 0;
    let updated = 0;
    const errors = [];

    for (const item of mappedItems) {
      try {
        const token = await getToken();
        const result = await handler.process({ token, item, clientConfig, tenantModels });

        if (result?.status === 'failed') {
          failed += 1;
          errors.push({
            payloadHubspot: item?.properties ?? null,
            responseHubspot: result?.hubspotResponse ?? result?.error?.details?.hubspotResponse ?? null,
          });
          continue;
        }

        sent += 1;
        if (result?.status === 'updated') {
          updated += 1;
        }
      } catch (error) {
        this.logger?.error?.('processInvoiceItems error:', error);
        failed += 1;
        errors.push({
          payloadHubspot: item?.properties ?? null,
          responseHubspot: error?.details?.hubspotResponse ?? null,
        });
      }
    }

    return { ok: true, sent, failed, created: 0, updated, errors };
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

  async processProductBatches({ mappedItems, clientConfig, tenantModels, handler, getToken }) {
    const stats = { sent: 0, failed: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const preprocessed = [];

    // Tenant configuration is constant during the run: resolve it once instead of
    // letting every preprocess() hit the database per item.
    const preprocessContext = handler.buildPreprocessContext
      ? await handler.buildPreprocessContext({ clientConfig, tenantModels })
      : null;

    for (const item of mappedItems) {
      try {
        if (handler.preprocess) {
          await handler.preprocess({ item, clientConfig, tenantModels, preprocessContext });
        }
        preprocessed.push(item);
      } catch (error) {
        console.error('processProductBatches preprocess error:', error);
        stats.failed += 1;
        stats.errors.push({
          payloadHubspot: item?.properties ?? null,
          responseHubspot: error?.details?.hubspotResponse ?? null,
        });
      }
    }

    const withSku = preprocessed.filter((item) => item?.properties?.hs_sku);
    const withoutSku = preprocessed.filter((item) => !item?.properties?.hs_sku);

    let existingBySku;
    try {
      existingBySku = await this.readExistingProductsBySku({ items: withSku, getToken });
    } catch (error) {
      // Degraded mode: same per-item find/create/update behavior as before batching.
      console.error('processProductBatches read error:', error);
      const fallbackResult = await this.processItemsSequentially(preprocessed, {
        objectType: 'product',
        clientConfig,
        tenantModels,
        handler,
        getToken,
        preprocessContext,
      });
      this.mergeProductStats(stats, fallbackResult);
      return { ok: true, ...stats };
    }

    const createEntries = withoutSku.map((item) => ({ item }));
    const updateEntries = [];

    for (const item of withSku) {
      const existing = existingBySku.get(String(item.properties.hs_sku));

      if (!existing) {
        createEntries.push({ item });
      } else if (productPropertiesUnchanged(item.properties, existing.properties)) {
        stats.sent += 1;
        stats.skipped += 1;
      } else {
        updateEntries.push({ existing, item });
      }
    }

    const writeChunkSize = Math.min(
      Number(clientConfig?.hubspotBatchSize) || HUBSPOT_BATCH_INPUT_LIMIT,
      HUBSPOT_BATCH_INPUT_LIMIT
    );

    const createResults = await runInWaves(
      chunkArray(createEntries, writeChunkSize),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        const chunkItems = entryChunk.map(({ item }) => item);

        try {
          const token = await getToken();
          const response = await this.retryRequest(() =>
            this.productBatchClient.batchCreateProducts(token, { inputs: chunkItems })
          );

          await this.finalizeCreatedProductBatch({
            createdResults: Array.isArray(response?.results) ? response.results : [],
            createdItems: chunkItems,
            clientConfig,
            tenantModels,
          });

          return { sent: chunkItems.length, created: chunkItems.length };
        } catch (error) {
          console.error('processProductBatches create error:', error);
          return this.processItemsSequentially(chunkItems, {
            objectType: 'product',
            clientConfig,
            tenantModels,
            handler,
            getToken,
            preprocessContext,
          });
        }
      }
    );

    const updateResults = await runInWaves(
      chunkArray(updateEntries, writeChunkSize),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        try {
          const token = await getToken();
          await this.retryRequest(() =>
            this.productBatchClient.batchUpdateProducts(token, {
              inputs: entryChunk.map(({ existing, item }) => ({
                id: existing.id,
                properties: item?.properties ?? {},
              })),
            })
          );

          return { sent: entryChunk.length, updated: entryChunk.length };
        } catch (error) {
          console.error('processProductBatches update error:', error);
          return this.processItemsSequentially(
            entryChunk.map(({ item }) => item),
            { objectType: 'product', clientConfig, tenantModels, handler, getToken, preprocessContext }
          );
        }
      }
    );

    for (const result of [...createResults, ...updateResults]) {
      this.mergeProductStats(stats, result);
    }

    return { ok: true, ...stats };
  }

  // Reads every existing product keyed by hs_sku via batch/read (100 SKUs per call, in
  // concurrent waves), requesting all properties we are about to send so the change
  // diff can compare against current HubSpot values.
  async readExistingProductsBySku({ items, getToken }) {
    const skus = [...new Set(items.map((item) => String(item.properties.hs_sku)))];
    const propertyNames = [...new Set([
      'hs_sku',
      ...items.flatMap((item) => Object.keys(item?.properties ?? {})),
    ])].filter((name) => name !== 'hs_object_id');

    const existingBySku = new Map();

    await runInWaves(
      chunkArray(skus, HUBSPOT_BATCH_INPUT_LIMIT),
      BATCH_CONCURRENCY,
      async (skuChunk) => {
        const token = await getToken();
        const response = await this.retryRequest(() =>
          this.productBatchClient.batchReadProductsBySku(token, skuChunk, propertyNames)
        );

        for (const result of response?.results ?? []) {
          const sku = result?.properties?.hs_sku;
          if (sku !== null && sku !== undefined && sku !== '' && !existingBySku.has(String(sku))) {
            existingBySku.set(String(sku), result);
          }
        }
      }
    );

    return existingBySku;
  }

  mergeProductStats(stats, result) {
    stats.sent += result?.sent ?? 0;
    stats.failed += result?.failed ?? 0;
    stats.created += result?.created ?? 0;
    stats.updated += result?.updated ?? 0;
    stats.skipped += result?.skipped ?? 0;
    stats.errors.push(...(result?.errors ?? []));
  }
}

export default SendMappedItemsToHubspot;
