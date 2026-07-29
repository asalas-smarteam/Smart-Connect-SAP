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
      associateObjects: jest.fn().mockResolvedValue({}),
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
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(new Error('batch down'));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.contactHandler.create).toHaveBeenCalledTimes(1);
    expect(contactErrors).toEqual([]);
  });

  it('collects contactErrors for contacts that fail even in the sequential fallback', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(new Error('batch down'));
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

  it('does not create a second contact for a row whose email an internalcode row already claimed', async () => {
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

    expect(useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs).toHaveLength(1);
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls[0][2];
    expect(mappings).toEqual(expect.arrayContaining([
      { sapId: 1, hubspotId: 'hs-c-0' },
      { sapId: 2, hubspotId: 'hs-c-0' },
    ]));
    expect(mappings).toHaveLength(2);
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
    useCase.crmBatchClient.associateObjects
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
    expect(useCase.crmBatchClient.associateObjects).toHaveBeenCalledTimes(3);
  });

  it('registers a mapping for every SAP internal code sharing a deduped contact', async () => {
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

    expect(useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs).toHaveLength(1);
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls[0][2];
    expect(mappings).toEqual(expect.arrayContaining([
      { sapId: 9, hubspotId: 'hs-c-0' },
      { sapId: 10, hubspotId: 'hs-c-0' },
    ]));
    expect(mappings).toHaveLength(2);
  });
});
