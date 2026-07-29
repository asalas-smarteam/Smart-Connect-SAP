import {
  applyBypassEmail,
  resolveBypassEmail,
} from '#application/services/bypassEmail.service.js';
import { buildCompanyContactPayload } from '#application/services/companyContactPayload.service.js';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  SEARCH_FALLBACK_CONCURRENCY,
  chunkArray,
  retryRequest,
  runInWaves,
  summarizeBatchResponse,
  writeChunkSize,
} from '#application/services/hubspotBatching.utils.js';
import { buildContactErrorEntry } from '#application/use-cases/HandleHubspotAssociations.js';

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getCompanySapId(item) {
  return item?.rawSapData?.BusinessPartner
    ?? item?.rawSapData?.CardCode
    ?? item?.properties?.idsap
    ?? null;
}

// Batched analogue of HandleHubspotAssociations.syncCompanyContacts: syncs the
// child contacts of every company of a run (B1 ContactEmployees / S/4
// _s4Contacts) with batch read/create/update + v4 default batch associations.
export class SyncCompanyContactsInBatches {
  constructor({
    crmBatchClient,
    contactHandler,
    associationRegistry,
    fieldMappingService,
    fallbackEmailGenerator,
    findPropertyResolver,
    bypassEmailConfigRepository = null,
    syncWarningRepository = null,
    logger = console,
    sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.crmBatchClient = crmBatchClient;
    this.contactHandler = contactHandler;
    this.associationRegistry = associationRegistry;
    this.fieldMappingService = fieldMappingService;
    this.fallbackEmailGenerator = fallbackEmailGenerator;
    this.findPropertyResolver = findPropertyResolver;
    this.bypassEmailConfigRepository = bypassEmailConfigRepository;
    this.syncWarningRepository = syncWarningRepository;
    this.logger = logger;
    this.sleeper = sleeper;
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

  retry(fn) {
    return retryRequest(fn, { sleeper: this.sleeper });
  }

  // Every SAP internal code that resolves to this contact: the entry's own plus
  // the codes of the twins deduped away by the shared find value.
  static sapIdsForEntry(entry, sapIdsByKey) {
    const sapIds = entry.key ? sapIdsByKey?.get(entry.key) : null;

    if (sapIds?.size) {
      return [...sapIds];
    }

    return entry.sapInternalCode ? [entry.sapInternalCode] : [];
  }

  async execute({ companies, clientConfig, tenantModels, getToken, syncLogId = null }) {
    const contactErrors = [];
    const clientConfigId = clientConfig?.id ?? clientConfig?._id ?? null;
    const withContacts = (Array.isArray(companies) ? companies : [])
      .filter(({ hubspotId }) => hubspotId)
      .map(({ item, hubspotId }) => ({
        item,
        hubspotId,
        sapCompanyId: getCompanySapId(item),
        sapContacts: item?.rawSapData?._s4Contacts ?? item?.rawSapData?.ContactEmployees ?? [],
      }))
      .filter(({ sapContacts }) => Array.isArray(sapContacts) && sapContacts.length > 0);

    if (withContacts.length === 0) {
      return { contactErrors };
    }

    let entries;
    try {
      entries = await this.buildEntries({ withContacts, clientConfig, tenantModels, clientConfigId, syncLogId });
    } catch (setupError) {
      this.logger.error?.('Company contact batch sync error:', setupError);
      contactErrors.push(buildContactErrorEntry({ error: setupError }));
      return { contactErrors };
    }

    if (entries.length === 0) {
      return { contactErrors };
    }

    // Dedupe by find-property value: HubSpot rejects a batch containing two
    // inputs with the same unique value. Every company keeps its association.
    const findProperty = await this.findPropertyResolver({ tenantModels });
    const byKey = new Map();
    // The normalized key is only a dedupe/lookup key. HubSpot must receive the
    // value exactly as SAP wrote it: find properties like idsap/internalcode
    // are case sensitive, so sending the lowercased key would miss every
    // existing record and re-create the whole contact base.
    const rawValueByKey = new Map();
    for (const entry of entries) {
      const rawValue = entry.contactPayload?.properties?.[findProperty];
      const key = normalizeKey(rawValue);
      entry.key = key;

      if (key && !byKey.has(key)) {
        byKey.set(key, entry);
        // Trimmed but NOT lowercased: whitespace is noise SAP often carries,
        // case is significant for idsap/internalcode lookups.
        rawValueByKey.set(key, String(rawValue).trim());
      } else if (!key) {
        // No find value (e.g. bypassed email with findProperty=email): cannot
        // be matched to an existing record — always created, never deduped.
        entry.alwaysCreate = true;
      }
    }
    const uniqueEntries = [...byKey.values(), ...entries.filter((entry) => entry.alwaysCreate)];

    // Deduping collapses twins that share a find value, but every twin's SAP id
    // still needs its own registry row — otherwise the next run cannot resolve
    // the dropped code and would create a duplicate contact.
    const sapIdsByKey = new Map();
    for (const entry of entries) {
      if (!entry.key || !entry.sapInternalCode) {
        continue;
      }
      if (!sapIdsByKey.has(entry.key)) {
        sapIdsByKey.set(entry.key, new Set());
      }
      sapIdsByKey.get(entry.key).add(entry.sapInternalCode);
    }

    let existingByKey;
    try {
      existingByKey = await this.readExistingContacts({
        values: [...rawValueByKey.values()],
        findProperty,
        uniqueEntries,
        clientConfig,
        tenantModels,
        getToken,
      });
    } catch (readError) {
      // Batch read AND its search fallback both failed: we cannot tell creates
      // from updates, so abort child-contact sync with a single error entry
      // rather than rejecting and breaking the caller's { contactErrors }.
      this.logger.error?.('Company contact batch sync error:', readError);
      contactErrors.push(buildContactErrorEntry({ error: readError }));
      return { contactErrors };
    }

    const createEntries = [];
    const updateEntries = [];
    const hubspotIdByKey = new Map();

    for (const entry of uniqueEntries) {
      const existing = entry.key ? existingByKey.get(entry.key) : null;

      if (!existing) {
        createEntries.push(entry);
        continue;
      }

      hubspotIdByKey.set(entry.key, existing.id);
      const updateInput = this.contactHandler.buildBatchUpdateEntry({ existing, item: entry.contactPayload });

      if (updateInput) {
        updateEntries.push({ entry, updateInput });
      }
    }

    await this.createContactBatches({ createEntries, hubspotIdByKey, sapIdsByKey, findProperty, clientConfig, tenantModels, getToken, contactErrors });
    await this.updateContactBatches({ updateEntries, clientConfig, tenantModels, getToken, contactErrors });
    await this.associateContactBatches({ entries, hubspotIdByKey, clientConfig, getToken, contactErrors });

    return { contactErrors };
  }

  // Maps every SAP contact of the run in ONE mapRecords call and applies the
  // same email/bypass/skip rules as the sequential path.
  async buildEntries({ withContacts, clientConfig, tenantModels, clientConfigId, syncLogId }) {
    const flat = [];
    for (const company of withContacts) {
      for (const sapContact of company.sapContacts) {
        flat.push({ company, sapContact });
      }
    }

    const contactMappings = await this.fieldMappingService.getMappingsByObjectType(
      clientConfig.hubspotCredentialId,
      'contact',
      'contactEmployee',
      tenantModels
    );

    if (!Array.isArray(contactMappings) || contactMappings.length === 0) {
      this.logger.warn?.('No contactEmployee mappings found for company contact sync');
    }

    const mappedContacts = await this.fieldMappingService.mapRecords(
      flat.map(({ sapContact }) => sapContact),
      clientConfig.hubspotCredentialId,
      'contact',
      tenantModels,
      'contactEmployee'
    );

    // The sequential flow iterates mappedContacts, so no mapping output means
    // no contacts at all. Building payloads from the raw SAP rows here would
    // create bare contacts the sequential path never creates.
    if (!Array.isArray(mappedContacts) || mappedContacts.length === 0) {
      return [];
    }

    const bypassEmail = await resolveBypassEmail({
      objectType: 'contact',
      tenantModels,
      bypassEmailConfigRepository: this.bypassEmailConfigRepository,
      logger: this.logger,
    });

    const entries = [];

    for (const [index, { company, sapContact }] of flat.entries()) {
      const { contactPayload, sapInternalCode } = buildCompanyContactPayload({
        mappedContact: mappedContacts[index] ?? { properties: {} },
        sapContact,
        companyFallbackSourceEmail: company.item?.rawSapData?.EmailAddress,
        fallbackEmailGenerator: this.fallbackEmailGenerator,
      });

      const bypassWarnings = [];
      const emailWasBypassed = applyBypassEmail({
        objectType: 'contact',
        item: contactPayload,
        bypassEmail,
        logger: this.logger,
        sapId: sapInternalCode ?? null,
        onWarning: (warning) => bypassWarnings.push(warning),
      });

      for (const warning of bypassWarnings) {
        await this.recordWarning({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType: 'contact',
          sapId: warning.sapId ?? sapInternalCode ?? null,
          code: warning.code,
          message: warning.message,
          details: {
            source: 'companyContact',
            sapCompanyId: company.sapCompanyId,
            hubspotCompanyId: company.hubspotId ?? null,
            email: warning.email ?? null,
          },
        });
      }

      if (!contactPayload.properties.email && !emailWasBypassed) {
        this.logger.error?.(
          'Company contact sync error:',
          new Error('Company contact email is required before HubSpot sync')
        );
        await this.recordWarning({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType: 'contact',
          sapId: sapInternalCode ?? null,
          code: 'contactEmailMissingSkipped',
          message: 'Company contact skipped: email is required before HubSpot sync',
          details: {
            source: 'companyContact',
            sapCompanyId: company.sapCompanyId,
            hubspotCompanyId: company.hubspotId ?? null,
          },
        });
        continue;
      }

      entries.push({ company, sapContact, contactPayload, sapInternalCode });
    }

    return entries;
  }

  // `values` are the RAW find-property values (not the normalized keys): they
  // travel to HubSpot as batch-read ids / Search IN values. Results are keyed
  // by the normalized value on the way back.
  async readExistingContacts({ values, findProperty, uniqueEntries, clientConfig, tenantModels, getToken }) {
    const existingByKey = new Map();

    if (values.length === 0) {
      return existingByKey;
    }

    const searchProperties = await this.contactHandler.getSearchProperties({ clientConfig, tenantModels });
    const propertyNames = [...new Set([
      findProperty,
      ...searchProperties,
      ...uniqueEntries.flatMap((entry) => Object.keys(entry.contactPayload?.properties ?? {})),
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
            this.crmBatchClient.batchReadObjectsByProperty(token, 'contact', {
              idProperty: findProperty,
              values: valueChunk,
              properties: propertyNames,
            })
          );
          collect(response?.results);
        }
      );
    } catch (error) {
      // idProperty not unique in this portal (or batch read unavailable):
      // fall back to the Search API with IN filters.
      this.logger.error?.('Contact batch read failed, falling back to search:', error);
      existingByKey.clear();
      await runInWaves(
        chunkArray(values, HUBSPOT_BATCH_INPUT_LIMIT),
        SEARCH_FALLBACK_CONCURRENCY,
        async (valueChunk) => {
          const token = await getToken();
          const results = await this.retry(() =>
            this.crmBatchClient.searchObjectsByPropertyIn(token, 'contact', findProperty, valueChunk, propertyNames)
          );
          collect(results);
        }
      );
    }

    return existingByKey;
  }

  async createContactBatches({ createEntries, hubspotIdByKey, sapIdsByKey, findProperty, clientConfig, tenantModels, getToken, contactErrors }) {
    await runInWaves(
      chunkArray(createEntries, writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        try {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchCreateObjects(token, 'contact', {
              inputs: entryChunk.map(({ contactPayload }) => ({ properties: contactPayload.properties })),
            })
          );

          // 207 partial failure: only `results` reached HubSpot, the rest are
          // described by `errors` and must not be reported as synced.
          const { results, errors, failed } = summarizeBatchResponse(response, entryChunk.length);

          // Batch create results are not guaranteed to preserve input order:
          // match by the find property (fall back to positional index).
          const resultByKey = new Map();
          for (const result of results) {
            const key = normalizeKey(result?.properties?.[findProperty]);
            if (key) {
              resultByKey.set(key, result);
            }
          }

          // Positional matching is only sound when every input came back: on a
          // partial response the results are shifted and index i would hand an
          // entry somebody else's HubSpot id.
          const positionalSafe = failed === 0 && results.length === entryChunk.length;

          const mappings = [];
          const seenMappings = new Set();
          const unmatched = [];
          for (const [index, entry] of entryChunk.entries()) {
            const created = resultByKey.get(entry.key)
              ?? (positionalSafe ? results[index] : null);

            if (!created?.id) {
              unmatched.push(entry);
              continue;
            }

            if (entry.key) {
              hubspotIdByKey.set(entry.key, created.id);
            } else {
              entry.hubspotId = created.id;
            }
            for (const sapId of SyncCompanyContactsInBatches.sapIdsForEntry(entry, sapIdsByKey)) {
              const mappingKey = `${sapId}::${created.id}`;
              if (!seenMappings.has(mappingKey)) {
                seenMappings.add(mappingKey);
                mappings.push({ sapId, hubspotId: created.id });
              }
            }
          }

          if (mappings.length > 0) {
            await this.associationRegistry.registerBaseObjectMappings(
              clientConfig.hubspotCredentialId,
              'contact',
              mappings,
              tenantModels
            );
          }

          // A shortfall means HubSpot rejected those inputs: surface them as
          // contact errors instead of silently dropping them.
          if (failed > 0) {
            for (const [index, entry] of unmatched.entries()) {
              const batchError = errors[index] ?? null;
              const error = Object.assign(
                new Error(batchError?.message ?? 'HubSpot batch create partially failed'),
                { details: { status: batchError?.status ?? null, hubspotResponse: batchError } }
              );
              this.logger.error?.('Company contact sync error:', error);
              contactErrors.push(buildContactErrorEntry({
                error,
                sapContactId: entry.sapInternalCode ?? null,
                sapCompanyId: entry.company.sapCompanyId,
                companyHubspotId: entry.company.hubspotId,
                contactPayload: entry.contactPayload,
              }));
            }
          }
        } catch (error) {
          this.logger.error?.('Contact batch create failed, falling back per contact:', error);
          await this.sequentialContactFallback({ entryChunk, hubspotIdByKey, sapIdsByKey, clientConfig, tenantModels, getToken, contactErrors });
        }
      }
    );
  }

