import { shouldUpdateSapFromHubspot } from '#domain/sync/main-data-in-update.constants.js';
import { applyBypassEmail } from '#application/services/bypassEmail.service.js';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  SEARCH_FALLBACK_CONCURRENCY,
  chunkArray,
  retryRequest,
  runInWaves,
} from '#application/services/hubspotBatching.utils.js';

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getSapId(item) {
  return item?.properties?.idsap ?? null;
}

// Batched company/contact flow: batch read (idProperty) -> diff -> batch
// create/update in waves -> bulk registry -> batch associations. Mirrors
// SendMappedItemsToHubspot.processProductBatches, including its degraded
// sequential fallbacks. Flavor-agnostic: B1 and S/4 feed the same mappedItems.
export class ProcessCrmObjectBatches {
  constructor({
    crmBatchClient,
    associationRegistry,
    sapHubspotIdUpdater,
    validationFailureWriter,
    findPropertyResolver,
    fetchFallbackAssociations = null,
    syncCompanyContactsInBatches = null,
    syncWarningRepository = null,
    logger = console,
    sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.crmBatchClient = crmBatchClient;
    this.associationRegistry = associationRegistry;
    this.sapHubspotIdUpdater = sapHubspotIdUpdater;
    this.validationFailureWriter = validationFailureWriter;
    this.findPropertyResolver = findPropertyResolver;
    this.fetchFallbackAssociations = fetchFallbackAssociations;
    this.syncCompanyContactsInBatches = syncCompanyContactsInBatches;
    this.syncWarningRepository = syncWarningRepository;
    this.logger = logger;
    this.sleeper = sleeper;
  }

  retry(fn) {
    return retryRequest(fn, { sleeper: this.sleeper });
  }

  async recordWarning(payload) {
    if (!this.syncWarningRepository?.record) {
      return null;
    }

    try {
      return await this.syncWarningRepository.record(payload);
    } catch (error) {
      this.logger.error?.('Sync warning record error:', error);
      return null;
    }
  }

  mergeStats(stats, result) {
    stats.sent += result?.sent ?? 0;
    stats.failed += result?.failed ?? 0;
    stats.created += result?.created ?? 0;
    stats.updated += result?.updated ?? 0;
    stats.skipped += result?.skipped ?? 0;
    stats.errors.push(...(result?.errors ?? []));
  }

  async execute({
    mappedItems,
    objectType,
    clientConfig,
    tenantModels,
    handler,
    getToken,
    mainDataInUpdate,
    bypassEmail,
    preprocessContext = null,
    syncLogId = null,
    sequentialFallback,
  }) {
    const stats = { sent: 0, failed: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const clientConfigId = clientConfig?.id ?? clientConfig?._id ?? null;

    const preprocessed = [];
    for (const item of mappedItems ?? []) {
      try {
        if (handler.preprocess) {
          await handler.preprocess({ item, clientConfig, tenantModels, preprocessContext });
        }
        preprocessed.push(item);
      } catch (error) {
        this.logger.error?.('ProcessCrmObjectBatches preprocess error:', error);
        stats.failed += 1;
        stats.errors.push({
          payloadHubspot: item?.properties ?? null,
          responseHubspot: error?.details?.hubspotResponse ?? null,
        });
      }
    }

    // Same email validation as processSingleItem: items without email (and not
    // bypassed) are logged + registered with an empty HubSpot id and counted
    // as sent, never pushed to HubSpot.
    const syncable = [];
    const validationSkips = [];

    for (const item of preprocessed) {
      const bypassWarnings = [];
      const emailWasBypassed = applyBypassEmail({
        objectType,
        item,
        bypassEmail,
        logger: this.logger,
        onWarning: (warning) => bypassWarnings.push(warning),
      });

      for (const warning of bypassWarnings) {
        await this.recordWarning({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType,
          sapId: warning.sapId ?? item?.properties?.idsap ?? null,
          code: warning.code,
          message: warning.message,
          details: {
            source: 'mainRecord',
            email: warning.email ?? null,
          },
        });
      }

      if (!item?.properties?.email && !emailWasBypassed) {
        const identifier = String(item?.properties?.idsap ?? '').trim();
        const email = String(item?.properties?.email ?? '').trim();

        if (identifier) {
          await this.validationFailureWriter.write(`${identifier}, ${email}\n`);
        }
        validationSkips.push({ sapId: item?.properties?.idsap, hubspotId: '' });
        stats.sent += 1;
        continue;
      }

      syncable.push(item);
    }

    if (validationSkips.length > 0) {
      await this.associationRegistry.registerBaseObjectMappings(
        clientConfig.hubspotCredentialId,
        objectType,
        validationSkips.filter(({ sapId }) => sapId),
        tenantModels
      );
    }

    if (syncable.length === 0) {
      return { ok: true, ...stats };
    }

    const findProperty = await this.findPropertyResolver({ tenantModels });
    const withValue = syncable.filter((item) => normalizeKey(item?.properties?.[findProperty]));
    const withoutValue = syncable.filter((item) => !normalizeKey(item?.properties?.[findProperty]));

    let existingByKey;
    try {
      existingByKey = await this.readExisting({
        items: withValue,
        findProperty,
        objectType,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });
    } catch (error) {
      // Degraded mode: same per-item find/create/update behavior as before batching.
      this.logger.error?.('ProcessCrmObjectBatches read error:', error);
      const fallbackResult = await sequentialFallback(syncable);
      this.mergeStats(stats, fallbackResult);
      return { ok: true, ...stats };
    }

    const createEntries = withoutValue.map((item) => ({ item }));
    const updateEntries = [];
    const sapModeEntries = [];
    // sapId -> hubspotId for every item that ends the run with a HubSpot id;
    // feeds the association phase.
    const processed = [];

    for (const item of withValue) {
      const existing = existingByKey.get(normalizeKey(item.properties[findProperty]));

      if (!existing) {
        createEntries.push({ item });
        continue;
      }

      processed.push({ item, hubspotId: existing.id });

      if (shouldUpdateSapFromHubspot({ mainDataInUpdate, objectType })) {
        sapModeEntries.push({ item, existing });
      } else if (mainDataInUpdate === 'HUBSPOT') {
        const updateInput = handler.buildBatchUpdateEntry({ existing, item });

        if (updateInput) {
          updateEntries.push({ item, updateInput });
        } else {
          stats.sent += 1;
          stats.skipped += 1;
        }
      } else {
        stats.sent += 1;
      }
    }

    // SAP is the system of record here: writes go to SAP one by one (SAP
    // Service Layer / Gateway does not offer a safe bulk update for this).
    for (const { item, existing } of sapModeEntries) {
      try {
        await this.sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot({
          clientConfig,
          objectType,
          item,
          existing,
          tenantModels,
        });
        stats.sent += 1;
        stats.updated += 1;
      } catch (error) {
        this.logger.error?.('ProcessCrmObjectBatches SAP update error:', error);
        stats.failed += 1;
        stats.errors.push({
          payloadHubspot: item?.properties ?? null,
          responseHubspot: error?.details?.hubspotResponse ?? null,
        });
      }
    }

    const createResults = await runInWaves(
      chunkArray(createEntries, this.writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        const chunkItems = entryChunk.map(({ item }) => item);

        try {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchCreateObjects(token, objectType, {
              inputs: chunkItems.map((item) => ({ properties: item.properties })),
            })
          );

          const results = Array.isArray(response?.results) ? response.results : [];
          const resultByKey = new Map();
          for (const result of results) {
            const key = normalizeKey(result?.properties?.[findProperty]);
            if (key && !resultByKey.has(key)) {
              resultByKey.set(key, result);
            }
          }

          const mappings = [];
          for (const [index, item] of chunkItems.entries()) {
            const created = resultByKey.get(normalizeKey(item?.properties?.[findProperty]))
              ?? results[index];

            if (created?.id) {
              processed.push({ item, hubspotId: created.id });
              const sapId = getSapId(item);
              if (sapId) {
                mappings.push({ sapId, hubspotId: created.id });
              }
            }
          }

          if (mappings.length > 0) {
            await this.associationRegistry.registerBaseObjectMappings(
              clientConfig.hubspotCredentialId,
              objectType,
              mappings,
              tenantModels
            );
          }

          return { sent: chunkItems.length, created: chunkItems.length };
        } catch (error) {
          this.logger.error?.('ProcessCrmObjectBatches create error:', error);
          return sequentialFallback(chunkItems);
        }
      }
    );

    const updateResults = await runInWaves(
      chunkArray(updateEntries, this.writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchUpdateObjects(token, objectType, {
              inputs: entryChunk.map(({ updateInput }) => updateInput),
            })
          );

          return { sent: entryChunk.length, updated: entryChunk.length };
        } catch (error) {
          this.logger.error?.('ProcessCrmObjectBatches update error:', error);
          return sequentialFallback(entryChunk.map(({ item }) => item));
        }
      }
    );

