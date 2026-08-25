import { jest } from '@jest/globals';
import SyncCompanyContactsInBatches from '../../../src/application/use-cases/SyncCompanyContactsInBatches.js';

function buildUseCase(overrides = {}) {
  return new SyncCompanyContactsInBatches({
    crmBatchClient: {
      listAllObjects: jest.fn().mockResolvedValue([]),
      listWritablePropertyNames: jest.fn().mockResolvedValue(null),
      batchCreateObjects: jest.fn().mockImplementation(async (_t, _o, { inputs }) => ({
        results: inputs.map((input, index) => ({
          id: `hs-c-${index}`,
          properties: { ...input.properties },
        })),
      })),
      batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
      batchAssociateDefault: jest.fn().mockResolvedValue({}),
      associateObjectsDefault: jest.fn().mockResolvedValue({}),
    },
    contactHandler: {
      getSearchProperties: jest.fn().mockResolvedValue(['email', 'firstname', 'phone', 'idsap', 'internalcode']),
      buildBatchUpdateEntry: jest.fn().mockReturnValue(null),
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-seq' }),
      update: jest.fn().mockResolvedValue(null),
    },
    associationRegistry: {
      findHubspotIdsForSapIds: jest.fn().mockResolvedValue(new Map()),
      registerBaseObjectMappings: jest.fn().mockResolvedValue([]),
    },
    fieldMappingService: {
      getMappingsByObjectType: jest.fn().mockResolvedValue([{ hubspotField: 'firstname' }]),
      mapRecords: jest.fn().mockImplementation(async (records) => records.map((record) => ({
        properties: { firstname: record.Name ?? record.FirstName ?? 'X' },
      }))),
    },
    fallbackEmailGenerator: (companyEmail, code) => (code ? `bp-${code}@fallback.local` : null),
    findPropertyResolver: jest.fn().mockResolvedValue('email'),
    logger: { warn: jest.fn(), error: jest.fn() },
    sleeper: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

const clientConfig = { hubspotCredentialId: 'cred-1' };
const getToken = jest.fn().mockResolvedValue('token-1');

// Tenants map InternalCode -> internalcode, so real payloads carry the identity
// property. Without it a row's primary tier is its email and twins collapse
// instead of both being created -- the opposite of the duplicate case.
function mapRecordsWithIdentity() {
  return {
    getMappingsByObjectType: jest.fn().mockResolvedValue([{ hubspotField: 'internalcode' }]),
    mapRecords: jest.fn().mockImplementation(async (records) => records.map((record) => ({
      properties: {
        internalcode: String(record.InternalCode ?? record.BusinessPartner ?? ''),
        firstname: record.Name ?? record.FirstName ?? 'X',
      },
    }))),
  };
}

describe('SyncCompanyContactsInBatches', () => {
  it('maps all contacts in one pass, batch-creates them, registers mappings and associates', async () => {
    const useCase = buildUseCase();
    const companies = [
      {
        hubspotId: 'hs-co-1',
        item: {
          properties: { idsap: 'C001' },
          rawSapData: {
            CardCode: 'C001',
            EmailAddress: 'c1@x.com',
            ContactEmployees: [
              { InternalCode: 1, Name: 'Ana', E_Mail: 'ana@x.com' },
              { InternalCode: 2, Name: 'Luis', E_Mail: 'luis@x.com' },
            ],
          },
        },
      },
      {
        hubspotId: 'hs-co-2',
        item: {
          properties: { idsap: 'BP2' },
          rawSapData: {
            BusinessPartner: 'BP2',
            _s4Contacts: [{ BusinessPartner: 'BP-P1', FirstName: 'Eva', EmailAddress: 'eva@x.com' }],
          },
        },
      },
    ];

    const { contactErrors } = await useCase.execute({
      companies,
      clientConfig,
      tenantModels: {},
      getToken,
      syncLogId: null,
    });

    expect(contactErrors).toEqual([]);
    expect(useCase.fieldMappingService.mapRecords).toHaveBeenCalledTimes(1);
    expect(useCase.fieldMappingService.getMappingsByObjectType).toHaveBeenCalledTimes(1);
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalledTimes(1);
    expect(useCase.associationRegistry.registerBaseObjectMappings).toHaveBeenCalledTimes(1);
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toMatchObject({ fromId: 'hs-co-1' });
  });

  it('dedupes contacts sharing an email but associates every company', async () => {
    const useCase = buildUseCase();
    const shared = { InternalCode: 9, Name: 'Shared', E_Mail: 'shared@x.com' };
    const companies = [
      { hubspotId: 'hs-co-1', item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [shared] } } },
      { hubspotId: 'hs-co-2', item: { properties: {}, rawSapData: { CardCode: 'C2', ContactEmployees: [shared] } } },
    ];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    const createInputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(createInputs).toHaveLength(1);
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs.map((p) => p.fromId).sort()).toEqual(['hs-co-1', 'hs-co-2']);
  });

  it('updates existing contacts only when the handler says key fields changed', async () => {
    const existing = { id: 'hs-old', properties: { email: 'ana@x.com', firstname: 'Old' } };
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([existing]);
    useCase.contactHandler.buildBatchUpdateEntry.mockReturnValue({ id: 'hs-old', properties: { idsap: 'P1' } });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'ana@x.com' }] } },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchUpdateObjects).toHaveBeenCalledTimes(1);
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toEqual([{ fromId: 'hs-co-1', toId: 'hs-old' }]);
  });

  it('skips contacts without email (not bypassed) and records a warning', async () => {
    const record = jest.fn().mockResolvedValue(null);
    const useCase = buildUseCase({
      syncWarningRepository: { record },
      fallbackEmailGenerator: () => null,
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, Name: 'NoMail' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: 'log-1' });

    expect(contactErrors).toEqual([]);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      code: 'contactEmailMissingSkipped',
      syncLogId: 'log-1',
    }));
  });

  it('falls back to per-contact sequential sync when a create chunk fails', async () => {
    const useCase = buildUseCase();
    // A payload rejection is the case the per-contact path exists to isolate.
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(Object.assign(
      new Error('batch down'),
      { details: { status: 400, hubspotResponse: { category: 'VALIDATION_ERROR' } } }
    ));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.contactHandler.create).toHaveBeenCalledTimes(1);
    expect(contactErrors).toEqual([]);
  });

  it('never degrades a rate-limited create chunk to one request per contact', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(Object.assign(
      new Error('rate limited'),
      { details: { status: 429, hubspotResponse: { errorType: 'RATE_LIMIT' } } }
    ));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // The per-contact path starts with a Search call each, against the very
    // bucket that just rejected the batch.
    expect(useCase.contactHandler.create).not.toHaveBeenCalled();
    expect(useCase.contactHandler.find).not.toHaveBeenCalled();
    expect(contactErrors).toHaveLength(1);
  });

  it('links a conflicting child contact to the id HubSpot named instead of duplicating it', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(Object.assign(
      new Error('conflict'),
      {
        details: {
          status: 409,
          hubspotResponse: {
            category: 'CONFLICT',
            message: 'Contact already exists. Existing ID: 238524122552',
          },
        },
      }
    ));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.contactHandler.create).not.toHaveBeenCalled();
    expect(useCase.associationRegistry.registerBaseObjectMappings).toHaveBeenCalledWith(
      expect.anything(),
      'contact',
      [{ sapId: 1, hubspotId: '238524122552' }],
      expect.anything()
    );
    expect(contactErrors).toEqual([]);
  });

  it('reports two SAP contacts sharing an email as a duplicate report', async () => {
    const record = jest.fn().mockResolvedValue(null);
    const useCase = buildUseCase({
      syncReportRepository: { record },
      fieldMappingService: mapRecordsWithIdentity(),
    });

    // The real shape from production: the same person registered twice in SAP
    // under different internal codes, so both keep their own identity and both
    // are sent to create. HubSpot accepts only the first.
    const companies = [
      {
        hubspotId: 'hs-co-1',
        item: {
          properties: {},
          rawSapData: {
            CardCode: '104188',
            ContactEmployees: [{ InternalCode: 104149, FirstName: 'George', E_Mail: 'george@x.com' }],
          },
        },
      },
      {
        hubspotId: 'hs-co-2',
        item: {
          properties: {},
          rawSapData: {
            CardCode: '103717',
            ContactEmployees: [{ InternalCode: 103669, FirstName: 'George', E_Mail: 'george@x.com' }],
          },
        },
      },
    ];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: 'log-1' });

    expect(record).toHaveBeenCalledTimes(1);
    const { eventType, payload } = record.mock.calls[0][0];
    expect(eventType).toBe('sapDuplicateContactEmailReport');
    expect(payload.summary).toMatchObject({ duplicatedValues: 1, affectedContacts: 2, properties: ['email'] });
    expect(payload.syncLogId).toBe('log-1');
    expect(payload.duplicates[0]).toMatchObject({ property: 'email', value: 'george@x.com' });
    // Both sides are listed: the data team needs to know which row won.
    expect(payload.duplicates[0].contacts.map(({ sapContactId }) => sapContactId).sort())
      .toEqual([103669, 104149]);
  });

  it('records no report when every contact email is unique', async () => {
    const record = jest.fn().mockResolvedValue(null);
    const useCase = buildUseCase({
      syncReportRepository: { record },
      fieldMappingService: mapRecordsWithIdentity(),
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'a@x.com' },
            { InternalCode: 2, E_Mail: 'b@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(record).not.toHaveBeenCalled();
  });

  it('does not report twins that collapse into one contact as duplicates', async () => {
    const record = jest.fn().mockResolvedValue(null);
    const useCase = buildUseCase({
      syncReportRepository: { record },
      fieldMappingService: mapRecordsWithIdentity(),
    });

    // Same InternalCode in two companies: this is the dedupe path, both rows
    // resolve to one contact and nothing is rejected. Reporting it would send
    // the data team after a problem that does not exist.
    const twin = { InternalCode: 9, E_Mail: 'shared@x.com' };
    const companies = [
      { hubspotId: 'hs-co-1', item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [twin] } } },
      { hubspotId: 'hs-co-2', item: { properties: {}, rawSapData: { CardCode: 'C2', ContactEmployees: [twin] } } },
    ];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(record).not.toHaveBeenCalled();
  });

  it('completes the sync when recording the duplicate report throws', async () => {
    const useCase = buildUseCase({
      syncReportRepository: { record: jest.fn().mockRejectedValue(new Error('mongo down')) },
      fieldMappingService: mapRecordsWithIdentity(),
    });

    const companies = [
      { hubspotId: 'hs-co-1', item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'dup@x.com' }] } } },
      { hubspotId: 'hs-co-2', item: { properties: {}, rawSapData: { CardCode: 'C2', ContactEmployees: [{ InternalCode: 2, E_Mail: 'dup@x.com' }] } } },
    ];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toEqual([]);
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalled();
  });

  it('does not report conflict-resolved contacts as unmatched', async () => {
    const useCase = buildUseCase();
    let call = 0;

    // The bisection shape: the full chunk conflicts, one half creates cleanly
    // and the other half is the single conflicting contact.
    useCase.crmBatchClient.batchCreateObjects.mockImplementation(async (_t, _o, { inputs }) => {
      call += 1;

      if (call === 1) {
        throw Object.assign(new Error('conflict'), {
          details: { status: 409, hubspotResponse: { category: 'CONFLICT', message: 'Contact already exists' } },
        });
      }

      if (call === 2) {
        return { results: inputs.map((input, index) => ({ id: `hs-c-${index}`, properties: { ...input.properties } })) };
      }

      throw Object.assign(new Error('conflict'), {
        details: {
          status: 409,
          hubspotResponse: { category: 'CONFLICT', message: 'Contact already exists. Existing ID: 999' },
        },
      });
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'a@x.com' },
            { InternalCode: 2, E_Mail: 'b@x.com' },
          ],
        },
      },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // The conflicting contact was linked, so nothing lost its mapping. Warning
    // about it as unmatched claims a duplicate that does not exist, and that
    // warning is the only signal a real orphan has.
    expect(useCase.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('could not be matched back')
    );
    expect(contactErrors).toEqual([]);
    const linked = useCase.associationRegistry.registerBaseObjectMappings.mock.calls
      .flatMap(([, , mappings]) => mappings)
      .map(({ hubspotId }) => hubspotId);
    expect(linked).toContain('999');
  });

  it('does not attribute a 207 error to a contact it cannot be pinned to', async () => {
    const useCase = buildUseCase();
    // Two inputs, one result, one error: nothing in the response says which
    // input the error belongs to, so neither entry may claim it.
    useCase.crmBatchClient.batchCreateObjects.mockImplementation(async (_t, _o, { inputs }) => ({
      results: [{ id: 'hs-c-0', properties: { ...inputs[0].properties } }],
      errors: [{ status: 'error', message: 'nope', category: 'VALIDATION_ERROR' }],
    }));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'a@x.com' },
            { InternalCode: 2, E_Mail: 'b@x.com' },
          ],
        },
      },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // Exactly the one input HubSpot rejected is reported, and it is reported
    // once -- not once per unmatched entry.
    expect(contactErrors).toHaveLength(1);
    expect(contactErrors[0]).toMatchObject({ errorType: 'contactEmployee', sapCompanyId: 'C1' });
  });

  it('collects contactErrors for contacts that fail even in the sequential fallback', async () => {
    const useCase = buildUseCase();
    // A payload rejection is the case the per-contact path exists to isolate.
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(Object.assign(
      new Error('batch down'),
      { details: { status: 400, hubspotResponse: { category: 'VALIDATION_ERROR' } } }
    ));
    useCase.contactHandler.create.mockRejectedValue(Object.assign(new Error('409'), {
      details: { status: 409, hubspotResponse: { message: 'exists' } },
    }));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toHaveLength(1);
    expect(contactErrors[0]).toMatchObject({
      errorType: 'contactEmployee',
      sapCompanyId: 'C1',
      hubspotCompanyId: 'hs-co-1',
      status: 409,
    });
  });

  it('returns a single contactError when the contact index cannot be built', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockRejectedValue(new Error('list down'));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toHaveLength(1);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
  });

  it('refuses to create when the portal cannot write the identity property', async () => {
    const useCase = buildUseCase();
    // internalcode absent from the allow-list: sanitizeProperties would strip it
    // from every input, HubSpot would echo nothing back to match on, and the
    // next run would find none of them and re-create the whole contact base.
    useCase.crmBatchClient.listWritablePropertyNames.mockResolvedValue(new Set(['email', 'firstname']));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toHaveLength(1);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchUpdateObjects).not.toHaveBeenCalled();
    expect(useCase.contactHandler.create).not.toHaveBeenCalled();
  });

  it('keeps syncing when the allow-list is null, which means the lookup soft-failed', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listWritablePropertyNames.mockResolvedValue(null);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toEqual([]);
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalledTimes(1);
  });

  it('identifies child contacts by internalcode, not by the tenant find property', async () => {
    const useCase = buildUseCase();
    useCase.findPropertyResolver.mockResolvedValue('email');
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-7' } },
    ]);
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([
      { id: 'hs-c-existing', properties: { internalcode: 'IC-7', email: 'otro@x.com' } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 7, E_Mail: 'ana@x.com' }] } },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toEqual([{ fromId: 'hs-co-1', toId: 'hs-c-existing' }]);
  });

  it('matches created child contacts by internalcode regardless of response order', async () => {
    const useCase = buildUseCase();
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-1' } },
      { properties: { firstname: 'Luis', internalcode: 'IC-2' } },
    ]);
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [
        { id: 'hs-luis', properties: { internalcode: 'IC-2' } },
        { id: 'hs-ana', properties: { internalcode: 'IC-1' } },
      ],
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'ana@x.com' },
            { InternalCode: 2, E_Mail: 'luis@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    const [, , mappings] = useCase.associationRegistry.registerBaseObjectMappings.mock.calls[0];
    expect(mappings).toEqual(expect.arrayContaining([
      { sapId: 1, hubspotId: 'hs-ana' },
      { sapId: 2, hubspotId: 'hs-luis' },
    ]));
  });

  it('falls back to the tenant find property for contacts carrying no internalcode', async () => {
    const useCase = buildUseCase({
      findPropertyResolver: jest.fn().mockResolvedValue('idsap'),
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([{ hubspotField: 'idsap' }]),
        mapRecords: jest.fn().mockResolvedValue([{ properties: { idsap: 'C001', email: 'ana@x.com' } }]),
      },
    });
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([
      { id: 'hs-existing', properties: { idsap: 'C001', email: 'ana@x.com' } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C001', ContactEmployees: [{ InternalCode: 1, E_Mail: 'ana@x.com' }] } },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // The existing record was found through the fallback tier, so nothing is created.
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toEqual([{ fromId: 'hs-co-1', toId: 'hs-existing' }]);
  });

  it('sweeps contacts once with the identity, fallback and handler search properties', async () => {
    const useCase = buildUseCase({ findPropertyResolver: jest.fn().mockResolvedValue('idsap') });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.crmBatchClient.listAllObjects).toHaveBeenCalledTimes(1);
    const [, objectType, properties] = useCase.crmBatchClient.listAllObjects.mock.calls[0];
    expect(objectType).toBe('contact');
    expect(properties).toEqual(['internalcode', 'idsap', 'email', 'firstname', 'phone']);
  });

  it('separa con +InternalCode la fila cuyo email ya reclamó otra fila de la corrida', async () => {
    const useCase = buildUseCase();
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-1' } },
      { properties: { firstname: 'Ana again' } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'ana@x.com' },
            { InternalCode: 2, E_Mail: 'ana@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // Antes colapsaban en un solo contacto; ahora la segunda fila conserva su
    // identidad: mismo email en SAP != mismo contacto en HubSpot. La segunda
    // fila no trae internalcode en el payload, así que el sufijo sale de su
    // sapInternalCode (2).
    const inputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.properties.email).sort()).toEqual(['ana+2@x.com', 'ana@x.com']);
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls
      .flatMap((call) => call[2]);
    expect(mappings).toContainEqual({ sapId: 1, hubspotId: 'hs-c-0' });
    expect(mappings).toContainEqual({ sapId: 2, hubspotId: 'hs-c-1' });
  });

  it('creates a row carrying its own distinct internalcode even when an earlier row claimed its email', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([
      { id: 'hs-R1', properties: { internalcode: 'IC-1', email: 'y@x.com' } },
    ]);
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { internalcode: 'IC-1' } },
      { properties: { internalcode: 'IC-2' } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'x@x.com' },
            { InternalCode: 2, E_Mail: 'x@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // IC-1 resolves hs-R1 by identity; IC-2 matches nothing and must NOT be
    // absorbed into hs-R1's group just because IC-1 claimed the shared email.
    const inputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(inputs).toHaveLength(1);
    expect(inputs[0].properties.internalcode).toBe('IC-2');
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls
      .flatMap((call) => call[2]);
    expect(mappings).not.toContainEqual({ sapId: 2, hubspotId: 'hs-R1' });
    expect(mappings).toContainEqual({ sapId: 2, hubspotId: 'hs-c-0' });
  });

  it('keeps two already-existing contacts distinct when they share the fallback email', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([
      { id: 'hs-R1', properties: { internalcode: 'IC-1', email: 'shared@x.com' } },
      { id: 'hs-R2', properties: { internalcode: 'IC-2', email: 'shared@x.com' } },
    ]);
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { internalcode: 'IC-1' } },
      { properties: { internalcode: 'IC-2' } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'shared@x.com' },
            { InternalCode: 2, E_Mail: 'shared@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toEqual(expect.arrayContaining([
      { fromId: 'hs-co-1', toId: 'hs-R1' },
      { fromId: 'hs-co-1', toId: 'hs-R2' },
    ]));
    expect(pairs).toHaveLength(2);
  });

  it('warns when a clean create batch echoes back no internalcode to match on', async () => {
    const useCase = buildUseCase();
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-1' } },
    ]);
    // internalcode is not writable in this portal, so HubSpot creates the
    // contact but echoes nothing to match it back on — and reports no failure.
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [{ id: 'hs-c-0', properties: { firstname: 'Ana' } }],
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'ana@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toEqual([]);
    expect(useCase.logger.warn).toHaveBeenCalledWith(expect.stringContaining('internalcode'));
  });

  it('drops properties the portal cannot write from the create payload', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listWritablePropertyNames.mockResolvedValue(new Set(['email', 'firstname', 'internalcode']));
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-1', ghost: 'x', empty: null } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'ana@x.com' }] } },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    const inputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(inputs[0].properties).toEqual({ firstname: 'Ana', internalcode: 'IC-1', email: 'ana@x.com' });
  });

  it('keeps syncing when the writable property lookup fails', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listWritablePropertyNames.mockRejectedValue(new Error('properties down'));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toEqual([]);
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalledTimes(1);
  });

  it('records a contactError for the entries a 207 create batch rejected', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [{ id: 'hs-c-0', properties: { email: 'ana@x.com' } }],
      numErrors: 1,
      errors: [{ status: 'error', message: 'Email address is invalid' }],
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'ana@x.com' },
            { InternalCode: 2, E_Mail: 'bad@x.com' },
          ],
        },
      },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toHaveLength(1);
    expect(contactErrors[0]).toMatchObject({
      errorType: 'contactEmployee',
      sapContactId: 2,
      sapCompanyId: 'C1',
      hubspotCompanyId: 'hs-co-1',
      message: 'Email address is invalid',
    });
    // Only the created contact is registered and associated.
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls[0][2];
    expect(mappings).toEqual([{ sapId: 1, hubspotId: 'hs-c-0' }]);
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toEqual([{ fromId: 'hs-co-1', toId: 'hs-c-0' }]);
  });

  it('creates nothing when the contactEmployee mappings produce no mapped contacts', async () => {
    const useCase = buildUseCase({
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([]),
        mapRecords: jest.fn().mockResolvedValue([]),
      },
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toEqual([]);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.listAllObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchAssociateDefault).not.toHaveBeenCalled();
    expect(useCase.logger.warn).toHaveBeenCalled();
  });

  it('honors hubspotBatchSize for create batches and retries a 429 in the per-pair association fallback', async () => {
    const useCase = buildUseCase();
    // Unique ids per email so the two contacts do not collapse into one pair.
    useCase.crmBatchClient.batchCreateObjects.mockImplementation(async (_t, _o, { inputs }) => ({
      results: inputs.map((input) => ({ id: `hs-${input.properties.email}`, properties: { ...input.properties } })),
    }));
    useCase.crmBatchClient.batchAssociateDefault.mockRejectedValue(new Error('associate down'));
    const rateLimited = Object.assign(new Error('rate limited'), { response: { status: 429 } });
    useCase.crmBatchClient.associateObjectsDefault
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce({});

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'a@x.com' },
            { InternalCode: 2, E_Mail: 'b@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({
      companies,
      clientConfig: { ...clientConfig, hubspotBatchSize: 1 },
      tenantModels: {},
      getToken,
      syncLogId: null,
    });

    // 2 contacts, batch size 1 -> one create call and one associate call each.
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalledTimes(2);
    expect(useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs).toHaveLength(1);
    expect(useCase.crmBatchClient.batchAssociateDefault).toHaveBeenCalledTimes(2);
    expect(useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3]).toHaveLength(1);
    // Per-pair fallback goes through retry(): the 429 is retried, not reported.
    // 2 pairs + 1 retry of the rate-limited one.
    expect(useCase.sleeper).toHaveBeenCalled();
    expect(useCase.crmBatchClient.associateObjectsDefault).toHaveBeenCalledTimes(3);
  });

  it('separa con +InternalCode dos CE de empresas distintas que comparten email', async () => {
    const useCase = buildUseCase();
    const companies = [
      {
        hubspotId: 'hs-co-1',
        item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 9, E_Mail: 'shared@x.com' }] } },
      },
      {
        hubspotId: 'hs-co-2',
        item: { properties: {}, rawSapData: { CardCode: 'C2', ContactEmployees: [{ InternalCode: 10, E_Mail: 'shared@x.com' }] } },
      },
    ];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // Antes colapsaban en un solo contacto porque compartían el email (tier de
    // fallback, sin internalcode mapeado); ahora son DOS CE con InternalCode
    // distinto (9 y 10) -- mismo email en SAP no es el mismo contacto -- y el
    // segundo entra con +InternalCode.
    const inputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.properties.email).sort()).toEqual(['shared+10@x.com', 'shared@x.com']);
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls
      .flatMap((call) => call[2]);
    expect(mappings).toContainEqual({ sapId: 9, hubspotId: 'hs-c-0' });
    expect(mappings).toContainEqual({ sapId: 10, hubspotId: 'hs-c-1' });
  });
});
