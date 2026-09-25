import { jest } from '@jest/globals';
import {
  S4_RESERVED_HEADER_FIELDS,
  buildS4QuotationPayload,
  resolveS4Plant,
} from '../../../src/domain/orders/s4-sales-document-builder.service.js';

const PRODUCT_MAPPINGS = [{ sourceField: 'ItemCode', targetField: 'hs_sku', isActive: true }];

const CONFIG = {
  quotationType: 'ZPQD',
  salesOrganization: 'MQGT',
  distributionChannel: '01',
  division: '00',
  salesPersonPartnerFunction: 'VE',
  priceConditionType: null,
};

const WAREHOUSE_FIELDS = [
  { label: 'MQGT 0008', value: 'mqgt_0008_stock', valueSAP: 'MQGT/0008' },
  { label: 'HFDO 0401', value: 'hfdo_0401_stock', valueSAP: 'HFDO/0401' },
];

function buildArgs(overrides = {}) {
  return {
    soldToParty: '100053',
    lineItems: [{ hs_sku: '1001', quantity: 2 }],
    productMappings: PRODUCT_MAPPINGS,
    lineMappings: [],
    mappedDealFields: {},
    salesDocumentConfig: CONFIG,
    warehouseFields: [],
    salesPersonId: null,
    logger: null,
    ...overrides,
  };
}

