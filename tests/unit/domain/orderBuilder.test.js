import { jest } from '@jest/globals';
import {
  buildOrderPayload,
  mapDocumentLines,
} from '../../../src/domain/orders/order-builder.service.js';

describe('order-builder.service mapDocumentLines', () => {
  const productMappings = [
    { sourceField: 'ItemCode', targetField: 'hs_sku' },
    { sourceField: 'Quantity', targetField: 'quantity' },
    { sourceField: 'UnitPrice', targetField: 'price' },
  ];

  it('maps TaxCode from the configured tax code with the same hs_tax_rate', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [
        { Rate: 15, Code: 'IVA' },
        { Rate: 0, Code: 'EXE' },
      ],
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          warehouses: 'B04',
          hs_tax_rate: '15.0000',
        },
      ],
    });

    expect(lines).toEqual([
      {
        ItemCode: 'A56010004',
        Quantity: 1,
        UnitPrice: 19.21,
        WarehouseCode: 'B04',
        TaxCode: 'IVA',
      },
    ]);
  });

  it('maps TaxCode for zero-rated line items', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [{ Rate: 0, Code: 'EXE' }],
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          hs_tax_rate: '0.0000',
        },
      ],
    });

    expect(lines[0].TaxCode).toBe('EXE');
  });

  it('fails before sending to SAP when hs_tax_rate has no configured TaxCode', () => {
    expect(() => mapDocumentLines({
      productMappings,
      taxCodes: [{ Rate: 0, Code: 'EXE' }],
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          hs_tax_rate: '15.0000',
        },
      ],
    })).toThrow('TaxCode is not configured for hs_tax_rate 15.0000');
  });

  it('uses configured original price property as SAP UnitPrice when misc calculation is active', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [],
      miscPriceCalculationConfig: {
        enableMiscPriceCalculation: true,
        originalPriceTargetProperty: 'safe_amount',
      },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '2',
          price: '115',
          safe_amount: '100',
        },
      ],
    });

    expect(lines).toEqual([
      {
        ItemCode: 'A56010004',
        Quantity: 2,
        UnitPrice: 100,
        WarehouseCode: undefined,
      },
    ]);
  });

  it('adds percentual misc value to original price when misc calculation is active', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [],
      miscPriceCalculationConfig: {
        enableMiscPriceCalculation: true,
        originalPriceTargetProperty: 'safe_amount',
        miscSourceProperty: 'misc',
        miscCalculationType: 'porcentual',
      },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '2',
          price: '115',
          safe_amount: '100',
          misc: '15',
        },
      ],
    });

    expect(lines[0].UnitPrice).toBe(115);
  });

  it('adds fixed misc value to original price when misc calculation is active', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [],
      miscPriceCalculationConfig: {
        enableMiscPriceCalculation: true,
        originalPriceTargetProperty: 'safe_amount',
        miscSourceProperty: 'misc',
        miscCalculationType: 'fijo',
      },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '2',
          price: '400',
          safe_amount: '100',
          misc: '300',
        },
      ],
    });

    expect(lines[0].UnitPrice).toBe(400);
  });

  it('logs warning when misc config is incomplete while mapping SAP order lines', () => {
    const logger = { warn: jest.fn() };

    mapDocumentLines({
      productMappings,
      taxCodes: [],
      logger,
      miscPriceCalculationConfig: {
        enableMiscPriceCalculation: true,
        originalPriceTargetProperty: 'safe_amount',
      },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '2',
          safe_amount: '100',
        },
      ],
    });

    expect(logger.warn).toHaveBeenCalledWith({
      msg: 'Misc price calculation config is incomplete',
      itemCode: 'A56010004',
    });
  });
});

describe('order-builder.service buildOrderPayload', () => {
  it('adds SalesPersonCode when SAP owner id is resolved as an integer', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL99999',
      slpCode: 5,
      documentLines: [
        {
          ItemCode: 'A56010004',
          Quantity: 1,
        },
      ],
    });

    expect(payload).toEqual({
      CardCode: 'CL99999',
      DocDueDate: expect.any(String),
      SalesPersonCode: 5,
      DocumentLines: [
        {
          ItemCode: 'A56010004',
          Quantity: 1,
        },
      ],
    });
  });
});
