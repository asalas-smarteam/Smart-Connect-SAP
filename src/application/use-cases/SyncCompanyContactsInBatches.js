import {
  applyBypassEmail,
  resolveBypassEmail,
} from '#application/services/bypassEmail.service.js';
import { buildCompanyContactPayload } from '#application/services/companyContactPayload.service.js';
import { CrmObjectIndex, normalizeIndexKey } from '#application/services/crmObjectIndex.service.js';
import { sanitizeProperties } from '#application/services/hubspotPropertyPayload.service.js';
import {
  BATCH_CONCURRENCY,
  chunkArray,
  retryRequest,
  runInWaves,
  summarizeBatchResponse,
  writeChunkSize,
} from '#application/services/hubspotBatching.utils.js';
import { buildContactErrorEntry } from '#application/use-cases/HandleHubspotAssociations.js';

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
    identityProperty = 'internalcode',
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
    // Fallback resolver: the tenant's configured defaultFindHubspot property,
    // only consulted when the identity property finds nothing.
    this.findPropertyResolver = findPropertyResolver;
    // Child contacts carry their SAP InternalCode / person BusinessPartner in
    // this HubSpot property: it is the identity, not the tenant-wide find one.
    this.identityProperty = identityProperty;
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

    const fallbackProperty = await this.findPropertyResolver({ tenantModels });

    let index;
    try {
      index = await this.buildIndex({ fallbackProperty, clientConfig, tenantModels, getToken });
    } catch (readError) {
      // Without the index we cannot tell creates from updates; creating blindly
      // would duplicate the contact base. A throwing sweep means "index
      // unavailable", never "no contact exists", so we abort with a single
      // error entry rather than rejecting the caller's { contactErrors }.
      this.logger.error?.('Company contact batch sync error:', readError);
      contactErrors.push(buildContactErrorEntry({ error: readError }));
      return { contactErrors };
    }

    // Fails soft, unlike the index: a null allow-list still strips nulls, and
    // if an unknown property then triggers a batch-wide 400 the per-chunk catch
    // degrades only that chunk. Throwing away a good sweep costs far more.
    let writableProperties = null;
    try {
      const token = await getToken();
      writableProperties = await this.retry(() =>
        this.crmBatchClient.listWritablePropertyNames(token, 'contact')
      );
    } catch (propertyError) {
      this.logger.warn?.('Contact writable property lookup failed, sending unfiltered payloads:', propertyError);
    }

    // Entries resolving to the same contact collapse into one write; every
    // company still gets its association pair and every twin SAP id is still
    // registered. `entry.key` is the group id shared by the collapsed twins.
    const byKey = new Map();
    const existingByKey = new Map();
    const sapIdsByKey = new Map();
    // Namespaced tier key -> group id, so a row carrying only the fallback
    // value cannot create a duplicate of a row that also carried an identity.
    const claimedBy = new Map();

    for (const entry of entries) {
      const properties = entry.contactPayload?.properties;
      const existing = index.find(properties);
      const claimKeys = this.dedupeKeys(properties, fallbackProperty);

      // A resolved record wins over the claims: two rows with distinct
      // identities that already exist as distinct HubSpot records must stay
      // distinct even when they share the fallback value.
      let key = null;
      if (existing) {
        // `#` cannot start a HubSpot property name, so this can never collide
        // with a namespaced claim key.
        key = `#hs:${existing.id}`;
      } else {
        const claimed = claimKeys.find((claimKey) => claimedBy.has(claimKey));
        key = claimed ? claimedBy.get(claimed) : (claimKeys[0] ?? null);
      }
      entry.key = key;

      if (!key) {
        // No identity and no fallback value (e.g. bypassed email with
        // fallbackProperty=email): nothing can ever match it, so it is always
        // created and never deduped.
        entry.alwaysCreate = true;
        continue;
      }

      // ALL tiers are claimed, not just the winning one.
      for (const claimKey of claimKeys) {
        if (!claimedBy.has(claimKey)) {
          claimedBy.set(claimKey, key);
        }
      }

      if (!byKey.has(key)) {
        byKey.set(key, entry);
        if (existing) {
          existingByKey.set(key, existing);
        }
      }

      // Deduping collapses twins, but every twin's SAP id still needs its own
      // registry row — otherwise the next run cannot resolve the dropped code
      // and would create a duplicate contact.
      if (entry.sapInternalCode) {
        if (!sapIdsByKey.has(key)) {
          sapIdsByKey.set(key, new Set());
        }
        sapIdsByKey.get(key).add(entry.sapInternalCode);
      }
    }

    const uniqueEntries = [...byKey.values(), ...entries.filter((entry) => entry.alwaysCreate)];

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

    await this.createContactBatches({ createEntries, hubspotIdByKey, sapIdsByKey, index, fallbackProperty, writableProperties, clientConfig, tenantModels, getToken, contactErrors });
    await this.updateContactBatches({ updateEntries, writableProperties, clientConfig, tenantModels, getToken, contactErrors });
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

  // Every value index.find() could match this row on, namespaced by property so
  // an internalcode of `x` cannot claim the same slot as an email of `x`. BOTH
  // tiers are returned, not just the winning one: a row carrying only the
  // fallback value would otherwise duplicate a row that also carried an
  // identity. An empty array means nothing can ever match this row.
  dedupeKeys(properties, fallbackProperty) {
    const keys = [];

    const identity = normalizeIndexKey(properties?.[this.identityProperty]);
    if (identity) {
      keys.push(`${this.identityProperty}:${identity}`);
    }

    if (fallbackProperty && fallbackProperty !== this.identityProperty) {
      const fallback = normalizeIndexKey(properties?.[fallbackProperty]);
      if (fallback) {
        keys.push(`${fallbackProperty}:${fallback}`);
      }
    }

    return keys;
  }

  // One sweep of every contact of the portal, indexed in memory: existence
  // checks become Map lookups instead of per-value API calls. See the plan's
  // evidence section for why batch/read and Search cannot do this job.
  async buildIndex({ fallbackProperty, clientConfig, tenantModels, getToken }) {
    const searchProperties = await this.contactHandler.getSearchProperties({ clientConfig, tenantModels });
    const properties = [...new Set([
      this.identityProperty,
      fallbackProperty,
      ...searchProperties,
    ].filter(Boolean))].filter((name) => name !== 'hs_object_id' && name !== 'associations');

    const token = await getToken();
    // No retry wrapper here: listAllObjects retries each page internally, so
    // retrying at this level would re-issue the entire sweep.
    const records = await this.crmBatchClient.listAllObjects(token, 'contact', properties);

    this.logger.info?.(`Contact index built for company child contacts: ${records.length} records`);

    return new CrmObjectIndex({
      records,
      identityProperty: this.identityProperty,
      fallbackProperty,
    });
  }

  async createContactBatches({ createEntries, hubspotIdByKey, sapIdsByKey, index, fallbackProperty, writableProperties, clientConfig, tenantModels, getToken, contactErrors }) {
    await runInWaves(
      chunkArray(createEntries, writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        try {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchCreateObjects(token, 'contact', {
              inputs: entryChunk.map(({ contactPayload }) => ({
                properties: sanitizeProperties(contactPayload.properties, writableProperties),
              })),
            })
          );

          // 207 partial failure: only `results` reached HubSpot, the rest are
          // described by `errors` and must not be reported as synced.
          const { results, errors, failed } = summarizeBatchResponse(response, entryChunk.length);

          // HubSpot does not preserve input order in batch/create responses, so
          // a property echoed back is the only sound match — never positional.
          // Two maps for the two tiers index.find() matches on.
          const resultByIdentity = new Map();
          const resultByFallback = new Map();
          const useFallbackTier = Boolean(fallbackProperty) && fallbackProperty !== this.identityProperty;

          for (const result of results) {
            const identityKey = normalizeIndexKey(result?.properties?.[this.identityProperty]);
            if (identityKey && !resultByIdentity.has(identityKey)) {
              resultByIdentity.set(identityKey, result);
            }

            if (useFallbackTier) {
              const fallbackKey = normalizeIndexKey(result?.properties?.[fallbackProperty]);
              if (fallbackKey && !resultByFallback.has(fallbackKey)) {
                resultByFallback.set(fallbackKey, result);
              }
            }
          }

          const mappings = [];
          const seenMappings = new Set();
          const unmatched = [];
          for (const entry of entryChunk) {
            const properties = entry.contactPayload?.properties;
            const identityKey = normalizeIndexKey(properties?.[this.identityProperty]);
            // Fallback tier only for rows with no identity value: it is the
            // same key index.find() would match them on, so it is exactly as
            // safe, and without it these rows lose their associations too.
            const created = identityKey
              ? resultByIdentity.get(identityKey)
              : (useFallbackTier
                ? resultByFallback.get(normalizeIndexKey(properties?.[fallbackProperty]))
                : undefined);

            if (!created?.id) {
              unmatched.push(entry);
              continue;
            }

            // Keeps the index truthful for anything that looks a contact up
            // after this wave.
            index.add(created);

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
            for (const [position, entry] of unmatched.entries()) {
              const batchError = errors[position] ?? null;
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

  async updateContactBatches({ updateEntries, writableProperties, clientConfig, tenantModels, getToken, contactErrors }) {
    await runInWaves(
      chunkArray(updateEntries, writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (chunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchUpdateObjects(token, 'contact', {
              inputs: chunk.map(({ updateInput }) => ({
                id: updateInput.id,
                properties: sanitizeProperties(updateInput.properties, writableProperties),
              })),
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
