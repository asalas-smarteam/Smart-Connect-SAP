import { jest } from '@jest/globals';
import SyncCompanyContactsInBatches from '../../../src/application/use-cases/SyncCompanyContactsInBatches.js';

function buildUseCase(overrides = {}) {
  return new SyncCompanyContactsInBatches({
    crmBatchClient: {
      batchReadObjectsByProperty: jest.fn().mockResolvedValue({ results: [] }),
      batchCreateObjects: jest.fn().mockImplementation(async (_t, _o, { inputs }) => ({
        results: inputs.map((input, index) => ({
          id: `hs-c-${index}`,
          properties: { ...input.properties },
        })),
      })),
      batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
      batchAssociateDefault: jest.fn().mockResolvedValue({}),
      associateObjects: jest.fn().mockResolvedValue({}),
      searchObjectsByPropertyIn: jest.fn().mockResolvedValue([]),
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
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({ results: [existing] });
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

  it('resolves with a single contactError when both the batch read and the search fallback fail', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockRejectedValue(new Error('batch read down'));
    useCase.crmBatchClient.searchObjectsByPropertyIn.mockRejectedValue(new Error('search down'));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toHaveLength(1);
    expect(contactErrors[0]).toMatchObject({ errorType: 'contactEmployee' });
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
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
