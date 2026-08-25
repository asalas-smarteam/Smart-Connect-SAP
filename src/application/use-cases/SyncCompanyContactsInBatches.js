import {
  applyBypassEmail,
  resolveBypassEmail,
} from '#application/services/bypassEmail.service.js';
import { buildCompanyContactPayload } from '#application/services/companyContactPayload.service.js';
import {
  claimEmail,
  resolveContactEmployeeEmail,
} from '#application/services/contactEmployeeIdentity.service.js';
import { CrmObjectIndex, normalizeIndexKey, uniquePropertiesFor } from '#application/services/crmObjectIndex.service.js';
import { buildDuplicateContactEmailReport } from '#application/services/duplicateContactEmail.report.js';
import { sanitizeProperties } from '#application/services/hubspotPropertyPayload.service.js';
import {
  BATCH_CONCURRENCY,
  chunkArray,
  createWithConflictSplit,
  retryRequest,
  runInWaves,
  summarizeBatchResponse,
  writeChunkSize,
} from '#application/services/hubspotBatching.utils.js';
import { BATCH_FAILURE, classifyBatchFailure } from '#application/services/hubspotBatchFailure.service.js';
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
    syncReportRepository = null,
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
    this.syncReportRepository = syncReportRepository;
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

  // Same contract as recordWarning: a reporting failure must never break a run.
  async recordDuplicateContactEmailReport({ collisions, tenantModels, clientConfigId, syncLogId }) {
    const report = buildDuplicateContactEmailReport({ collisions, clientConfigId, syncLogId });

    if (!report) {
      return null;
    }

    const { duplicatedValues, affectedContacts } = report.payload.summary;
    this.logger.warn?.(
      `Duplicate contact emails in SAP: ${affectedContacts} contact(s) share ${duplicatedValues} value(s); `
      + `HubSpot can keep only one of each. Report stored as ${report.eventType}.`
    );

    if (!this.syncReportRepository?.record) {
      return null;
    }

    try {
      return await this.syncReportRepository.record({ tenantModels, ...report });
    } catch (error) {
      this.logger.error?.('Sync report record error:', error);
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

  async execute({ companies, clientConfig, tenantModels, getToken, syncLogId = null, parentObjectType = 'company' }) {
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

    let index;
    let fallbackProperty = null;
    try {
      // Inside the try: a rejecting resolver must not break execute's "never
      // rejects" contract either.
      fallbackProperty = await this.findPropertyResolver({ tenantModels });
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

    // If the portal cannot write the identity property (never seeded, archived,
    // or read-only), sanitizeProperties would strip it from every create input.
    // HubSpot would then create contacts carrying no identity, echo nothing to
    // match back, and the NEXT run would find none of them and create them all
    // again -- mass duplication, silently. A null allow-list means the catalog
    // lookup soft-failed, not that the property is missing.
    if (writableProperties && !writableProperties.has(this.identityProperty)) {
      const error = new Error(
        `Contact identity property "${this.identityProperty}" is not writable in this portal; refusing to create unmatched contacts`
      );
      this.logger.error?.('Company contact batch sync error:', error);
      contactErrors.push(buildContactErrorEntry({ error }));
      return { contactErrors };
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
    // Claim key -> the SAP contacts that carried the value, first one first.
    // Feeds the duplicate report below.
    const collisions = new Map();
    // Emails reclamados en ESTA corrida, para la regla +InternalCode.
    const claimedEmails = new Map();

    for (const entry of entries) {
      const properties = entry.contactPayload?.properties;

      // Resolución de email duplicado ANTES de find(): con el email ya
      // resuelto, el tier único de email solo matchea cuando es el mismo
      // contacto, y la fila que hoy va a un create condenado al 409 llega con
      // +InternalCode y entra.
      if (properties?.email) {
        const cleanEmail = properties.email;
        const emailKey = normalizeIndexKey(cleanEmail);
        const ownerRecord = claimedEmails.has(emailKey) ? null : index.emailOwner(cleanEmail);
        const owner = ownerRecord
          ? { internalcode: ownerRecord.properties?.internalcode }
          : null;
        const ceCode = properties.internalcode ?? entry.sapInternalCode;

        const resolvedEmail = resolveContactEmployeeEmail({
          email: cleanEmail,
          internalCode: ceCode,
          owner,
          claimedEmails,
        });

        if (resolvedEmail !== cleanEmail) {
          this.logger.warn?.('Contact employee con email duplicado: se aplica plus addressing', {
            sapInternalCode: entry.sapInternalCode,
            cleanEmail,
            resolvedEmail,
          });
          properties.email = resolvedEmail;
          // El email limpio sigue duplicado EN SAP: el reporte de calidad de
          // datos lo tiene que seguir mostrando aunque el sync ya lo resuelva.
          collisions.get(`email:${emailKey}`)?.entries.push(entry);
        }

        claimEmail(claimedEmails, resolvedEmail, ceCode);
      }

      const existing = index.find(properties);
      const claims = this.dedupeClaims(properties, fallbackProperty);
      const claimKeys = claims.map(({ key }) => key);

      // A resolved record wins over the claims: two rows with distinct
      // identities that already exist as distinct HubSpot records must stay
      // distinct even when they share the fallback value.
      let key = null;
      if (existing) {
        // `#` cannot start a HubSpot property name, so this can never collide
        // with a namespaced claim key.
        key = `#hs:${existing.id}`;
      } else {
        // Only the row's OWN primary tier can absorb it. A row carrying a
        // distinct, unclaimed internalcode is a DIFFERENT contact even when it
        // shares an email with an earlier row: absorbing it there would drop
        // its write and register its SAP id against somebody else's record. It
        // is created instead, and a duplicate-email 409 surfaces as an honest
        // contactError. A row with no identity of its own has the fallback key
        // as its primary tier, so it still collapses onto the earlier row.
        const primaryKey = claimKeys[0] ?? null;
        key = primaryKey && claimedBy.has(primaryKey)
          ? claimedBy.get(primaryKey)
          : primaryKey;
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
      for (const [tier, { key: claimKey, property, value }] of claims.entries()) {
        const owner = claimedBy.get(claimKey);

        if (owner === undefined) {
          claimedBy.set(claimKey, key);
          if (!collisions.has(claimKey)) {
            collisions.set(claimKey, { property, value, entries: [entry] });
          }
          continue;
        }

        if (owner === key || tier === 0) {
          // Same group: the twin this row collapses into. A primary-tier clash
          // always lands here -- `key` was resolved to the owner above -- so it
          // is a dedupe, not a conflict, and there is nothing to report.
          continue;
        }

        // A different contact already owns this value, and the clash is on a
        // non-primary tier: this row keeps its own identity and will be sent to
        // create, where HubSpot's uniqueness rule rejects it. That is a duplicate
        // in SAP, not something the sync can resolve.
        collisions.get(claimKey)?.entries.push(entry);
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

    // Persisted before the writes, not after: the report describes the SAP data
    // and stays true whether or not the HubSpot calls succeed.
    await this.recordDuplicateContactEmailReport({
      collisions,
      tenantModels,
      clientConfigId,
      syncLogId,
    });

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
    await this.associateContactBatches({ entries, hubspotIdByKey, clientConfig, getToken, contactErrors, parentObjectType });

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
    return this.dedupeClaims(properties, fallbackProperty).map(({ key }) => key);
  }

  // Same list as dedupeKeys, with the property and value kept apart so a
  // collision can name which property two contacts collided on. Order is
  // significant: index 0 is the row's OWN primary tier.
  dedupeClaims(properties, fallbackProperty) {
    const claims = [];
    const claim = (property) => {
      const value = normalizeIndexKey(properties?.[property]);
      if (value) {
        claims.push({ property, value, key: `${property}:${value}` });
      }
    };

    claim(this.identityProperty);

    if (fallbackProperty && fallbackProperty !== this.identityProperty) {
      claim(fallbackProperty);
    }

    // Two child contacts sharing an email cannot both be created: HubSpot rejects
    // the second. Claiming the email collapses them instead.
    for (const name of uniquePropertiesFor('contact')) {
      if (name === this.identityProperty || name === fallbackProperty) {
        continue;
      }

      claim(name);
    }

    return claims;
  }

  // One sweep of every contact of the portal, indexed in memory: existence
  // checks become Map lookups instead of per-value API calls. See the plan's
  // evidence section for why batch/read and Search cannot do this job.
  async buildIndex({ fallbackProperty, clientConfig, tenantModels, getToken }) {
    const searchProperties = await this.contactHandler.getSearchProperties({ clientConfig, tenantModels });
    // Child contacts are identified by internalcode, but HubSpot still enforces
    // email uniqueness across every contact in the portal. Without this tier a
    // child contact whose email already belongs to some other contact is sent
    // down the create path to earn a guaranteed 409.
    const uniqueProperties = uniquePropertiesFor('contact');
    const properties = [...new Set([
      this.identityProperty,
      fallbackProperty,
      ...uniqueProperties,
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
      uniqueProperties,
    });
  }

  async createContactBatches({ createEntries, hubspotIdByKey, sapIdsByKey, index, fallbackProperty, writableProperties, clientConfig, tenantModels, getToken, contactErrors }) {
    await runInWaves(
      chunkArray(createEntries, writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        let outcome;

        try {
          const token = await getToken();
          // Conflicts are isolated by halving rather than by dropping to one
          // request per contact: this is the path that produced most of the
          // Search-bucket 429s, and per contact it would also lose the other 99.
          outcome = await createWithConflictSplit(entryChunk, {
            send: (chunk) => this.crmBatchClient.batchCreateObjects(token, 'contact', {
              inputs: chunk.map(({ contactPayload }) => ({
                properties: sanitizeProperties(contactPayload.properties, writableProperties),
              })),
            }, { expectedStatuses: [409] }),
          });
        } catch (error) {
          // Only a failure outside the batch call itself (the token lookup).
          this.recordContactChunkFailure({ entries: entryChunk, error, failure: 'fatal', contactErrors, phase: 'create' });
          return;
        }

        {
          // 207 partial failure: only `results` reached HubSpot, the rest are
          // described by `errors` and must not be reported as synced.
          const results = outcome.responses.flatMap((response) => (
            Array.isArray(response?.results) ? response.results : []
          ));
          const errors = outcome.responses.flatMap((response) => (
            Array.isArray(response?.errors) ? response.errors : []
          ));
          const failed = errors.length;

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

          // Bisection means only part of the chunk went through `responses`: the
          // rest are conflicts (linked below) or failed sub-chunks (reported
          // below). Walking the whole chunk here would file them as unmatched,
          // and that warning is the only signal a genuine orphan has -- diluting
          // it with entries that were handled correctly makes it worthless.
          const handledElsewhere = new Set([
            ...outcome.conflicts.map(({ entry }) => entry),
            ...outcome.failed.flatMap(({ entries }) => entries),
          ]);

          const mappings = [];
          const seenMappings = new Set();
          const unmatched = [];
          for (const entry of entryChunk) {
            if (handledElsewhere.has(entry)) continue;

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

            // Forward-looking insurance only: chunks are fixed before the wave
            // and nothing calls find() afterwards, so this does not protect a
            // later chunk today. It keeps the index truthful for any future
            // caller that does look something up after the create wave.
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

          // Unconditional: an unmatched entry with failed === 0 means HubSpot
          // created the contact but echoed nothing to match it back on (e.g.
          // the identity property is not writable in this portal, so
          // sanitizeProperties stripped it). Those contacts silently lose their
          // registry rows and association pairs, so it must never go unlogged.
          if (unmatched.length > 0) {
            this.logger.warn?.(`Batch create: ${unmatched.length} contact(s) could not be matched back by ${this.identityProperty}`);
          }

          // A shortfall means HubSpot rejected those inputs: surface them as
          // contact errors instead of silently dropping them.
          if (failed > 0) {
            // A batch error echoes nothing that identifies its input, so pairing
            // by position is only defensible when the two lists describe the same
            // set. Otherwise the entry is still reported -- it did not land -- but
            // without pinning someone else's error to it.
            const pairable = unmatched.length === errors.length;

            for (const [position, entry] of unmatched.entries()) {
              const batchError = pairable ? (errors[position] ?? null) : null;
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
        }

        // A conflict means the contact already existed and the index missed it.
        // Linking it to the id HubSpot named is what repairs the identity, and it
        // costs no extra request. No properties are written: a conflict response
        // carries none to diff against.
        for (const { entry, existingId } of outcome.conflicts) {
          if (!existingId) {
            this.recordContactChunkFailure({
              entries: [entry],
              error: Object.assign(new Error('Contact already exists but HubSpot named no id'), {
                details: { status: 409, hubspotResponse: { category: 'CONFLICT' } },
              }),
              failure: BATCH_FAILURE.CONFLICT,
              contactErrors,
              phase: 'create',
            });
            continue;
          }

          this.logger.warn?.(`Contact already existed in HubSpot as ${existingId}; linking instead of creating`);

          if (entry.key) {
            hubspotIdByKey.set(entry.key, existingId);
          } else {
            entry.hubspotId = existingId;
          }

          const conflictMappings = SyncCompanyContactsInBatches
            .sapIdsForEntry(entry, sapIdsByKey)
            .map((sapId) => ({ sapId, hubspotId: existingId }));

          if (conflictMappings.length > 0) {
            await this.associationRegistry.registerBaseObjectMappings(
              clientConfig.hubspotCredentialId,
              'contact',
              conflictMappings,
              tenantModels
            );
          }
        }

        for (const { entries, failure, error } of outcome.failed) {
          if (failure === BATCH_FAILURE.PAYLOAD) {
            // The one case going per contact can isolate: a single bad property
            // rejected every input in the chunk.
            this.logger.error?.('Contact batch create rejected on payload, isolating per contact:', error);
            await this.sequentialContactFallback({ entryChunk: entries, hubspotIdByKey, sapIdsByKey, clientConfig, tenantModels, getToken, contactErrors });
            continue;
          }

          // Rate limits, unknown outcomes and fatals must not fan out: the
          // per-contact path spends a Search call each, against the bucket that
          // just rejected us.
          this.recordContactChunkFailure({ entries, error, failure, contactErrors, phase: 'create' });
        }
      }
    );
  }

  // Reports every entry of a chunk as failed WITHOUT issuing a request per entry.
  recordContactChunkFailure({ entries, error, failure, contactErrors, phase }) {
    this.logger.error?.(`Contact batch ${phase} failed (${failure}), not degrading per contact:`, error);

    for (const entry of entries) {
      contactErrors.push(buildContactErrorEntry({
        error,
        sapContactId: entry.sapInternalCode ?? null,
        sapCompanyId: entry.company.sapCompanyId,
        companyHubspotId: entry.company.hubspotId,
        contactPayload: entry.contactPayload,
      }));
    }
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
          const failure = classifyBatchFailure(error);

          if (failure !== BATCH_FAILURE.PAYLOAD) {
            // An update is replayable, so the transport already retried it. Only
            // a payload rejection gains anything from going per contact.
            this.recordContactChunkFailure({
              entries: chunk.map(({ entry }) => entry),
              error,
              failure,
              contactErrors,
              phase: 'update',
            });
            return;
          }

          this.logger.error?.('Contact batch update rejected on payload, isolating per contact:', error);
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

  async associateContactBatches({ entries, hubspotIdByKey, clientConfig, getToken, contactErrors, parentObjectType = 'company' }) {
    const pairs = [];
    const seen = new Set();

    for (const entry of entries) {
      const contactHubspotId = entry.key ? hubspotIdByKey.get(entry.key) : entry.hubspotId;

      if (!contactHubspotId) {
        continue;
      }

      // Guarda de auto-asociación: con un padre contact, un ContactEmployee
      // puede resolver al MISMO contacto de HubSpot (mismo email). Con un
      // padre company esa comparación es pura coincidencia numérica entre dos
      // espacios de ids distintos (company vs contact) y NUNCA debe descartar
      // una asociación legítima.
      if (parentObjectType === 'contact' && String(contactHubspotId) === String(entry.company.hubspotId)) {
        this.logger.warn?.('Se descarta la auto-asociacion de un contacto consigo mismo', {
          parentObjectType,
          hubspotId: contactHubspotId,
          sapContactId: entry.sapInternalCode ?? null,
        });
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
              parentObjectType,
              'contact',
              pairChunk.map(({ fromId, toId }) => ({ fromId, toId }))
            )
          );

          // Associations stay non-fatal (parity with the sequential per-pair
          // behavior): a 207 is logged, never counted as a contact error.
          const { errors } = summarizeBatchResponse(response, pairChunk.length);
          for (const batchError of errors) {
            this.logger.error?.('Batch association partial failure', {
              fromObjectType: parentObjectType,
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
                this.crmBatchClient.associateObjectsDefault(token, parentObjectType, fromId, 'contact', toId)
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
