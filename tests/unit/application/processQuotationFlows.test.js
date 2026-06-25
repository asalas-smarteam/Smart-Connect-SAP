import { jest } from '@jest/globals';
import ProcessHubspotCreateQuotation from '../../../src/application/use-cases/ProcessHubspotCreateQuotation.js';
import ProcessHubspotUpdateQuotation from '../../../src/application/use-cases/ProcessHubspotUpdateQuotation.js';
import ProcessHubspotConvertQuotationToOrder from '../../../src/application/use-cases/ProcessHubspotConvertQuotationToOrder.js';

const noopSyncError = {
  buildWebhookSyncErrorEntry: jest.fn((x) => x),
  buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
};

function buildContext(overrides = {}) {
  return {
    mappings: {
      companyMappings: [],
      contactBusinessPartnerMappings: [],
      contactEmployeeMappings: [],
      productMappings: [
        { sourceField: 'ItemCode', targetField: 'hs_sku' },
        { sourceField: 'Quantity', targetField: 'quantity' },
        { sourceField: 'UnitPrice', targetField: 'price' },
      ],
      dealMappings: [
        { sourceField: 'DocEntry', targetField: 'sap_docentry' },
        { sourceField: 'DocNum', targetField: 'sap_docnum' },
      ],
    },
    sapConfig: { serviceLayerBaseUrl: 'https://sap.test' },
    hubspotCredentials: { _id: 'cred-1', clientConfigId: 'cfg-1' },
    taxCodes: [],
    miscPriceCalculationConfig: null,
    ...overrides,
  };
}

function buildRuntimeRepository(context = buildContext()) {
  return {
    resolveRuntimeContext: jest.fn().mockResolvedValue(context),
    resolveDefaultPriceListNum: jest.fn().mockResolvedValue(1),
    resolveRequireRandCardCode: jest.fn().mockResolvedValue(true),
    resolveDefaultSeries: jest.fn().mockResolvedValue(null),
    resolveDefaultFindSAP: jest.fn().mockResolvedValue('EmailAddress'),
    findOwnerMappingByHubspotOwner: jest.fn().mockResolvedValue(null),
  };
}

const baseEvent = {
  _id: 'event-1',
  eventType: 'createQuotation',
  payload: {
    portalId: '50564010',
    deal: { hs_object_id: '59680314911' },
    company: { name: 'Acme', hs_object_id: 'c1' },
    line_items: [
      { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '1', price: '10', warehouses: 'B03' },
    ],
  },
};

const tenantModels = { WebhookEvent: {}, SapDocumentLink: {} };

describe('ProcessHubspotCreateQuotation', () => {
  function buildDeps() {
    return {
      runtimeRepository: buildRuntimeRepository(),
      sapOrderAdapter: {
        findOrCreateBusinessPartner: jest.fn().mockResolvedValue({
          cardCode: 'CL00129',
          created: false,
          matchedBy: 'cardCode',
          businessPartner: { CardCode: 'CL00129' },
          requestPayload: null,
          responsePayload: null,
        }),
        addContactEmployeeIfNeeded: jest.fn(),
      },
      sapQuotationAdapter: {
        createQuotation: jest.fn().mockResolvedValue({
          DocEntry: 12345,
          DocNum: 8001,
          DocumentLines: [{ LineNum: 0 }],
        }),
      },
      hubspotWebhookAdapter: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        updateBusinessPartnerIds: jest.fn(),
        updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
      },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: {
        findByDeal: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        updateLines: jest.fn(),
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn() },
    };
  }

  it('creates a quotation, persists the SAP document link and updates the deal', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const result = await useCase.execute({
      event: baseEvent,
      tenantModels,
      tenantId: 't1',
      tenantKey: 'k1',
      portalId: '50564010',
    });

    expect(deps.sapQuotationAdapter.createQuotation).toHaveBeenCalledTimes(1);
    const linkArg = deps.sapDocumentLinkRepository.create.mock.calls[0][0].link;
    expect(linkArg).toMatchObject({
      dealId: '59680314911',
      documentType: 'quotation',
      sapObject: 'Quotations',
      sapDocEntry: 12345,
      sapDocNum: 8001,
      sapBaseType: 23,
    });
    expect(linkArg.lines[0]).toMatchObject({ hubspotLineItemId: 'li-1', sapLineNum: 0 });
    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
  });

  it('is idempotent: skips creation when a quotation link already exists', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      cardCode: 'CL00129',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.sapQuotationAdapter.createQuotation).not.toHaveBeenCalled();
    expect(result).toEqual({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
  });
});