describe('buildS4QuotationPayload', () => {
  it('arma la cabecera y una posición con numeración de S/4', () => {
    expect(buildS4QuotationPayload(buildArgs())).toEqual({
      SalesQuotationType: 'ZPQD',
      SalesOrganization: 'MQGT',
      DistributionChannel: '01',
      OrganizationDivision: '00',
      SoldToParty: '100053',
      to_Item: [{ SalesQuotationItem: '000010', Material: '1001', RequestedQuantity: '2' }],
    });
  });

  it('numera las posiciones de diez en diez', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: 'A', quantity: 1 }, { hs_sku: 'B', quantity: 1 }, { hs_sku: 'C', quantity: 1 }],
    }));

    expect(payload.to_Item.map((item) => item.SalesQuotationItem)).toEqual(['000010', '000020', '000030']);
  });

  // El mapeo del negocio le gana al default: es lo que deja al asesor fijar el área por negocio.
  it('el mapeo del deal gana sobre el default de la config', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      mappedDealFields: { SalesOrganization: 'DPDO', DistributionChannel: '02' },
    }));

    expect(payload.SalesOrganization).toBe('DPDO');
    expect(payload.DistributionChannel).toBe('02');
    expect(payload.OrganizationDivision).toBe('00');
  });

  it('derrama los campos mapeados del deal que no son reservados, expandidos', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      mappedDealFields: {
        PurchaseOrderByCustomer: 'OC-1234',
        YY1_Observacion_SDH: 'texto libre',
      },
    }));

    expect(payload.PurchaseOrderByCustomer).toBe('OC-1234');
    expect(payload.YY1_Observacion_SDH).toBe('texto libre');
  });

  // SoldToParty y las navegaciones las posee el builder: un mapeo no puede pisarlas.
  it('un mapeo no puede pisar los campos reservados', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      mappedDealFields: { SoldToParty: 'PISADO', to_Item: 'PISADO' },
    }));

    expect(payload.SoldToParty).toBe('100053');
    expect(payload.to_Item).toEqual([
      { SalesQuotationItem: '000010', Material: '1001', RequestedQuantity: '2' },
    ]);
  });

  it('declara SoldToParty y las navegaciones como reservados de cabecera', () => {
    expect([...S4_RESERVED_HEADER_FIELDS].sort()).toEqual(
      ['SalesQuotation', 'SoldToParty', 'to_Item', 'to_Partner', 'to_PricingElement'].sort()
    );
  });

  it('derrama los campos mapeados de línea que no son reservados', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, unidad: 'KG' }],
      lineMappings: [{ sourceField: 'RequestedQuantityUnit', targetField: 'unidad', isActive: true }],
    }));

    expect(payload.to_Item[0].RequestedQuantityUnit).toBe('KG');
  });

  it('resuelve Plant desde la propiedad warehouses y fieldsWareHouseHS', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, warehouses: 'mqgt_0008_stock' }],
      warehouseFields: WAREHOUSE_FIELDS,
    }));

    expect(payload.to_Item[0].Plant).toBe('MQGT');
  });

  it('omite Plant con warn cuando warehouses no coincide con ninguna entrada', () => {
    const logger = { warn: jest.fn() };
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, warehouses: 'inexistente' }],
      warehouseFields: WAREHOUSE_FIELDS,
      logger,
    }));

    expect(payload.to_Item[0]).not.toHaveProperty('Plant');
    expect(logger.warn).toHaveBeenCalled();
  });

  // Plant lo resuelve resolveS4Plant, no un mapeo crudo: un lineMapping apuntando a Plant no
  // puede colar el value de HubSpot sin traducir cuando la bodega no resuelve el centro.
  it('un mapeo de línea a Plant no sobrevive cuando la bodega no resuelve el centro', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, warehouses: 'inexistente', centro: 'mqgt_0008_stock' }],
      lineMappings: [{ sourceField: 'Plant', targetField: 'centro', isActive: true }],
      warehouseFields: WAREHOUSE_FIELDS,
      logger: { warn: jest.fn() },
    }));

    expect(payload.to_Item[0]).not.toHaveProperty('Plant');
  });

  it('un mapeo de línea a Plant no pisa el centro resuelto cuando la bodega sí resuelve', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, warehouses: 'mqgt_0008_stock', centro: 'PISADO' }],
      lineMappings: [{ sourceField: 'Plant', targetField: 'centro', isActive: true }],
      warehouseFields: WAREHOUSE_FIELDS,
    }));

    expect(payload.to_Item[0].Plant).toBe('MQGT');
  });

  it('agrega to_Partner cuando hay función de interlocutor y vendedor', () => {
    const payload = buildS4QuotationPayload(buildArgs({ salesPersonId: '67' }));

    expect(payload.to_Partner).toEqual([{ PartnerFunction: 'VE', Personnel: '67' }]);
  });

  // Igual que DocumentsOwner en B1: la clave NO viaja en null, se omite entera.
  it('omite to_Partner cuando no hay vendedor resuelto', () => {
    expect(buildS4QuotationPayload(buildArgs({ salesPersonId: null })))
      .not.toHaveProperty('to_Partner');
  });

  it('omite to_Partner cuando la función de interlocutor no está configurada', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      salesDocumentConfig: { ...CONFIG, salesPersonPartnerFunction: null },
      salesPersonId: '67',
    }));

    expect(payload).not.toHaveProperty('to_Partner');
  });

  it('no manda precio por defecto', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, hs_effective_unit_price: 99 }],
    }));

    expect(payload.to_Item[0]).not.toHaveProperty('to_PricingElement');
  });

  it('manda to_PricingElement cuando la config declara un tipo de condición', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, hs_effective_unit_price: 99 }],
      salesDocumentConfig: { ...CONFIG, priceConditionType: 'ZPR0' },
      mappedDealFields: { TransactionCurrency: 'GTQ' },
    }));

    expect(payload.to_Item[0].to_PricingElement).toEqual([
      { ConditionType: 'ZPR0', ConditionRateValue: '99', ConditionCurrency: 'GTQ' },
    ]);
  });

  describe('validaciones', () => {
    it('tira permanente sin line items', () => {
      expect(() => buildS4QuotationPayload(buildArgs({ lineItems: [] })))
        .toThrow(/line_item/i);
    });

    it('tira permanente cuando falta el Material de una línea', () => {
      expect(() => buildS4QuotationPayload(buildArgs({ lineItems: [{ quantity: 1 }] })))
        .toThrow(/Material/i);
    });

    it('tira permanente con cantidad cero o negativa', () => {
      expect(() => buildS4QuotationPayload(buildArgs({ lineItems: [{ hs_sku: '1001', quantity: 0 }] })))
        .toThrow(/cantidad/i);
    });

    it('tira permanente nombrando el campo de cabecera que falta', () => {
      expect(() => buildS4QuotationPayload(buildArgs({
        salesDocumentConfig: { ...CONFIG, salesOrganization: null },
      }))).toThrow(/SalesOrganization/);
    });

    it('tira permanente sin soldToParty', () => {
      expect(() => buildS4QuotationPayload(buildArgs({ soldToParty: null })))
        .toThrow(/SoldToParty/);
      expect(() => buildS4QuotationPayload(buildArgs({ soldToParty: '' })))
        .toThrow(/SoldToParty/);
    });
  });
});

describe('resolveS4Plant', () => {
  it('traduce el value de HubSpot al centro del valueSAP', () => {
    expect(resolveS4Plant({
      lineItem: { warehouses: 'hfdo_0401_stock' },
      warehouseFields: WAREHOUSE_FIELDS,
    })).toBe('HFDO');
  });

  it('devuelve null sin propiedad warehouses', () => {
    expect(resolveS4Plant({ lineItem: {}, warehouseFields: WAREHOUSE_FIELDS })).toBeNull();
  });

  it('devuelve null cuando no hay entradas configuradas', () => {
    expect(resolveS4Plant({ lineItem: { warehouses: 'x' }, warehouseFields: [] })).toBeNull();
  });
});
