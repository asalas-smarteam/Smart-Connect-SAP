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
    defaultPriceListBySalesArea: {},
    priceListProperty: 'lista_de_precios_sap',
    currencyProperty: 'moneda_precio_sap',
    priceSourceProperty: 'origen_precio_sap',
  },
  // Overrides opcionales para los tests de cobertura agregados tras la revisión: los 11
  // casos originales no los pasan, así que su comportamiento no cambia.
  updateLineItems = jest.fn(async () => ({ payload: { inputs: [{ id: '1' }] }, response: { results: [{ id: '1' }] } })),
  updateDealAmount = jest.fn(async () => ({ payload: {}, response: {} })),
  createSapCallRecorder,
  notifyLineItemPriceOutcome = jest.fn(async () => {}),
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
    notifyLineItemPriceOutcome,
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
      notifyLineItemPriceOutcome,
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
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 3 }] },
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

  it('consulta el área de ventas que declara el negocio, no todas las del cliente', async () => {
    const { useCase, priceListClient } = buildDeps();

    await useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'fqcr', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    // La organización se normaliza a mayúsculas; el canal viaja INTACTO ('01', no '1').
    expect(priceListClient.fetchCustomerSalesAreas).toHaveBeenCalledWith('105049', {
      salesOrganization: 'FQCR',
      distributionChannel: '01',
    });
  });

  it('usa el default de la combinación org/canal cuando el cliente no tiene lista', async () => {
    const { useCase } = buildDeps({
      salesAreas: [{ Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', PriceListType: '' }],
      config: {
        conditionType: 'ZPR0',
        defaultPriceListType: 'ZC',
        defaultPriceListBySalesArea: { 'FQCR/01': 'ZD' },
        priceListProperty: null,
        currencyProperty: 'moneda_precio_sap',
        priceSourceProperty: null,
      },
      candidatesByMaterial: {
        80000017: [
          { ...CANDIDATES_80000017[0], conditionRecord: 'ZC-1', priceListType: 'ZC', conditionRateValue: 9.99 },
          { ...CANDIDATES_80000017[0], conditionRecord: 'ZD-1', priceListType: 'ZD', conditionRateValue: 2.05 },
        ],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    // Gana ZD (el default de FQCR/01), no ZC (el global): si mandara el global, el precio
    // sería 9.99.
    expect(result.data.priceListType).toBe('ZD');
    expect(result.data.lineItems[0].Price).toBe(2.05);
  });

  it('cae al defaultPriceListType global cuando la combinación no está en el mapa', async () => {
    const { useCase } = buildDeps({
      salesAreas: [{ Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', PriceListType: '' }],
      config: {
        conditionType: 'ZPR0',
        defaultPriceListType: 'ZA',
        defaultPriceListBySalesArea: { 'MQGT/01': 'ZD' },
        priceListProperty: null,
        currencyProperty: 'moneda_precio_sap',
        priceSourceProperty: null,
      },
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], priceListType: 'ZA', conditionRateValue: 2.08 }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.data.priceListType).toBe('ZA');
    expect(result.data.lineItems[0].Price).toBe(2.08);
  });

  it('el audit de la corrida ya no reporta salesAreaSource', async () => {
    const { useCase } = buildDeps();

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.data).not.toHaveProperty('salesAreaSource');
    expect(result.audit.rounds[0]).not.toHaveProperty('salesAreaSource');
  });

  // Cero filas: el cliente NO está registrado en el área que declara el negocio. Los precios se
  // ponen en 0 (decisión del cliente, 2026-08-24) y la nota lista las áreas reales.
  it('con el cliente fuera del área declarada pone los precios en 0, avisa y falla', async () => {
    const { useCase, hubspotPriceClient, notifyLineItemPriceOutcome, priceListClient } = buildDeps({
      salesAreas: [],
    });
    // La segunda consulta (sin filtro de área) es la que lista las áreas reales del cliente.
    priceListClient.fetchCustomerSalesAreas = jest.fn(async (_customer, area) => (
      area
        ? []
        : [
          { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', PriceListType: 'ZD' },
          { Customer: '105049', SalesOrganization: 'DPDO', DistributionChannel: '01', PriceListType: 'ZC' },
        ]
    ));

    await expect(useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        salesOrganization: 'MQGT',
        distributionChannel: '01',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 4 },
          { id: '2', itemCode: '80000029', quantity: 7 },
        ],
      },
      CONTEXT
    )).rejects.toThrow('is not registered in sales area MQGT/01');

    // La cantidad viaja con su valor REAL: buildHubspotBatchPayload escribe precio y cantidad en
    // la misma llamada, así que omitirla la sobreescribiría con 1.
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledWith(expect.objectContaining({
      enrichedLineItems: [
        expect.objectContaining({ id: '1', quantity: 4, Price: 0 }),
        expect.objectContaining({ id: '2', quantity: 7, Price: 0 }),
      ],
    }));
    expect(hubspotPriceClient.updateDealAmount).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: '77', totalAmount: 0 })
    );
    expect(notifyLineItemPriceOutcome).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('no está registrado en esta área de ventas'),
    }));
    expect(notifyLineItemPriceOutcome.mock.calls[0][0].body).toContain('CPDO/01');
    expect(notifyLineItemPriceOutcome.mock.calls[0][0].body).toContain('DPDO/01');
  });

  it('si no se pueden listar las áreas del cliente, igual pone los precios en 0', async () => {
    const { useCase, hubspotPriceClient, notifyLineItemPriceOutcome, priceListClient } = buildDeps();
    priceListClient.fetchCustomerSalesAreas = jest.fn(async (_customer, area) => {
      if (area) return [];
      throw new Error('SAP 500');
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'MQGT', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 2 }] },
      CONTEXT
    )).rejects.toThrow('is not registered in sales area');

    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledWith(expect.objectContaining({
      enrichedLineItems: [expect.objectContaining({ id: '1', quantity: 2, Price: 0 })],
    }));
    // La nota queda sin la lista de áreas, pero no dice "las áreas son:" y corta.
    expect(notifyLineItemPriceOutcome.mock.calls[0][0].body)
      .not.toContain('Las áreas de ventas que este cliente tiene');
  });

  it('con más de una fila en la misma área falla pidiendo la división, sin tocar HubSpot', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'CH', PriceListType: 'ZD' },
      ],
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow(/has 2 rows in sales area FQCR\/01.*division is needed/s);

    expect(hubspotPriceClient.updateLineItems).not.toHaveBeenCalled();
  });

  // Campos vacíos: los precios NO se tocan. Sin área no se consultó nada en SAP, así que no hay
  // nada que afirmar sobre las líneas.
  it.each([
    ['sin organización', { salesOrganization: '  ', distributionChannel: '01' }],
    ['sin canal', { salesOrganization: 'FQCR', distributionChannel: null }],
  ])('falla %s con la nota pidiendo el campo y sin tocar los precios', async (_label, area) => {
    const { useCase, hubspotPriceClient, notifyLineItemPriceOutcome, priceListClient } = buildDeps();

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', ...area, lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('Deal has no sales organization or distribution channel');

    expect(hubspotPriceClient.updateLineItems).not.toHaveBeenCalled();
    expect(hubspotPriceClient.updateDealAmount).not.toHaveBeenCalled();
    expect(priceListClient.fetchCustomerSalesAreas).not.toHaveBeenCalled();
    expect(notifyLineItemPriceOutcome).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('falta la organización de ventas'),
    }));
  });

  // La `price` del line item hereda la moneda del negocio, así que escribir ahí una tarifa en
  // otra moneda es un precio silenciosamente equivocado.
  it('saltea la línea cuya condición está en otra moneda y escribe las demás', async () => {
    const { useCase, notifyLineItemPriceOutcome } = buildDeps({
      candidatesByMaterial: {
        80000017: CANDIDATES_80000017,
        80000029: [{ ...CANDIDATES_80000017[0], material: '80000029', conditionCurrency: 'DOP', conditionRateValue: 75 }],
      },
    });

    const result = await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        salesOrganization: 'FQCR',
        distributionChannel: '01',
        dealCurrency: 'USD',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '80000029', quantity: 1 },
        ],
      },
      CONTEXT
    );

    expect(result.data.lineItems).toHaveLength(1);
    expect(result.data.lineItems[0].id).toBe('1');
    expect(result.data.skippedLineItems).toEqual([
      expect.objectContaining({
        id: '2',
        itemCode: '80000029',
        reason: 'condition currency DOP does not match the deal currency USD',
      }),
    ]);
    expect(notifyLineItemPriceOutcome.mock.calls[0][0].body)
      .toContain('does not match the deal currency USD');
  });

  it('sin dealCurrency no hay guardia de moneda y la condición se escribe tal cual', async () => {
    const { useCase } = buildDeps({
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], conditionCurrency: 'DOP', conditionRateValue: 75 }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.data.lineItems[0]).toMatchObject({ Price: 75, Currency: 'DOP' });
    expect(result.data.skippedLineItems).toEqual([]);
  });

  it('si TODAS las líneas fallan por moneda, el negocio falla y la nota lo explica', async () => {
    const { useCase, notifyLineItemPriceOutcome } = buildDeps({
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], conditionCurrency: 'DOP', conditionRateValue: 75 }],
      },
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', dealCurrency: 'USD', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('No line item prices could be resolved');

    expect(notifyLineItemPriceOutcome.mock.calls[0][0].body)
      .toContain('does not match the deal currency USD');
  });

  it('cae a la lista default cuando el cliente no tiene PriceListType, y el origen reportado es defaultPriceList', async () => {
    const { useCase } = buildDeps({
      salesAreas: [{ Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: '' }],
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], priceListType: 'ZA', conditionRateValue: 2.08 }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
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
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
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
        salesOrganization: 'FQCR',
        distributionChannel: '01',
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
        salesOrganization: 'FQCR',
        distributionChannel: '01',
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
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
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
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.audit.rounds[0].enrichedLineItems[0]).toEqual(
      expect.objectContaining({ conditionQuantityUnit: 'KG', conditionRecord: '0000418608' })
    );
  });

  it('deja nota en el deal cuando alguna línea quedó sin precio, y no cuando todas se valorizaron', async () => {
    const conSalteada = buildDeps({
      candidatesByMaterial: { 80000017: CANDIDATES_80000017, 99999999: [] },
    });

    await conSalteada.useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        salesOrganization: 'FQCR',
        distributionChannel: '01',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '99999999', quantity: 1 },
        ],
      },
      CONTEXT
    );

    expect(conSalteada.notifyLineItemPriceOutcome).toHaveBeenCalledWith(expect.objectContaining({
      dealId: '77',
      token: 'token',
      body: expect.stringContaining('99999999'),
    }));

    // Todo valorizado: el builder devuelve null y no se crea ninguna nota.
    const sinSalteadas = buildDeps();
    await sinSalteadas.useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );
    expect(sinSalteadas.notifyLineItemPriceOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ body: null })
    );
  });

  it('deja nota con el motivo cuando la corrida falla entera', async () => {
    const { useCase, notifyLineItemPriceOutcome } = buildDeps({
      candidatesByMaterial: { 80000017: [] },
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('No line item prices could be resolved');

    expect(notifyLineItemPriceOutcome).toHaveBeenCalledWith(expect.objectContaining({
      dealId: '77',
      token: 'token',
      body: expect.stringContaining('no se pudieron actualizar'),
    }));
  });

  it('exige notifyLineItemPriceOutcome en el constructor', () => {
    expect(() => new SyncS4LineItemPricesByPriceList({ dateProvider: () => new Date() }))
      .toThrow('notifyLineItemPriceOutcome is required');
  });

  it('saltea la línea sin tarifa y escribe las demás', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({
      candidatesByMaterial: { 80000017: CANDIDATES_80000017, 99999999: [] },
    });

    const result = await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        salesOrganization: 'FQCR',
        distributionChannel: '01',
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
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
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
        salesOrganization: 'FQCR',
        distributionChannel: '01',
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
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
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
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
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
        salesOrganization: 'FQCR',
        distributionChannel: '01',
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
      notifyLineItemPriceOutcome: jest.fn(async () => {}),
      dateProvider: () => new Date('2026-08-18T00:00:00.000Z'),
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', salesOrganization: 'FQCR', distributionChannel: '01', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
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
