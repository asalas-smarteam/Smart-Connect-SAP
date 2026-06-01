import { mapDocumentLines } from '../../../src/domain/orders/order-builder.service.js';

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
});
