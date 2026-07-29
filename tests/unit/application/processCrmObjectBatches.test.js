import { jest } from '@jest/globals';
import ProcessCrmObjectBatches from '../../../src/application/use-cases/ProcessCrmObjectBatches.js';

function buildCompanyHandler() {
  return {
    preprocess: undefined,
    getSearchProperties: jest.fn().mockResolvedValue(['email', 'name', 'phone', 'idsap']),
    buildBatchUpdateEntry: jest.fn().mockReturnValue(null),
  };
}

function buildUseCase(overrides = {}) {
  return new ProcessCrmObjectBatches({
    crmBatchClient: {
      batchReadObjectsByProperty: jest.fn().mockResolvedValue({ results: [] }),
      batchCreateObjects: jest.fn().mockImplementation(async (_t, _o, { inputs }) => ({
        results: inputs.map((input, index) => ({ id: `hs-${index}`, properties: { ...input.properties } })),
      })),
      batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
      batchAssociateDefault: jest.fn().mockResolvedValue({}),
      associateObjects: jest.fn().mockResolvedValue({}),
      searchObjectsByPropertyIn: jest.fn().mockResolvedValue([]),
    },
    associationRegistry: {
      findHubspotIdsForSapIds: jest.fn().mockResolvedValue(new Map()),
      registerBaseObjectMappings: jest.fn().mockResolvedValue([]),
    },
    sapHubspotIdUpdater: {
      updateBusinessPartnerInSapFromHubspot: jest.fn().mockResolvedValue(null),
    },
    validationFailureWriter: { write: jest.fn().mockResolvedValue(null) },
    findPropertyResolver: jest.fn().mockResolvedValue('email'),
    syncCompanyContactsInBatches: { execute: jest.fn().mockResolvedValue({ contactErrors: [] }) },
    logger: { warn: jest.fn(), error: jest.fn() },
    sleeper: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

const clientConfig = { hubspotCredentialId: 'cred-1', hubspotBatchSize: 100 };
const getToken = jest.fn().mockResolvedValue('token-1');

function baseParams(useCaseOverrides = {}) {
  return {
    objectType: 'company',
    clientConfig,
    tenantModels: {},
    handler: buildCompanyHandler(),
    getToken,
    mainDataInUpdate: 'HUBSPOT',
    bypassEmail: false,
    preprocessContext: null,
    syncLogId: null,
    sequentialFallback: jest.fn().mockResolvedValue({ sent: 0, failed: 0, created: 0, updated: 0, errors: [] }),
    ...useCaseOverrides,
  };
}

describe('ProcessCrmObjectBatches', () => {
  it('batch-creates unseen companies, registers mappings and syncs child contacts', async () => {
    const useCase = buildUseCase();
    const params = baseParams();
    const mappedItems = [
      { properties: { email: 'a@x.com', idsap: 'C001', name: 'A' }, rawSapData: { CardCode: 'C001' } },
      { properties: { email: 'b@x.com', idsap: 'C002', name: 'B' }, rawSapData: { CardCode: 'C002' } },
    ];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(result).toMatchObject({ ok: true, sent: 2, created: 2, updated: 0, failed: 0 });
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalledTimes(1);
    expect(useCase.associationRegistry.registerBaseObjectMappings).toHaveBeenCalledWith(
      'cred-1',
      'company',
      expect.arrayContaining([expect.objectContaining({ sapId: 'C001' })]),
      {}
    );
    expect(useCase.syncCompanyContactsInBatches.execute).toHaveBeenCalledTimes(1);
    const { companies } = useCase.syncCompanyContactsInBatches.execute.mock.calls[0][0];
    expect(companies).toHaveLength(2);
    expect(companies[0].hubspotId).toBeTruthy();
  });

  it('skips unchanged existing records and batch-updates changed ones', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({
      results: [
        { id: 'hs-1', properties: { email: 'a@x.com', name: 'A' } },
        { id: 'hs-2', properties: { email: 'b@x.com', name: 'Old' } },
      ],
    });
    const params = baseParams();
    params.handler.buildBatchUpdateEntry
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: 'hs-2', properties: { idsap: 'C002' } });

    const mappedItems = [
      { properties: { email: 'a@x.com', idsap: 'C001', name: 'A' }, rawSapData: {} },
      { properties: { email: 'b@x.com', idsap: 'C002', name: 'New' }, rawSapData: {} },
    ];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(result).toMatchObject({ sent: 2, created: 0, updated: 1, skipped: 1, failed: 0 });
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchUpdateObjects).toHaveBeenCalledTimes(1);
  });

  it('updates SAP sequentially when mainDataInUpdate is SAP', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({
      results: [{ id: 'hs-1', properties: { email: 'a@x.com' } }],
    });
    const params = baseParams({ mainDataInUpdate: 'SAP' });
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(useCase.sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot).toHaveBeenCalledTimes(1);
    expect(useCase.crmBatchClient.batchUpdateObjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 1, updated: 1 });
  });

  it('writes validation failures for items without email and still counts them as sent', async () => {
    const useCase = buildUseCase();
    const params = baseParams();
    const mappedItems = [{ properties: { idsap: 'C001', name: 'NoMail' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(useCase.validationFailureWriter.write).toHaveBeenCalledTimes(1);
    expect(useCase.associationRegistry.registerBaseObjectMappings).toHaveBeenCalledWith(
      'cred-1', 'company', [expect.objectContaining({ sapId: 'C001', hubspotId: '' })], {}
    );
    expect(result).toMatchObject({ sent: 1, created: 0, failed: 0 });
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
  });

  it('falls back to search IN when batch read rejects, then to sequential when both fail', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockRejectedValue(new Error('idProperty not unique'));
    useCase.crmBatchClient.searchObjectsByPropertyIn.mockResolvedValue([
      { id: 'hs-1', properties: { email: 'a@x.com', name: 'A' } },
    ]);
    const params = baseParams();
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001', name: 'A' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });
    expect(result).toMatchObject({ sent: 1, created: 0 });
    expect(params.sequentialFallback).not.toHaveBeenCalled();

    // Both read paths fail -> whole run degrades to sequential.
    const useCase2 = buildUseCase();
    useCase2.crmBatchClient.batchReadObjectsByProperty.mockRejectedValue(new Error('read down'));
    useCase2.crmBatchClient.searchObjectsByPropertyIn.mockRejectedValue(new Error('search down'));
    const params2 = baseParams();
    params2.sequentialFallback.mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0, errors: [] });

    const degraded = await useCase2.execute({ mappedItems, ...params2 });
    expect(params2.sequentialFallback).toHaveBeenCalledTimes(1);
    expect(degraded).toMatchObject({ sent: 1, created: 1 });
  });

  it('falls back to sequential for a failed create chunk only', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(new Error('create down'));
    const params = baseParams();
    params.sequentialFallback.mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0, errors: [] });
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(params.sequentialFallback).toHaveBeenCalledWith([mappedItems[0]]);
    expect(result).toMatchObject({ sent: 1, created: 1 });
  });

  it('associates contacts with their companies in batch for contact runs', async () => {
    const useCase = buildUseCase();
    useCase.associationRegistry.findHubspotIdsForSapIds.mockResolvedValue(new Map([['C001', 'hs-co-1']]));
    const params = baseParams({ objectType: 'contact' });
    params.handler = {
      getSearchProperties: jest.fn().mockResolvedValue(['email', 'firstname', 'phone', 'idsap', 'internalcode']),
      buildBatchUpdateEntry: jest.fn().mockReturnValue(null),
    };
    const mappedItems = [{
      properties: {
        email: 'a@x.com',
        idsap: 'P001',
        associations: { companies: ['C001'] },
      },
      rawSapData: {},
    }];

    await useCase.execute({ mappedItems, ...params });

    expect(useCase.associationRegistry.findHubspotIdsForSapIds).toHaveBeenCalledWith(
      'cred-1', 'company', ['C001'], {}
    );
    expect(useCase.crmBatchClient.batchAssociateDefault).toHaveBeenCalledWith(
      'token-1', 'contact', 'company', [{ fromId: 'hs-0', toId: 'hs-co-1' }]
    );
    expect(useCase.syncCompanyContactsInBatches.execute).not.toHaveBeenCalled();
  });

  it('retries a 429 in the per-pair association fallback', async () => {
    const useCase = buildUseCase();
    useCase.associationRegistry.findHubspotIdsForSapIds.mockResolvedValue(new Map([['C001', 'hs-co-1']]));
    useCase.crmBatchClient.batchAssociateDefault.mockRejectedValue(new Error('batch associate down'));
    const rateLimited = new Error('rate limited');
    rateLimited.response = { status: 429 };
    useCase.crmBatchClient.associateObjects
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce({});

    const params = baseParams({ objectType: 'contact' });
    params.handler = {
      getSearchProperties: jest.fn().mockResolvedValue(['email', 'idsap']),
      buildBatchUpdateEntry: jest.fn().mockReturnValue(null),
    };
    const mappedItems = [{
      properties: { email: 'a@x.com', idsap: 'P001', associations: { companies: ['C001'] } },
      rawSapData: {},
    }];

    await useCase.execute({ mappedItems, ...params });

    expect(useCase.crmBatchClient.associateObjects).toHaveBeenCalledTimes(2);
    expect(useCase.sleeper).toHaveBeenCalled();
  });

  it('batch-updates when mainDataInUpdate arrives in lowercase', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({
      results: [{ id: 'hs-1', properties: { email: 'a@x.com', name: 'Old' } }],
    });
    const params = baseParams({ mainDataInUpdate: 'hubspot' });
    params.handler.buildBatchUpdateEntry.mockReturnValue({ id: 'hs-1', properties: { idsap: 'C001' } });

    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001', name: 'New' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(useCase.crmBatchClient.batchUpdateObjects).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: 1, updated: 1, skipped: 0, failed: 0 });
  });

  it('counts a 207 partial create batch as partly failed and records its errors', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [{ id: 'hs-0', properties: { email: 'a@x.com', idsap: 'C001' } }],
      numErrors: 1,
      errors: [{ status: 'error', message: 'Property values were not valid', category: 'VALIDATION_ERROR' }],
    });
    const params = baseParams();
    const mappedItems = [
      { properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} },
      { properties: { email: 'b@x.com', idsap: 'C002' }, rawSapData: {} },
    ];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(result).toMatchObject({ sent: 1, created: 1, failed: 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      payloadHubspot: null,
      responseHubspot: expect.objectContaining({ message: 'Property values were not valid' }),
    });
    // Only the created record gets registered / associated.
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls[0][2];
    expect(mappings).toEqual([{ sapId: 'C001', hubspotId: 'hs-0' }]);
  });

  it('never falls back to positional matching on a 207, so no item gets another record id', async () => {
    const useCase = buildUseCase();
    // 207: one input succeeded, but the echoed record carries no find property,
    // so it cannot be matched by key. Positional matching would hand it to the
    // FIRST item and write a corrupted sapId -> hubspotId mapping.
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [{ id: 'hs-mystery', properties: {} }],
      numErrors: 1,
      errors: [{ status: 'error', message: 'Property values were not valid' }],
    });
    const params = baseParams();
    const mappedItems = [
      { properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} },
      { properties: { email: 'b@x.com', idsap: 'C002' }, rawSapData: {} },
    ];

    const result = await useCase.execute({ mappedItems, ...params });

    // Neither item can be matched, so no registry mapping is written at all --
    // an unmapped record is recoverable, a mapping pointing at the wrong SAP id
    // is not.
    expect(useCase.associationRegistry.registerBaseObjectMappings).not.toHaveBeenCalled();
    // HubSpot really did create one record (we just cannot attribute it), and
    // the rejected input is counted as failed.
    expect(result).toMatchObject({ sent: 1, created: 1, failed: 1 });
    expect(result.errors).toHaveLength(1);
    // Nothing reached `processed`, so no association work is attempted either.
    expect(useCase.syncCompanyContactsInBatches.execute).not.toHaveBeenCalled();
  });

  it('drops an update chunk from processed before its sequential fallback runs', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({
      results: [{ id: 'hs-1', properties: { email: 'a@x.com', name: 'Old' } }],
    });
    useCase.crmBatchClient.batchUpdateObjects.mockRejectedValue(new Error('update down'));
    const params = baseParams();
    params.handler.buildBatchUpdateEntry.mockReturnValue({ id: 'hs-1', properties: { idsap: 'C001' } });
    params.sequentialFallback.mockResolvedValue({ sent: 1, failed: 0, created: 0, updated: 1, errors: [] });

    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} }];

    await useCase.execute({ mappedItems, ...params });

    expect(params.sequentialFallback).toHaveBeenCalledWith([mappedItems[0]]);
    // The sequential fallback already does the association work for this item,
    // so the batch association phase must not see it again.
    expect(useCase.syncCompanyContactsInBatches.execute).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchAssociateDefault).not.toHaveBeenCalled();
  });

  it('merges contactErrors from the child-contact sync into errors', async () => {
    const useCase = buildUseCase({
      syncCompanyContactsInBatches: {
        execute: jest.fn().mockResolvedValue({
          contactErrors: [{ errorType: 'contactEmployee', sapContactId: 1 }],
        }),
      },
    });
    const params = baseParams();
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ errorType: 'contactEmployee' });
    expect(result.failed).toBe(0);
  });
});
