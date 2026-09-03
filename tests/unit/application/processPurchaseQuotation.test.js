import { jest } from '@jest/globals';
import ProcessHubspotPurchaseQuotation from '../../../src/application/use-cases/ProcessHubspotPurchaseQuotation.js';
import {
  PURCHASE_QUOTATION_BASE_TYPE,
  buildPurchaseQuotationPayload,
  mapPurchaseQuotationLines,
} from '../../../src/domain/purchases/purchase-quotation-builder.service.js';

const noopSyncError = {
  buildWebhookSyncErrorEntry: jest.fn((x) => x),
  buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
  buildWebhookSapAudit: jest.fn((auditTrail) => ({ auditTrail })),
};

function buildContext(overrides = {}) {
  return {
    mappings: {
      dealMappings: [
        { sourceField: 'DocEntry', targetField: 'sap_docentry' },
        { sourceField: 'DocNum', targetField: 'sap_docnum' },
      ],
      dealPurchaseQuotationsMappings: [
        { sourceField: 'CardCode', targetField: 'proveedor_sap' },
        { sourceField: 'Comments', targetField: 'comments' },
      ],
      productPurchaseQuotationsMappings: [
        { sourceField: 'ItemCode', targetField: 'hs_sku' },
        { sourceField: 'Quantity', targetField: 'quantity' },
        { sourceField: 'WarehouseCode', targetField: 'whscode' },
      ],
    },
    sapConfig: { serviceLayerBaseUrl: 'https://sap.test' },
    hubspotCredentials: { _id: 'cred-1', clientConfigId: 'cfg-1' },
    ...overrides,
  };
}

function buildRuntimeRepository(context = buildContext()) {
  return {
    resolveRuntimeContext: jest.fn().mockResolvedValue(context),
    findOwnerMappingByHubspotOwner: jest.fn().mockResolvedValue(null),
  };
}

const baseEvent = {
  _id: 'event-1',
  eventType: 'purchaseQuotation',
  payload: {
    portalId: '50082681',
    deal: {
      hs_object_id: '59680314911',
      proveedor_sap: 'PR000123',
      comments: 'Compra de tóner',
    },
    line_items: [
      { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '3', whscode: 'B01' },
    ],
  },
};

const tenantModels = { WebhookEvent: {}, SapDocumentLink: {} };