    for (const result of [...createResults, ...updateResults]) {
      this.mergeStats(stats, result);
    }

    await this.handleAssociations({
      objectType,
      processed,
      clientConfig,
      tenantModels,
      getToken,
      syncLogId,
      stats,
    });

    return { ok: true, ...stats };
  }

  writeChunkSize(clientConfig) {
    return Math.min(
      Number(clientConfig?.hubspotBatchSize) || HUBSPOT_BATCH_INPUT_LIMIT,
      HUBSPOT_BATCH_INPUT_LIMIT
    );
  }

  // Batch read keyed by the tenant's configured find property; falls back to
  // Search IN when the property is not unique-flagged; rethrows when both fail
  // so the caller can degrade the whole run to the sequential path.
  async readExisting({ items, findProperty, objectType, clientConfig, tenantModels, handler, getToken }) {
    const existingByKey = new Map();
    const values = [...new Set(items.map((item) => String(item.properties[findProperty])))];

    if (values.length === 0) {
      return existingByKey;
    }

    const searchProperties = await handler.getSearchProperties({ clientConfig, tenantModels });
    const propertyNames = [...new Set([
      findProperty,
      ...searchProperties,
      ...items.flatMap((item) => Object.keys(item?.properties ?? {})),
    ])].filter((name) => name !== 'hs_object_id' && name !== 'associations');

    const collect = (results) => {
      for (const result of results ?? []) {
        const key = normalizeKey(result?.properties?.[findProperty]);
        if (key && !existingByKey.has(key)) {
          existingByKey.set(key, result);
        }
      }
    };

    try {
      await runInWaves(
        chunkArray(values, HUBSPOT_BATCH_INPUT_LIMIT),
        BATCH_CONCURRENCY,
        async (valueChunk) => {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchReadObjectsByProperty(token, objectType, {
              idProperty: findProperty,
              values: valueChunk,
              properties: propertyNames,
            })
          );
          collect(response?.results);
        }
      );
      return existingByKey;
    } catch (batchReadError) {
      this.logger.error?.('CRM batch read failed, falling back to search IN:', batchReadError);
    }

    existingByKey.clear();
    await runInWaves(
      chunkArray(values, HUBSPOT_BATCH_INPUT_LIMIT),
      SEARCH_FALLBACK_CONCURRENCY,
      async (valueChunk) => {
        const token = await getToken();
        const results = await this.retry(() =>
          this.crmBatchClient.searchObjectsByPropertyIn(token, objectType, findProperty, valueChunk, propertyNames)
        );
        collect(results);
      }
    );
    return existingByKey;
  }

  async handleAssociations({ objectType, processed, clientConfig, tenantModels, getToken, syncLogId, stats }) {
    if (processed.length === 0) {
      return;
    }

    if (objectType === 'contact') {
      await this.associateWithRegistry({
        processed,
        targetObjectType: 'company',
        pickTargets: (item) => item?.properties?.associations?.companies ?? [],
        fromObjectType: 'contact',
        toObjectType: 'company',
        clientConfig,
        tenantModels,
        getToken,
      });
      return;
    }

    if (objectType === 'company') {
      await this.associateWithRegistry({
        processed,
        targetObjectType: 'contact',
        pickTargets: (item) => item?.properties?.associations?.contacts ?? [],
        fromObjectType: 'company',
        toObjectType: 'contact',
        clientConfig,
        tenantModels,
        getToken,
      });

      if (this.syncCompanyContactsInBatches) {
        const { contactErrors } = await this.syncCompanyContactsInBatches.execute({
          companies: processed,
          clientConfig,
          tenantModels,
          getToken,
          syncLogId,
        });

        if (Array.isArray(contactErrors) && contactErrors.length > 0) {
          stats.errors.push(...contactErrors);
        }
      }
    }
  }

  // Resolves SAP ids to HubSpot ids with ONE registry query and associates in
  // 100-pair batches. Association failures are logged, never fatal (parity
  // with associationService's per-pair behavior).
  async associateWithRegistry({
    processed,
    targetObjectType,
    pickTargets,
    fromObjectType,
    toObjectType,
    clientConfig,
    tenantModels,
    getToken,
  }) {
    let fallbackTargets = null;
    let fallbackFetched = false;

    const wanted = [];
    for (const { item, hubspotId } of processed) {
      let targets = pickTargets(item);

      if ((!Array.isArray(targets) || targets.length === 0) && clientConfig.associationFetchEnabled) {
        // The per-item flow refetches this for every empty item; the batch
        // flow fetches once per run and reuses it (same resulting targets).
        if (!fallbackFetched && this.fetchFallbackAssociations) {
          const aggregated = await this.fetchFallbackAssociations({
            clientConfig,
            objectType: fromObjectType,
          });
          fallbackTargets = aggregated?.[`${targetObjectType === 'company' ? 'companies' : 'contacts'}`] ?? null;
          fallbackFetched = true;
        }
        targets = fallbackTargets ?? [];
      }

      for (const target of targets ?? []) {
        const sapId = target?.sapId ?? target;
        if (sapId) {
          wanted.push({ hubspotId, sapId: String(sapId) });
        }
      }
    }

    if (wanted.length === 0) {
      return;
    }

    const uniqueSapIds = [...new Set(wanted.map(({ sapId }) => sapId))];
    const targetIdBySapId = await this.associationRegistry.findHubspotIdsForSapIds(
      clientConfig.hubspotCredentialId,
      targetObjectType,
      uniqueSapIds,
      tenantModels
    );

    const pairs = [];
    const seen = new Set();
    for (const { hubspotId, sapId } of wanted) {
      const targetHubspotId = targetIdBySapId.get(sapId);
      const pairKey = `${hubspotId}:${targetHubspotId}`;

      if (targetHubspotId && !seen.has(pairKey)) {
        seen.add(pairKey);
        pairs.push({ fromId: hubspotId, toId: targetHubspotId });
      }
    }

    await runInWaves(
      chunkArray(pairs, HUBSPOT_BATCH_INPUT_LIMIT),
      BATCH_CONCURRENCY,
      async (pairChunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchAssociateDefault(token, fromObjectType, toObjectType, pairChunk)
          );
        } catch (error) {
          this.logger.error?.('Batch association failed, falling back per pair:', error);
          for (const { fromId, toId } of pairChunk) {
            try {
              const token = await getToken();
              await this.crmBatchClient.associateObjects(token, fromObjectType, fromId, toObjectType, toId);
            } catch (pairError) {
              this.logger.error?.('Failed to associate objects', {
                fromObjectType,
                fromId,
                toObjectType,
                toId,
                error: pairError,
              });
            }
          }
        }
      }
    );
  }
}

export default ProcessCrmObjectBatches;
