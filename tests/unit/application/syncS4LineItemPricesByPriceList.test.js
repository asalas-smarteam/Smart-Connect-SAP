import { jest } from '@jest/globals';
import SyncS4LineItemPricesByPriceList from '../../../src/application/use-cases/SyncS4LineItemPricesByPriceList.js';
import { createSapCallRecorder } from '../../../src/infrastructure/sap/sapCallRecorder.js';
import { S4PriceListClient, CUSTOMER_SALES_AREA_PATH } from '../../../src/infrastructure/sap/S4PriceListClient.js';

const CANDIDATES_80000017 = [
  {
    conditionRecord: '0000418608',
    conditionTable: '502',
    priceListType: 'ZC',
    material: '80000017',
    conditionRateValue: 1.28,
    conditionCurrency: 'USD',
    conditionQuantity: 1,
    conditionQuantityUnit: 'KG',
    conditionIsDeleted: false,
  },
];

function buildDeps({
  salesAreas = [{ Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC', Currency: 'CRC' }],
  candidatesByMaterial = { 80000017: CANDIDATES_80000017 },
  config = {
    conditionType: 'ZPR0',
    defaultPriceListType: 'ZA',
    salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
    priceListProperty: 'lista_de_precios_sap',
    currencyProperty: 'moneda_precio_sap',
    priceSourceProperty: 'origen_precio_sap',
  },
  // Overrides opcionales para los tests de cobertura agregados tras la revisión: los 11
  // casos originales no los pasan, así que su comportamiento no cambia.
  updateLineItems = jest.fn(async () => ({ payload: { inputs: [{ id: '1' }] }, response: { results: [{ id: '1' }] } })),
  updateDealAmount = jest.fn(async () => ({ payload: {}, response: {} })),
  createSapCallRecorder,
} = {}) {
  const priceListClient = {
    fetchCustomerSalesAreas: jest.fn(async () => salesAreas),
    fetchConditionCandidates: jest.fn(async ({ material }) => candidatesByMaterial[material] ?? []),
  };

  const hubspotPriceClient = {
    getAccessToken: jest.fn(async () => 'token'),
    updateLineItems,
    updateDealAmount,
  };

  return {
    priceListClient,
    hubspotPriceClient,
    useCase: new SyncS4LineItemPricesByPriceList({
      credentialRepository: {
        resolveS4PriceListConfig: jest.fn(async () => config),
        resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
        resolveSapCredentials: jest.fn(async () => ({ serviceLayerBaseUrl: 'https://sap', serviceLayerUsername: 'u', serviceLayerPassword: 'p' })),
      },
      createPriceListClient: jest.fn(() => priceListClient),
      hubspotPriceClient,
      buildErrorResponseSnapshot: (error) => ({ message: error.message }),
      buildWebhookSyncErrorEntry: (entry) => entry,
      buildLineItemPriceAudit: (auditTrail) => auditTrail,
      dateProvider: () => new Date('2026-08-18T00:00:00.000Z'),
      logger: { warn: jest.fn(), info: jest.fn() },
      ...(createSapCallRecorder ? { createSapCallRecorder } : {}),
    }),
  };
}

const CONTEXT = { tenantModels: {}, tenant: {}, tenantKey: 'multiquimica' };

describe('SyncS4LineItemPricesByPriceList', () => {
  it('escribe el precio de la lista del cliente y el total del deal', async () => {
    const { useCase, hubspotPriceClient } = buildDeps();

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 3 }] },
      CONTEXT
    );

    expect(result.data.lineItems).toEqual([
      expect.objectContaining({
        id: '1',
        itemCode: '80000017',
        quantity: 3,
        Price: 1.28,
        Currency: 'USD',
        // I4: la unidad de la condición llega hasta la línea enriquecida (y por lo tanto al
        // audit); no se convierte nada, sólo se registra.
        conditionQuantityUnit: 'KG',
        lineTotal: 3.84,
        priceSource: 'customerPriceList',
        omitDiscount: true,
        additionalProperties: {
          lista_de_precios_sap: 'ZC',
          moneda_precio_sap: 'USD',
          origen_precio_sap: 'customerPriceList',
        },
      }),
    ]);
    expect(result.meta).toEqual({ requestedCount: 1, updatedCount: 1, skippedCount: 0, dealUpdated: true });
    expect(hubspotPriceClient.updateDealAmount).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: '77', totalAmount: 3.84 })
    );
  });

  it('usa la única área de ventas del cliente e ignora la configurada', async () => {
    const { useCase, priceListClient } = buildDeps({
      salesAreas: [{ Customer: '105049', SalesOrganization: 'MQGT', DistributionChannel: '02', Division: 'SC', PriceListType: 'ZB' }],
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], priceListType: 'ZB', conditionRateValue: 2 }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(priceListClient.fetchConditionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ salesArea: { salesOrganization: 'MQGT', distributionChannel: '02', division: 'SC' } })
    );
    expect(result.data.priceListType).toBe('ZB');
    expect(result.data.lineItems[0].Price).toBe(2);
  });

  // M1 de la revisión final: el caso de uso sustituía la lista del cliente por la de config
  // ANTES de llamar al dominio, así que el origen reportado decía `customerPriceList` para un
  // precio que en realidad salió del default de config.
  it('cae a la lista default cuando el cliente no tiene PriceListType, y el origen reportado es defaultPriceList', async () => {
    const { useCase } = buildDeps({
      salesAreas: [{ Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: '' }],
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], priceListType: 'ZA', conditionRateValue: 2.08 }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.data.priceListType).toBe('ZA');
    expect(result.data.lineItems[0].Price).toBe(2.08);
    expect(result.data.lineItems[0].priceSource).toBe('defaultPriceList');
    expect(result.data.lineItems[0].additionalProperties).toEqual({
      lista_de_precios_sap: 'ZA',
      moneda_precio_sap: 'USD',
      origen_precio_sap: 'defaultPriceList',
    });
  });

  // I2 de la revisión final: la propiedad de lista se escribía sólo si `priceListType` no era
  // null, y para el default del producto es null por construcción. La línea que antes decía `ZC`
  // seguía diciendo `ZC` al lado de un precio que no es de ZC.
  it('escribe PRODUCT_DEFAULT en la propiedad de lista cuando el precio sale del default del producto', async () => {
    const { useCase } = buildDeps({
      candidatesByMaterial: {
        80000017: [{
          ...CANDIDATES_80000017[0],
          conditionRecord: '0000418745',
          conditionTable: '504',
          priceListType: null,
          conditionRateValue: 1.25,
        }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.data.lineItems[0].Price).toBe(1.25);
    expect(result.data.lineItems[0].priceListType).toBeNull();
    expect(result.data.lineItems[0].additionalProperties).toEqual({
      lista_de_precios_sap: 'PRODUCT_DEFAULT',
      moneda_precio_sap: 'USD',
      origen_precio_sap: 'productDefault',
    });
  });

  // I3 de la revisión final: la decisión de NO convertir monedas está aceptada; el problema es
  // agregar unidades distintas en el `amount` del negocio.
  it('con líneas en monedas distintas NO escribe el amount del negocio y lo dice en el resultado', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({
      candidatesByMaterial: {
        80000017: CANDIDATES_80000017,
        80000029: [{ ...CANDIDATES_80000017[0], material: '80000029', conditionCurrency: 'DOP', conditionRateValue: 75 }],
      },
    });
    const warn = jest.fn();
    useCase.logger = { warn, info: jest.fn() };

    const result = await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '80000029', quantity: 1 },
        ],
      },
      CONTEXT
    );

    // Las líneas SÍ se escriben: cada una es correcta en su propia moneda.
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalled();
    // El negocio queda como estaba: no se manda ningún amount.
    expect(hubspotPriceClient.updateDealAmount).not.toHaveBeenCalled();
    expect(result.data.totalAmount).toBeNull();
    expect(result.data.currencies).toEqual(['USD', 'DOP']);
    expect(result.meta.dealUpdated).toBe(false);
    expect(result.meta.dealNotUpdatedReason).toContain('2 currencies');
    expect(result.meta.dealNotUpdatedReason).toContain('USD, DOP');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('mixed line item currencies'),
      currencies: ['USD', 'DOP'],
    }));
  });

  it('con una sola moneda entre las líneas sí escribe el amount y no reporta motivo', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({
      candidatesByMaterial: {
        80000017: CANDIDATES_80000017,
        80000029: [{ ...CANDIDATES_80000017[0], material: '80000029', conditionRateValue: 2 }],
      },
    });

    const result = await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '80000029', quantity: 1 },
        ],
      },
      CONTEXT
    );

    expect(hubspotPriceClient.updateDealAmount).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: '77', totalAmount: 3.28 })
    );
    expect(result.data.currencies).toEqual(['USD']);
    expect(result.meta.dealUpdated).toBe(true);
    expect(result.meta.dealNotUpdatedReason).toBeUndefined();
  });

  // I5 de la revisión final: toda la decisión de no convertir monedas se apoya en que el rastro
  // exista, y sin `currencyProperty` la moneda no queda en ninguna parte del CRM.
  it('avisa por corrida cuando currencyProperty no está configurada, sin fallar', async () => {
    const { useCase } = buildDeps({
      config: {
        conditionType: 'ZPR0',
        defaultPriceListType: 'ZA',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
        priceListProperty: 'lista_de_precios_sap',
        currencyProperty: null,
        priceSourceProperty: null,
      },
    });
    const warn = jest.fn();
    useCase.logger = { warn, info: jest.fn() };

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.meta.dealUpdated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('currencyProperty is not configured'),
      dealId: '77',
    }));
    // La moneda no se escribe en ninguna propiedad, que es exactamente lo que el warning avisa.
    expect(result.data.lineItems[0].additionalProperties).toEqual({
      lista_de_precios_sap: 'ZC',
    });
  });

  // I4 de la revisión final: `conditionQuantityUnit` se traía y se descartaba. Ahora viaja al
  // audit, que es donde se reconstruye un precio raro.
  it('lleva conditionQuantityUnit al audit de la corrida', async () => {
    const { useCase } = buildDeps();

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.audit.rounds[0].enrichedLineItems[0]).toEqual(
      expect.objectContaining({ conditionQuantityUnit: 'KG', conditionRecord: '0000418608' })
    );
  });

  // I6 de la revisión final: con `Division` vacía en las filas de S/4 no había configuración
  // posible. La comparación ignora `division` cuando alguno de los dos lados la trae vacía.
  it('elige el área configurada aunque las filas de SAP traigan Division vacía', async () => {
    const { useCase, priceListClient } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: '', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: '', PriceListType: 'ZC' },
      ],
    });

    await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(priceListClient.fetchConditionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: null },
      })
    );
  });

  it('los mensajes de error de área muestran las áreas del cliente y la configurada', async () => {
    const { useCase: withoutConfig } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: '', PriceListType: 'ZC' },
      ],
      config: {
        conditionType: 'ZPR0', defaultPriceListType: 'ZA', salesArea: null, priceListProperty: null, currencyProperty: null, priceSourceProperty: null,
      },
    });

    // Sin config: el error lista las áreas que el cliente TIENE, con la división vacía visible.
    const noConfigError = await withoutConfig.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    ).catch((caught) => caught);
    expect(noConfigError.message).toContain('CPDO/01/SC');
    expect(noConfigError.message).toContain('FQCR/01/(empty)');

    const { useCase: mismatched } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'MQGT', DistributionChannel: '02', Division: 'SC', PriceListType: 'ZB' },
      ],
    });

    // Con config que no calza: el error muestra los DOS lados de la comparación.
    const mismatchError = await mismatched.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    ).catch((caught) => caught);
    expect(mismatchError.message).toContain('FQCR/01/SC');
    expect(mismatchError.message).toContain('CPDO/01/SC, MQGT/02/SC');
  });

  it('falla pidiendo la división cuando el área configurada sin division empata con dos del cliente', async () => {
    const { useCase } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'MP', PriceListType: 'ZD' },
      ],
      config: {
        conditionType: 'ZPR0',
        defaultPriceListType: 'ZA',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: null },
        priceListProperty: null,
        currencyProperty: null,
        priceSourceProperty: null,
      },
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow(/matches 2 sales areas .*add s4PriceList\.salesArea\.division/);
  });

  it('elige el área configurada cuando el cliente tiene varias', async () => {
    const { useCase, priceListClient } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC' },
      ],
    });

    await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(priceListClient.fetchConditionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' } })
    );
  });

  it('falla cuando el cliente tiene varias áreas y no hay ninguna configurada', async () => {
    const { useCase } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC' },
      ],
      config: { conditionType: 'ZPR0', defaultPriceListType: 'ZA', salesArea: null, priceListProperty: null, currencyProperty: null },
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('has 2 sales areas');
  });

  it('falla cuando el área configurada no pertenece al cliente', async () => {
    const { useCase } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'MQGT', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZB' },
      ],
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('does not belong to customer');
  });

  it('falla cuando el cliente no tiene áreas de venta en SAP', async () => {
    const { useCase } = buildDeps({ salesAreas: [] });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('has no sales areas');
  });

  it('saltea la línea sin tarifa y escribe las demás', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({
      candidatesByMaterial: { 80000017: CANDIDATES_80000017, 99999999: [] },
    });

    const result = await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '99999999', quantity: 1 },
        ],
      },
      CONTEXT
    );

    expect(result.data.lineItems).toHaveLength(1);
    expect(result.data.skippedLineItems).toEqual([
      {
        id: '2',
        itemCode: '99999999',
        reason: 'no ZPR0 condition record for the customer price list, the default price list or the product default',
        priceListType: 'ZC',
        defaultPriceListType: 'ZA',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
      },
    ]);
    expect(result.meta.skippedCount).toBe(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalled();
  });

  it('falla cuando ninguna línea se pudo valorizar', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({ candidatesByMaterial: {} });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('No line item prices could be resolved');

    expect(hubspotPriceClient.updateLineItems).not.toHaveBeenCalled();
  });

  it('pide las tarifas UNA vez por material aunque haya dos líneas del mismo producto', async () => {
    const { useCase, priceListClient } = buildDeps();

    await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '80000017', quantity: 2 },
        ],
      },
      CONTEXT
    );

    expect(priceListClient.fetchConditionCandidates).toHaveBeenCalledTimes(1);
  });

  it('cuelga el detalle del error en syncLogWebhookErrors', async () => {
    const { useCase } = buildDeps({ salesAreas: [] });

    const error = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    ).catch((caught) => caught);

    expect(error.syncLogWebhookErrors).toHaveLength(1);
    expect(error.syncLogWebhookErrors[0].payloadHubspot).toEqual({ dealId: '77', customer: '105049' });
    expect(error.lineItemPriceAudit).toBeTruthy();
  });

  // Cobertura agregada tras la revisión de la Task 4 (Important 1): si updateLineItems ya
  // escribió y después updateDealAmount falla, el negocio queda con las líneas actualizadas
  // pero el total desactualizado. El test asienta ese estado intermedio: el error se propaga,
  // syncLogWebhookErrors queda armado, y el audit conserva el rastro de la llamada a
  // updateLineItems que sí ocurrió. No se cambia el comportamiento de producción.
  it('si updateLineItems escribe bien y updateDealAmount falla, el error se propaga con el rastro de la escritura ya hecha en el audit', async () => {
    const dealAmountError = new Error('deal update rejected by HubSpot');
    const { useCase } = buildDeps({
      updateDealAmount: jest.fn(async () => {
        throw dealAmountError;
      }),
      // Grabador real (no el no-op por defecto) para poder verificar que quedaron registradas
      // las dos llamadas a HubSpot, la que tuvo éxito y la que falló.
      createSapCallRecorder: () => createSapCallRecorder(),
    });

    const error = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    ).catch((caught) => caught);

    expect(error).toBe(dealAmountError);
    expect(error.syncLogWebhookErrors).toHaveLength(1);
    expect(error.syncLogWebhookErrors[0].payloadHubspot).toEqual({ dealId: '77', customer: '105049' });
    expect(error.lineItemPriceAudit).toBeTruthy();

    const hubspotCalls = error.lineItemPriceAudit.calls.filter((call) => call.target === 'hubspot');
    expect(hubspotCalls).toHaveLength(2);
    expect(hubspotCalls[0]).toEqual(
      expect.objectContaining({ path: '/crm/v3/objects/line_items/batch/update', ok: true })
    );
    expect(hubspotCalls[1]).toEqual(
      expect.objectContaining({ path: '/crm/v3/objects/deals/77', ok: false, error: dealAmountError })
    );
  });

  // Cobertura agregada tras la revisión de la Task 4 (Important 2): la rama de línea sin `id`
  // o sin `itemCode` no tenía test propio.
  it('saltea la línea sin id o sin itemCode y escribe igual la línea válida', async () => {
    const { useCase, hubspotPriceClient } = buildDeps();

    const result = await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '', quantity: 1 },
        ],
      },
      CONTEXT
    );

    expect(result.data.lineItems).toHaveLength(1);
    expect(result.data.lineItems[0].id).toBe('1');
    expect(result.data.skippedLineItems).toEqual([
      {
        id: '2',
        itemCode: null,
        reason: 'line item has no id or hs_sku',
        priceListType: 'ZC',
        defaultPriceListType: 'ZA',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
      },
    ]);
    expect(result.meta.skippedCount).toBe(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalled();
  });

  // Cobertura agregada tras la revisión de la Task 4 (tercero, relacionado), corregida en la
  // ronda 2 de revisión: si SAP devuelve un área de ventas con DistributionChannel vacío,
  // toSalesArea la mapea a null, y el cliente SAP REAL (S4PriceListClient.buildValidityFilter,
  // Task 2) lanza uno de sus dos mensajes específicos en vez de filtrar contra SAP con un área
  // a medias -- ya se decidió que ese endurecimiento es el comportamiento correcto (un área
  // incompleta podría devolver precios de otro canal). Se usa el cliente real (no un doble
  // propio) para que este test no pueda quedar en verde si el endurecimiento real se relaja o
  // cambia de mensaje: sólo el transporte -- la frontera con la red -- es doble.
  it('si el área de ventas del cliente tiene el canal de distribución vacío, el cliente SAP real lanza y el negocio entero falla sin tocar HubSpot', async () => {
    const hubspotPriceClient = {
      getAccessToken: jest.fn(async () => 'token'),
      updateLineItems: jest.fn(async () => ({ payload: {}, response: { results: [] } })),
      updateDealAmount: jest.fn(async () => ({ payload: {}, response: {} })),
    };

    // Doble del TRANSPORTE, no del cliente: fetchCustomerSalesAreas también pasa por el
    // cliente real, así que este transporte atiende esa primera llamada devolviendo la fila
    // con el canal vacío. La segunda llamada (la de vigencia, en fetchConditionCandidates) no
    // debe llegar nunca: buildValidityFilter tiene que lanzar antes de que el cliente real
    // invoque transport.fetchAll para esa entidad.
    const transport = {
      fetchAll: jest.fn(async ({ path }) => {
        if (path === CUSTOMER_SALES_AREA_PATH) {
          return [
            { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '', Division: 'SC', PriceListType: 'ZC' },
          ];
        }

        throw new Error(`unexpected transport.fetchAll call for path ${path}`);
      }),
    };
    const priceListClient = new S4PriceListClient({ transport });

    const useCase = new SyncS4LineItemPricesByPriceList({
      credentialRepository: {
        resolveS4PriceListConfig: jest.fn(async () => ({
          conditionType: 'ZPR0',
          defaultPriceListType: 'ZA',
          salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
          priceListProperty: 'lista_de_precios_sap',
          currencyProperty: 'moneda_precio_sap',
        })),
        resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
        resolveSapCredentials: jest.fn(async () => ({ serviceLayerBaseUrl: 'https://sap', serviceLayerUsername: 'u', serviceLayerPassword: 'p' })),
      },
      createPriceListClient: jest.fn(() => priceListClient),
      hubspotPriceClient,
      buildErrorResponseSnapshot: (error) => ({ message: error.message }),
      buildWebhookSyncErrorEntry: (entry) => entry,
      buildLineItemPriceAudit: (auditTrail) => auditTrail,
      dateProvider: () => new Date('2026-08-18T00:00:00.000Z'),
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    // Mensaje REAL de S4PriceListClient.buildValidityFilter, no uno inventado en un doble.
    )).rejects.toThrow('salesArea.distributionChannel is required for fetchConditionCandidates');

    // Sólo hubo UNA llamada de transporte (las áreas de venta); la de vigencia jamás salió,
    // que es justamente lo que el endurecimiento tiene que impedir.
    expect(transport.fetchAll).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateLineItems).not.toHaveBeenCalled();
    expect(hubspotPriceClient.updateDealAmount).not.toHaveBeenCalled();
  });
});