function buildDeps(context = buildContext()) {
  return {
    runtimeRepository: buildRuntimeRepository(context),
    sapPurchaseQuotationAdapter: {
      createPurchaseQuotation: jest.fn().mockResolvedValue({
        DocEntry: 12345,
        DocNum: 8001,
        DocumentLines: [{ LineNum: 0 }],
      }),
    },
    hubspotWebhookAdapter: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
    },
    sapDocumentLinkRepository: {
      findByDeal: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    ...noopSyncError,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

describe('mapPurchaseQuotationLines', () => {
  const lineMappings = [
    { sourceField: 'ItemCode', targetField: 'hs_sku' },
    { sourceField: 'Quantity', targetField: 'quantity' },
    { sourceField: 'WarehouseCode', targetField: 'whscode' },
  ];

  it('emite exactamente lo mapeado, con Quantity numérica', () => {
    const lines = mapPurchaseQuotationLines({
      lineItems: [{ hs_sku: 'A01', quantity: '3', whscode: 'B01' }],
      lineMappings,
    });

    expect(lines).toEqual([{ ItemCode: 'A01', Quantity: 3, WarehouseCode: 'B01' }]);
  });

  it('no inventa campos que el tenant no mapeó', () => {
    const lines = mapPurchaseQuotationLines({
      lineItems: [{ hs_sku: 'A01', quantity: '3' }],
      lineMappings,
    });

    expect(lines).toEqual([{ ItemCode: 'A01', Quantity: 3 }]);
    expect(lines[0]).not.toHaveProperty('WarehouseCode');
    expect(lines[0]).not.toHaveProperty('UnitPrice');
  });

  it('falla como permanente si falta ItemCode', () => {
    expect(() => mapPurchaseQuotationLines({
      lineItems: [{ quantity: '3' }],
      lineMappings,
    })).toThrow(/ItemCode is required/);
  });

  it.each([['0', 'cero'], ['-2', 'negativa'], [undefined, 'ausente']])(
    'falla como permanente con Quantity %s (%s)',
    (quantity) => {
      expect(() => mapPurchaseQuotationLines({
        lineItems: [{ hs_sku: 'A01', quantity }],
        lineMappings,
      })).toThrow(/Quantity/);
    }
  );
});

describe('buildPurchaseQuotationPayload', () => {
  const documentLines = [{ ItemCode: 'A01', Quantity: 3 }];

  it('usa el CardCode mapeado como proveedor y adjunta DocumentLines', () => {
    const payload = buildPurchaseQuotationPayload({
      mappedDealFields: { CardCode: 'PR000123', Comments: 'x' },
      documentLines,
    });

    expect(payload).toEqual({
      CardCode: 'PR000123',
      Comments: 'x',
      DocumentLines: documentLines,
    });
  });

  it('falla como permanente si el tenant no mapeó CardCode', () => {
    expect(() => buildPurchaseQuotationPayload({
      mappedDealFields: { Comments: 'x' },
      documentLines,
    })).toThrow(/CardCode/);
  });

  it('falla como permanente sin líneas', () => {
    expect(() => buildPurchaseQuotationPayload({
      mappedDealFields: { CardCode: 'PR000123' },
      documentLines: [],
    })).toThrow(/At least one line_item/);
  });

  // Un mapping copiado del flujo de traslados no debe meter StockTransferLines en un
  // documento de compra: SAP lo rechazaría con un error opaco.
  it('descarta StockTransferLines que venga del spread de la cabecera', () => {
    const payload = buildPurchaseQuotationPayload({
      mappedDealFields: { CardCode: 'PR000123', StockTransferLines: [{ ItemCode: 'X' }] },
      documentLines,
    });

    expect(payload).not.toHaveProperty('StockTransferLines');
    expect(payload.DocumentLines).toBe(documentLines);
  });

  it('aplica SalesPersonCode solo cuando el OwnerMapping resolvió un entero', () => {
    expect(buildPurchaseQuotationPayload({
      mappedDealFields: { CardCode: 'PR000123' },
      documentLines,
      slpCode: 7,
    }).SalesPersonCode).toBe(7);

    expect(buildPurchaseQuotationPayload({
      mappedDealFields: { CardCode: 'PR000123' },
      documentLines,
      slpCode: null,
    })).not.toHaveProperty('SalesPersonCode');
  });
});

describe('ProcessHubspotPurchaseQuotation', () => {
  it('crea el PurchaseQuotation en SAP con la cabecera y las líneas mapeadas', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.sapPurchaseQuotationAdapter.createPurchaseQuotation).toHaveBeenCalledTimes(1);
    const { purchaseQuotationPayload } = deps.sapPurchaseQuotationAdapter
      .createPurchaseQuotation.mock.calls[0][0];

    expect(purchaseQuotationPayload).toEqual({
      CardCode: 'PR000123',
      Comments: 'Compra de tóner',
      DocumentLines: [{ ItemCode: 'A01', Quantity: 3, WarehouseCode: 'B01' }],
    });
    expect(result).toMatchObject({
      cardCode: 'PR000123',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
  });

  // El punto central del diseño: un documento de compra NO pasa por el flujo de Business
  // Partner, que crea clientes (CardType 'C'). El proveedor sale del mapping o no hay documento.
  it('no resuelve ni crea Business Partners, y no sincroniza company/contact', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    await useCase.execute({
      event: {
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          company: { hs_object_id: 'company-1', name: 'ACME' },
          contact: { hs_object_id: 'contact-1', firstname: 'Juan' },
        },
      },
      tenantModels,
    });

    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledWith(
      expect.objectContaining({ syncCompany: false, syncContact: false })
    );
  });

  it('falla como permanente cuando falta el mapping de CardCode, sin llamar a SAP', async () => {
    const context = buildContext();
    context.mappings.dealPurchaseQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
    ];
    const deps = buildDeps(context);
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    const error = await useCase
      .execute({ event: baseEvent, tenantModels })
      .then(() => null, (rejected) => rejected);

    expect(error).not.toBeNull();
    expect(error.permanent).toBe(true);
    expect(error.message).toMatch(/CardCode/);
    expect(deps.sapPurchaseQuotationAdapter.createPurchaseQuotation).not.toHaveBeenCalled();
    expect(deps.sapDocumentLinkRepository.create).not.toHaveBeenCalled();
  });

  it('guarda el link con el ObjectType de OPQT', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.sapDocumentLinkRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({
          documentType: 'purchaseQuotation',
          sapObject: 'PurchaseQuotations',
          sapBaseType: PURCHASE_QUOTATION_BASE_TYPE,
          sapDocEntry: 12345,
          sapDocNum: 8001,
          cardCode: 'PR000123',
        }),
      })
    );
  });

  it('no crea un segundo documento para el mismo deal', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      cardCode: 'PR000123',
      sapDocEntry: 999,
      sapDocNum: 555,
    });
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.sapPurchaseQuotationAdapter.createPurchaseQuotation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ docEntry: 999, docNum: 555 });
  });

  // Mismo criterio que el traslado: si el tenant mapeó DocEntry/DocNum en su propio contexto
  // se usa ese, para no pisar las propiedades de cotización/orden del deal.
  it('prefiere el write-back del contexto purchase-quotations cuando existe', async () => {
    const context = buildContext();
    context.mappings.dealPurchaseQuotationsMappings = [
      ...context.mappings.dealPurchaseQuotationsMappings,
      { sourceField: 'DocEntry', targetField: 'oc_sap_docentry' },
    ];
    const deps = buildDeps(context);
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledWith(
      expect.objectContaining({
        dealMappings: context.mappings.dealPurchaseQuotationsMappings,
      })
    );
  });

  it('cae a dealMappings para el write-back si el contexto propio no trae DocEntry/DocNum', async () => {
    const context = buildContext();
    const deps = buildDeps(context);
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledWith(
      expect.objectContaining({ dealMappings: context.mappings.dealMappings })
    );
  });

  it('marca sapOrderCreated cuando SAP creó y falló un paso posterior', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.create.mockRejectedValue(new Error('mongo down'));
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    const error = await useCase
      .execute({ event: baseEvent, tenantModels })
      .then(() => null, (rejected) => rejected);

    expect(error).not.toBeNull();
    expect(error.sapOrderCreated).toBe(true);
    expect(error.sapOrderResult).toMatchObject({ docEntry: 12345, docNum: 8001 });
  });
});