  async updateContactBatches({ updateEntries, clientConfig, tenantModels, getToken, contactErrors }) {
    await runInWaves(
      chunkArray(updateEntries, writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (chunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchUpdateObjects(token, 'contact', {
              inputs: chunk.map(({ updateInput }) => updateInput),
            })
          );
        } catch (error) {
          this.logger.error?.('Contact batch update failed, falling back per contact:', error);
          for (const { entry, updateInput } of chunk) {
            try {
              const token = await getToken();
              await this.contactHandler.update({
                token,
                id: updateInput.id,
                existing: { id: updateInput.id },
                item: entry.contactPayload,
                clientConfig,
                tenantModels,
              });
            } catch (contactSyncError) {
              this.logger.error?.('Company contact sync error:', contactSyncError);
              contactErrors.push(buildContactErrorEntry({
                error: contactSyncError,
                sapContactId: entry.sapInternalCode ?? null,
                sapCompanyId: entry.company.sapCompanyId,
                companyHubspotId: entry.company.hubspotId,
                contactPayload: entry.contactPayload,
              }));
            }
          }
        }
      }
    );
  }

  // Degraded path for a failed create chunk: one contact at a time with the
  // same handler the sequential flow uses, isolating individual failures.
  async sequentialContactFallback({ entryChunk, hubspotIdByKey, sapIdsByKey, clientConfig, tenantModels, getToken, contactErrors }) {
    for (const entry of entryChunk) {
      try {
        const token = await getToken();
        const existingContact = await this.contactHandler.find({
          token,
          item: entry.contactPayload,
          clientConfig,
          tenantModels,
        });

        let contactHubspotId = existingContact?.id;

        if (!existingContact) {
          const createdContact = await this.contactHandler.create({
            token,
            item: entry.contactPayload,
            clientConfig,
            tenantModels,
          });
          contactHubspotId = createdContact?.id;
          const sapIds = contactHubspotId
            ? SyncCompanyContactsInBatches.sapIdsForEntry(entry, sapIdsByKey)
            : [];

          if (sapIds.length > 0) {
            await this.associationRegistry.registerBaseObjectMappings(
              clientConfig.hubspotCredentialId,
              'contact',
              sapIds.map((sapId) => ({ sapId, hubspotId: contactHubspotId })),
              tenantModels
            );
          }
        }

        if (contactHubspotId) {
          if (entry.key) {
            hubspotIdByKey.set(entry.key, contactHubspotId);
          } else {
            entry.hubspotId = contactHubspotId;
          }
        }
      } catch (contactSyncError) {
        this.logger.error?.('Company contact sync error:', contactSyncError);
        contactErrors.push(buildContactErrorEntry({
          error: contactSyncError,
          sapContactId: entry.sapInternalCode ?? null,
          sapCompanyId: entry.company.sapCompanyId,
          companyHubspotId: entry.company.hubspotId,
          contactPayload: entry.contactPayload,
        }));
      }
    }
  }

  async associateContactBatches({ entries, hubspotIdByKey, clientConfig, getToken, contactErrors }) {
    const pairs = [];
    const seen = new Set();

    for (const entry of entries) {
      const contactHubspotId = entry.key ? hubspotIdByKey.get(entry.key) : entry.hubspotId;

      if (!contactHubspotId) {
        continue;
      }

      const pairKey = `${entry.company.hubspotId}:${contactHubspotId}`;
      if (seen.has(pairKey)) {
        continue;
      }
      seen.add(pairKey);
      pairs.push({ fromId: entry.company.hubspotId, toId: contactHubspotId, entry });
    }

    await runInWaves(
      chunkArray(pairs, writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (pairChunk) => {
        try {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchAssociateDefault(
              token,
              'company',
              'contact',
              pairChunk.map(({ fromId, toId }) => ({ fromId, toId }))
            )
          );

          // Associations stay non-fatal (parity with the sequential per-pair
          // behavior): a 207 is logged, never counted as a contact error.
          const { errors } = summarizeBatchResponse(response, pairChunk.length);
          for (const batchError of errors) {
            this.logger.error?.('Batch association partial failure', {
              fromObjectType: 'company',
              toObjectType: 'contact',
              error: batchError,
            });
          }
        } catch (error) {
          this.logger.error?.('Batch association failed, falling back per pair:', error);
          for (const { fromId, toId, entry } of pairChunk) {
            try {
              const token = await getToken();
              await this.retry(() =>
                this.crmBatchClient.associateObjects(token, 'company', fromId, 'contact', toId)
              );
            } catch (associationError) {
              this.logger.error?.('Company contact sync error:', associationError);
              contactErrors.push(buildContactErrorEntry({
                error: associationError,
                sapContactId: entry.sapInternalCode ?? null,
                sapCompanyId: entry.company.sapCompanyId,
                companyHubspotId: fromId,
                contactPayload: entry.contactPayload,
              }));
            }
          }
        }
      }
    );
  }
}

export default SyncCompanyContactsInBatches;