describe('ProcessHubspotUpdateQuotation', () => {
  const updateEvent = {
    _id: 'event-2',
    eventType: 'updateQuotation',
    payload: {
      portalId: '50564010',
      deal: { hs_object_id: '59680314911' },
      line_items: [
        { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '2', price: '17.5' },
      ],
    },
  };

  function buildDeps() {
    return {
      runtimeRepository: buildRuntimeRepository(),
      sapQuotationAdapter: {
        getQuotation: jest.fn().mockResolvedValue({ DocEntry: 12345, DocumentLines: [{ LineNum: 0 }] }),
        updateQuotation: jest.fn().mockResolvedValue({ updated: true }),
      },
      sapDocumentLinkRepository: {
        findByDeal: jest.fn().mockResolvedValue({
          _id: 'link-1',
          cardCode: 'CL00129',
          sapDocEntry: 12345,
          sapDocNum: 8001,
          lines: [{ hubspotLineItemId: 'li-1', sapLineNum: 0, quantity: 1, unitPrice: 10 }],
        }),
        updateLines: jest.fn(),
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn() },
    };
  }

  it('patches existing quotation lines and refreshes the stored link lines', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const result = await useCase.execute({ event: updateEvent, tenantModels });

    expect(deps.sapQuotationAdapter.getQuotation).toHaveBeenCalledWith({
      sapConfig: expect.any(Object),
      docEntry: 12345,
    });
    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.DocumentLines).toEqual([{ LineNum: 0, UnitPrice: 17.5, Quantity: 2 }]);
    expect(deps.sapDocumentLinkRepository.updateLines).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ docEntry: 12345, docNum: 8001, dealId: '59680314911' });
  });

  it('fails in a controlled way when there is no quotation link for the deal', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue(null);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await expect(useCase.execute({ event: updateEvent, tenantModels })).rejects.toMatchObject({
      permanent: true,
    });
    expect(deps.sapQuotationAdapter.updateQuotation).not.toHaveBeenCalled();
  });
});

describe('ProcessHubspotConvertQuotationToOrder', () => {
  const convertEvent = {
    _id: 'event-3',
    eventType: 'convertQuotationToOrder',
    payload: {
      portalId: '50564010',
      deal: { hs_object_id: '59680314911' },
    },
  };

  function buildDeps() {
    return {
      runtimeRepository: buildRuntimeRepository(),
      sapOrderAdapter: {
        createOrder: jest.fn().mockResolvedValue({ DocEntry: 67890, DocNum: 9001 }),
      },
      hubspotWebhookAdapter: {
        updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
      },
      sapDocumentLinkRepository: {
        findByDeal: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn() },
    };
  }

  it('creates an order from the quotation using BaseType/BaseEntry/BaseLine', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }, { sapLineNum: 1 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const result = await useCase.execute({ event: convertEvent, tenantModels });

    const orderPayload = deps.sapOrderAdapter.createOrder.mock.calls[0][0].orderPayload;
    expect(orderPayload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 12345, BaseLine: 0 },
      { BaseType: 23, BaseEntry: 12345, BaseLine: 1 },
    ]);
    const linkArg = deps.sapDocumentLinkRepository.create.mock.calls[0][0].link;
    expect(linkArg).toMatchObject({
      documentType: 'order',
      sapDocEntry: 67890,
      baseDocument: { documentType: 'quotation', sapDocEntry: 12345, sapBaseType: 23 },
    });
    expect(result).toEqual({ cardCode: 'CL00129', docEntry: 67890, docNum: 9001, dealId: '59680314911' });
  });

  it('is idempotent: skips when an order link already exists', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({ cardCode: 'CL00129', sapDocEntry: 12345, lines: [{ sapLineNum: 0 }] })
      .mockResolvedValueOnce({ cardCode: 'CL00129', sapDocEntry: 67890, sapDocNum: 9001 });
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const result = await useCase.execute({ event: convertEvent, tenantModels });

    expect(deps.sapOrderAdapter.createOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ docEntry: 67890, docNum: 9001 });
  });

  it('fails when there is no quotation to convert', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    await expect(useCase.execute({ event: convertEvent, tenantModels })).rejects.toMatchObject({
      permanent: true,
    });
    expect(deps.sapOrderAdapter.createOrder).not.toHaveBeenCalled();
  });
});
