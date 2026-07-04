import {
  QUOTATION_BASE_TYPE,
  buildOrderFromQuotationPayload,
  buildQuotationLineUpdates,
  buildQuotationPayload,
} from '../../../src/domain/orders/order-builder.service.js';

describe('order-builder.service buildQuotationPayload', () => {
  it('builds a Quotation payload with NumAtCard, Comments and SalesPersonCode', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      slpCode: 5,
      numAtCard: 'HS-DEAL-123',
      comments: 'Oferta creada desde HubSpot',
    });

    expect(payload).toMatchObject({
      CardCode: 'CL00129',
      NumAtCard: 'HS-DEAL-123',
      Comments: 'Oferta creada desde HubSpot',
      SalesPersonCode: 5,
      DocumentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });
    expect(payload.DocDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('throws when there are no document lines', () => {
    expect(() => buildQuotationPayload({ cardCode: 'CL1', documentLines: [] })).toThrow(
      /At least one line_item/
    );
  });
});

describe('order-builder.service buildOrderFromQuotationPayload', () => {
  it('builds DocumentLines referencing the quotation with BaseType 23', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [{ sapLineNum: 0 }, { sapLineNum: 1 }],
      slpCode: 7,
    });

    expect(QUOTATION_BASE_TYPE).toBe(23);
    expect(payload.CardCode).toBe('CL00129');
    expect(payload.SalesPersonCode).toBe(7);
    expect(payload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 12345, BaseLine: 0 },
      { BaseType: 23, BaseEntry: 12345, BaseLine: 1 },
    ]);
  });

  it('accepts plain numeric base lines', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL1',
      baseEntry: 9,
      baseLines: [0, 2],
    });

    expect(payload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 9, BaseLine: 0 },
      { BaseType: 23, BaseEntry: 9, BaseLine: 2 },
    ]);
  });

  it('throws when baseEntry is invalid', () => {
    expect(() => buildOrderFromQuotationPayload({ cardCode: 'CL1', baseEntry: null, baseLines: [0] })).toThrow(
      /valid quotation BaseEntry/
    );
  });

  it('throws when there are no base lines', () => {
    expect(() => buildOrderFromQuotationPayload({ cardCode: 'CL1', baseEntry: 1, baseLines: [] })).toThrow(
      /At least one quotation line/
    );
  });
});

describe('order-builder.service buildQuotationLineUpdates', () => {
  const productMappings = [
    { sourceField: 'ItemCode', targetField: 'hs_sku' },
    { sourceField: 'Quantity', targetField: 'quantity' },
    { sourceField: 'UnitPrice', targetField: 'price' },
  ];
  const linkLines = [
    { hubspotLineItemId: 'li-1', sapLineNum: 0 },
    { hubspotLineItemId: 'li-2', sapLineNum: 1 },
  ];

  it('builds line updates matched by stored LineNum (existing lines only)', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines,
      taxCodes: [{ Rate: 15, Code: 'IVA' }],
      discountConfig: { isRequired: true, fieldMappings: {} },
      lineItems: [
        {
          hubspot_id: 'li-1',
          hs_sku: 'A01',
          quantity: '2',
          price: '17.5',
          hs_discount_percentage: '5',
          hs_tax_rate: '15.0000',
        },
      ],
    });

    expect(updates).toEqual([
      {
        LineNum: 0,
        UnitPrice: 17.5,
        Quantity: 2,
        DiscountPercent: 5,
        TaxCode: 'IVA',
      },
    ]);
  });

  it('matches by product id and takes UnitPrice from `price` and WarehouseCode from the payload', () => {
    // HubSpot workflow sends the product id in hubspot_id instead of the line item id,
    // the price in `price`, and may change the warehouse via `warehouseCode`.
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines: [
        { hubspotLineItemId: '56431574047', hubspotProductId: '45616885779', sku: '101-0029', sapLineNum: 0 },
      ],
      taxCodes: [{ Rate: 15, Code: 'IVA' }],
      discountConfig: { isRequired: true, fieldMappings: {} },
      lineItems: [
        {
          hubspot_id: '45616885779',
          hs_sku: '101-0029',
          quantity: '2',
          price: '86302.62',
          hs_discount_percentage: '0',
          hs_tax_rate: '15.0000',
          warehouseCode: '02',
        },
      ],
    });

    expect(updates).toEqual([
      { LineNum: 0, UnitPrice: 86302.62, Quantity: 2, DiscountPercent: 0, WarehouseCode: '02', TaxCode: 'IVA' },
    ]);
  });

  it('omits DiscountPercent when requireDiscounts.isRequired is false', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines,
      taxCodes: [{ Rate: 15, Code: 'IVA' }],
      discountConfig: { isRequired: false, fieldMappings: { Discount: 'hs_discount_percentage' } },
      lineItems: [
        {
          hubspot_id: 'li-1',
          hs_sku: 'A01',
          quantity: '2',
          price: '17.5',
          hs_discount_percentage: '5',
          hs_tax_rate: '15.0000',
        },
      ],
    });

    expect(updates[0]).not.toHaveProperty('DiscountPercent');
  });

  it('reads the discount from the configured fieldMappings.Discount field', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines,
      discountConfig: { isRequired: true, fieldMappings: { Discount: 'discount' } },
      lineItems: [
        {
          hubspot_id: 'li-1',
          hs_sku: 'A01',
          quantity: '2',
          price: '17.5',
          discount: '8',
          hs_discount_percentage: '5',
        },
      ],
    });

    expect(updates[0].DiscountPercent).toBe(8);
  });

  it('falls back to SKU matching when no id matches', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines: [{ hubspotLineItemId: 'x', hubspotProductId: 'y', sku: '101-0029', sapLineNum: 3 }],
      lineItems: [{ hs_sku: '101-0029', quantity: '1', price: '5' }],
    });

    expect(updates).toEqual([{ LineNum: 3, UnitPrice: 5, Quantity: 1 }]);
  });

  it('throws when none match by id or SKU', () => {
    expect(() =>
      buildQuotationLineUpdates({
        productMappings,
        linkLines,
        lineItems: [{ hubspot_id: 'unknown', hs_sku: 'A99', price: '1' }],
      })
    ).toThrow(/No matching quotation lines/);
  });
});
