import { jest } from '@jest/globals';
import ProcessHubspotInventoryTransferRequest from '../../../src/application/use-cases/ProcessHubspotInventoryTransferRequest.js';

const noopSyncError = {
  buildWebhookSyncErrorEntry: jest.fn((x) => x),
  buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
  buildWebhookSapAudit: jest.fn((auditTrail) => ({ auditTrail })),
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
      ],
      dealMappings: [
        { sourceField: 'DocEntry', targetField: 'sap_docentry' },
        { sourceField: 'DocNum', targetField: 'sap_docnum' },
      ],
      dealOrdersQuotationsMappings: [
        { sourceField: 'PaymentGroupCode', targetField: 'paymentGroupCode' },
      ],
      dealInventoryTransferRequestMappings: [
        { sourceField: 'FromWarehouse', targetField: 'filler' },
        { sourceField: 'ToWarehouse', targetField: 'towhscode' },
      ],
      productInventoryTransferRequestMappings: [
        { sourceField: 'ItemCode', targetField: 'hs_sku' },
        { sourceField: 'Quantity', targetField: 'quantity' },
        { sourceField: 'FromWarehouseCode', targetField: 'filler' },
        { sourceField: 'WarehouseCode', targetField: 'towhscode' },
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
    resolveGroupCodeDefaults: jest.fn().mockResolvedValue(null),
    findOwnerMappingByHubspotOwner: jest.fn().mockResolvedValue(null),
  };
}

const baseEvent = {
  _id: 'event-1',
  eventType: 'inventoryTransferRequest',
  payload: {
    portalId: '50564010',
    deal: { hs_object_id: '59680314911', filler: 'B01', towhscode: 'B02' },
    line_items: [
      { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '3', filler: 'B01', towhscode: 'B02' },
    ],
  },
};

const tenantModels = { WebhookEvent: {}, SapDocumentLink: {} };

describe('ProcessHubspotInventoryTransferRequest', () => {
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
      sapInventoryTransferRequestAdapter: {
        createInventoryTransferRequest: jest.fn().mockResolvedValue({
          DocEntry: 12345,
          DocNum: 8001,
          StockTransferLines: [{ LineNum: 0 }],
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
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn() },
    };
  }

  it('creates an Inventory Transfer Request, persists the link and updates the deal', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const result = await useCase.execute({
      event: baseEvent,
      tenantModels,
      tenantId: 't1',
      tenantKey: 'k1',
      portalId: '50564010',
    });

    expect(deps.sapInventoryTransferRequestAdapter.createInventoryTransferRequest)
      .toHaveBeenCalledTimes(1);

    const linkArg = deps.sapDocumentLinkRepository.create.mock.calls[0][0].link;
    expect(linkArg).toMatchObject({
      dealId: '59680314911',
      documentType: 'inventoryTransferRequest',
      sapObject: 'InventoryTransferRequests',
      sapDocEntry: 12345,
      sapDocNum: 8001,
      sapBaseType: 1250000001,
    });
    expect(linkArg.lines[0]).toMatchObject({ hubspotLineItemId: 'li-1', sapLineNum: 0 });

    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });

    const { inventoryTransferRequestPayload } = deps.sapInventoryTransferRequestAdapter
      .createInventoryTransferRequest.mock.calls[0][0];
    expect(inventoryTransferRequestPayload).toMatchObject({
      FromWarehouse: 'B01',
      ToWarehouse: 'B02',
      StockTransferLines: [{ ItemCode: 'A01', Quantity: 3, FromWarehouseCode: 'B01', WarehouseCode: 'B02' }],
    });
    expect(result.sapAudit.auditTrail.payload_SAP.inventoryTransferRequest).toMatchObject({
      FromWarehouse: 'B01',
      ToWarehouse: 'B02',
    });
  });

  it('is idempotent: skips creation when an inventoryTransferRequest link already exists', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      cardCode: 'CL00129',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.sapInventoryTransferRequestAdapter.createInventoryTransferRequest).not.toHaveBeenCalled();
    expect(deps.sapDocumentLinkRepository.findByDeal.mock.calls[0][0]).toMatchObject({
      documentType: 'inventoryTransferRequest',
    });
    expect(result).toEqual({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
  });

  it('fails permanently and never calls the adapter when both warehouses are unmapped', async () => {
    const context = buildContext();
    context.mappings.dealInventoryTransferRequestMappings = [];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const error = await useCase.execute({ event: baseEvent, tenantModels }).catch((e) => e);

    expect(error.permanent).toBe(true);
    expect(deps.sapInventoryTransferRequestAdapter.createInventoryTransferRequest).not.toHaveBeenCalled();
    expect(error.sapOrderCreated).toBeUndefined();
    expect(error.syncLogWebhookErrors).toHaveLength(1);
  });

  it('marks sapOrderCreated when the document was created in SAP but the HubSpot write-back fails', async () => {
    const deps = buildDeps();
    deps.hubspotWebhookAdapter.updateAfterSap.mockRejectedValue(new Error('HubSpot down'));
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const error = await useCase.execute({ event: baseEvent, tenantModels }).catch((e) => e);

    expect(error.sapOrderCreated).toBe(true);
    expect(error.sapOrderResult).toMatchObject({ docEntry: 12345, docNum: 8001 });
  });

  it('does not leak fields mapped only for orders-quotations into the ITR payload', async () => {
    const event = {
      ...baseEvent,
      payload: { ...baseEvent.payload, deal: { ...baseEvent.payload.deal, paymentGroupCode: '3' } },
    };
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event, tenantModels });

    const { inventoryTransferRequestPayload } = deps.sapInventoryTransferRequestAdapter
      .createInventoryTransferRequest.mock.calls[0][0];
    expect(inventoryTransferRequestPayload).not.toHaveProperty('PaymentGroupCode');
  });

  it('writes DocEntry/DocNum back using the inventory-transfer-request mappings when they define them', async () => {
    const context = buildContext();
    context.mappings.dealInventoryTransferRequestMappings = [
      { sourceField: 'FromWarehouse', targetField: 'filler' },
      { sourceField: 'ToWarehouse', targetField: 'towhscode' },
      { sourceField: 'DocEntry', targetField: 'itr_docentry' },
      { sourceField: 'DocNum', targetField: 'itr_docnum' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    const { dealMappings } = deps.hubspotWebhookAdapter.updateAfterSap.mock.calls[0][0];
    expect(dealMappings).toEqual(context.mappings.dealInventoryTransferRequestMappings);
  });

  it('falls back to the plain deal mappings for write-back when the ITR context has no DocEntry/DocNum', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    const { dealMappings } = deps.hubspotWebhookAdapter.updateAfterSap.mock.calls[0][0];
    expect(dealMappings).toEqual([
      { sourceField: 'DocEntry', targetField: 'sap_docentry' },
      { sourceField: 'DocNum', targetField: 'sap_docnum' },
    ]);
  });

  it('never resolves group code defaults: OWTQ has no PaymentGroupCode', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.runtimeRepository.resolveGroupCodeDefaults).not.toHaveBeenCalled();
  });
});
