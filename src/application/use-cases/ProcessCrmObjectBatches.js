import {
  MAIN_DATA_IN_UPDATE,
  normalizeMainDataInUpdate,
  shouldUpdateSapFromHubspot,
} from '#domain/sync/main-data-in-update.constants.js';
import { applyBypassEmail } from '#application/services/bypassEmail.service.js';
import { CrmObjectIndex, normalizeIndexKey } from '#application/services/crmObjectIndex.service.js';
import { sanitizeProperties } from '#application/services/hubspotPropertyPayload.service.js';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  chunkArray,
  retryRequest,
  runInWaves,
  summarizeBatchResponse,
  writeChunkSize,
} from '#application/services/hubspotBatching.utils.js';

function getSapId(item) {
  return item?.properties?.idsap ?? null;
}

// Batched company/contact flow: one prefetch sweep indexed in memory -> diff ->
// batch create/update in waves -> bulk registry -> batch associations. Mirrors
// SendMappedItemsToHubspot.processProductBatches, including its degraded
// sequential fallbacks. Flavor-agnostic: B1 and S/4 feed the same mappedItems.
export class ProcessCrmObjectBatches {
  constructor({
    crmBatchClient,
    associationRegistry,
    sapHubspotIdUpdater,
    validationFailureWriter,
    findPropertyResolver,
    identityProperty = 'idsap',
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
    // Fallback resolver: the tenant's configured defaultFindHubspot property,
    // only consulted when the identity property finds nothing.
    this.findPropertyResolver = findPropertyResolver;
    this.identityProperty = identityProperty;
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

    const fallbackProperty = await this.findPropertyResolver({ tenantModels });

    let index;
    let writableProperties = null;
    try {
      index = await this.buildIndex({
        objectType,
        fallbackProperty,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });

      const token = await getToken();
      writableProperties = await this.retry(() =>
        this.crmBatchClient.listWritablePropertyNames(token, objectType)
      );
    } catch (error) {
      // Without the index we cannot tell creates from updates, and guessing
      // would duplicate the whole base: fall back to the per-item path.
      this.logger.error?.('ProcessCrmObjectBatches index error:', error);
      const fallbackResult = await sequentialFallback(syncable);
      this.mergeStats(stats, fallbackResult);
      return { ok: true, ...stats };
    }

    const createEntries = [];
    const updateEntries = [];
    const sapModeEntries = [];
    // sapId -> hubspotId for every item that ends the run with a HubSpot id;
    // feeds the association phase.
    const processed = [];
    // Two SAP rows that resolve to the same record must not create two records.
    const claimedKeys = new Set();

    for (const item of syncable) {
      const existing = index.find(item?.properties);

      if (!existing) {
        const claimKey = this.dedupeKey(item?.properties, fallbackProperty);

        if (claimKey && claimedKeys.has(claimKey)) {
          stats.sent += 1;
          stats.skipped += 1;
          continue;
        }
        if (claimKey) {
          claimedKeys.add(claimKey);
        }

        createEntries.push({ item });
        continue;
      }

      processed.push({ item, hubspotId: existing.id });

      if (shouldUpdateSapFromHubspot({ mainDataInUpdate, objectType })) {
        sapModeEntries.push({ item, existing });
      } else if (normalizeMainDataInUpdate(mainDataInUpdate) === MAIN_DATA_IN_UPDATE.HUBSPOT) {
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
              inputs: chunkItems.map((item) => ({
                properties: sanitizeProperties(item.properties, writableProperties),
              })),
            })
          );

          // batch/create echoes every record it actually created, so `results`
          // alone tells us what went through (a 207 leaves the rest out).
          const results = Array.isArray(response?.results) ? response.results : [];
          const batchErrors = Array.isArray(response?.errors) ? response.errors : [];
          // HubSpot does not preserve input order in batch/create responses,
          // so the identity property echoed back is the only sound match.
          const resultByIdentity = new Map();
          for (const result of results) {
            const key = normalizeIndexKey(result?.properties?.[this.identityProperty]);
            if (key && !resultByIdentity.has(key)) {
              resultByIdentity.set(key, result);
            }
          }

          const mappings = [];
          let unmatched = 0;

          for (const item of chunkItems) {
            const created = resultByIdentity.get(
              normalizeIndexKey(item?.properties?.[this.identityProperty])
            );

            if (!created?.id) {
              unmatched += 1;
              continue;
            }

            index.add(created);
            processed.push({ item, hubspotId: created.id });
            const sapId = getSapId(item);
            if (sapId) {
              mappings.push({ sapId, hubspotId: created.id });
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

          if (unmatched > 0) {
            this.logger.warn?.(`Batch create: ${unmatched} record(s) could not be matched back by ${this.identityProperty}`);
          }

          return {
            sent: results.length,
            created: results.length,
            failed: chunkItems.length - results.length,
            errors: batchErrors.map((batchError) => ({
              payloadHubspot: null,
              responseHubspot: batchError,
            })),
          };
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
          const response = await this.retry(() =>
            this.crmBatchClient.batchUpdateObjects(token, objectType, {
              inputs: entryChunk.map(({ updateInput }) => ({
                id: updateInput.id,
                properties: sanitizeProperties(updateInput.properties, writableProperties),
              })),
            })
          );

          const { errors, succeeded, failed } = summarizeBatchResponse(response, entryChunk.length);

          return {
            sent: succeeded,
            updated: succeeded,
            failed,
            errors: errors.map((batchError) => ({
              payloadHubspot: null,
              responseHubspot: batchError,
            })),
          };
        } catch (error) {
          this.logger.error?.('ProcessCrmObjectBatches update error:', error);
          // These items were already pushed to `processed` when their existing
          // record was read. The sequential fallback re-runs the whole per-item
          // flow (associations included), so drop them here to avoid doing the
          // association work twice.
          const chunkItems = entryChunk.map(({ item }) => item);
          const chunkItemSet = new Set(chunkItems);
          for (let index = processed.length - 1; index >= 0; index -= 1) {
            if (chunkItemSet.has(processed[index].item)) {
              processed.splice(index, 1);
            }
          }
          return sequentialFallback(chunkItems);
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
    return writeChunkSize(clientConfig);
  }

  // Dedupe on the same value index.find() matches on, otherwise two rows that
  // resolve to the same record through the fallback tier would both be created.
  // Null means nothing can ever match this row, so it is always created.
  dedupeKey(properties, fallbackProperty) {
    const identity = normalizeIndexKey(properties?.[this.identityProperty]);
    if (identity) {
      return `${this.identityProperty}:${identity}`;
    }
    if (fallbackProperty && fallbackProperty !== this.identityProperty) {
      const fallback = normalizeIndexKey(properties?.[fallbackProperty]);
      if (fallback) {
        return `${fallbackProperty}:${fallback}`;
      }
    }
    return null;
  }

  // One sweep of the whole object type, indexed in memory. This is what makes
  // the run fast: every later existence check is a Map lookup instead of an
  // API call. See the plan's evidence section for why batch/read and Search
  // cannot do this job.
  async buildIndex({ objectType, fallbackProperty, clientConfig, tenantModels, handler, getToken }) {
    const searchProperties = await handler.getSearchProperties({ clientConfig, tenantModels });
    const properties = [...new Set([
      this.identityProperty,
      fallbackProperty,
      ...searchProperties,
    ].filter(Boolean))].filter((name) => name !== 'hs_object_id' && name !== 'associations');

    const token = await getToken();
    const records = await this.retry(() =>
      this.crmBatchClient.listAllObjects(token, objectType, properties)
    );

    this.logger.info?.(`CRM index built for ${objectType}: ${records.length} records`);

    return new CrmObjectIndex({
      records,
      identityProperty: this.identityProperty,
      fallbackProperty,
    });
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
        if (!fallbackFetched) {
          if (this.fetchFallbackAssociations) {
            const aggregated = await this.fetchFallbackAssociations({
              clientConfig,
              objectType: fromObjectType,
            });
            fallbackTargets = aggregated?.[`${targetObjectType === 'company' ? 'companies' : 'contacts'}`] ?? null;
          }
          // Marked even without a fetcher: the answer is the same for every
          // item of the run, so re-evaluating it per item buys nothing.
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
          const response = await this.retry(() =>
            this.crmBatchClient.batchAssociateDefault(token, fromObjectType, toObjectType, pairChunk)
          );

          // Associations are non-fatal (parity with associationService's
          // per-pair behavior): a 207 is logged, never counted as failed.
          const { errors } = summarizeBatchResponse(response, pairChunk.length);
          for (const batchError of errors) {
            this.logger.error?.('Batch association partial failure', {
              fromObjectType,
              toObjectType,
              error: batchError,
            });
          }
        } catch (error) {
          this.logger.error?.('Batch association failed, falling back per pair:', error);
          for (const { fromId, toId } of pairChunk) {
            try {
              const token = await getToken();
              await this.retry(() =>
                this.crmBatchClient.associateObjects(token, fromObjectType, fromId, toObjectType, toId)
              );
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
