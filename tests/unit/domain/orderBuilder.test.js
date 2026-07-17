import { jest } from '@jest/globals';
import {
  buildOrderFromQuotationPayload,
  buildOrderPayload,
  buildQuotationPayload,
  mapDocumentLines,
  resolvePaymentGroupCode,
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

  it('does not add DiscountPercent when requireDiscounts is not configured', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [],
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          hs_discount_percentage: '5',
        },
      ],
    });

    expect(lines[0]).not.toHaveProperty('DiscountPercent');
  });

  it('does not add DiscountPercent when requireDiscounts.isRequired is false', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [],
      discountConfig: { isRequired: false, fieldMappings: { Discount: 'hs_discount_percentage' } },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          hs_discount_percentage: '5',
        },
      ],
    });

    expect(lines[0]).not.toHaveProperty('DiscountPercent');
  });

  it('adds DiscountPercent from hs_discount_percentage when isRequired and no field override', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [],
      discountConfig: { isRequired: true, fieldMappings: {} },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          hs_discount_percentage: '5',
        },
      ],
    });

    expect(lines[0].DiscountPercent).toBe(5);
  });

  it('reads the discount from the configured fieldMappings.Discount field', () => {
    const lines = mapDocumentLines({
      productMappings,
      taxCodes: [],
      discountConfig: { isRequired: true, fieldMappings: { Discount: 'discount' } },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          discount: '12',
          hs_discount_percentage: '5',
        },
      ],
    });

    expect(lines[0].DiscountPercent).toBe(12);
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

  it('adds Comments when deal comments are provided and omits them when empty', () => {
    const documentLines = [
      {
        ItemCode: 'A56010004',
        Quantity: 1,
      },
    ];

    const withComments = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines,
      comments: 'COMENTARIO DE PRUEBA',
    });
    expect(withComments.Comments).toBe('COMENTARIO DE PRUEBA');

    const withoutComments = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines,
      comments: '   ',
    });
    expect(withoutComments).not.toHaveProperty('Comments');
  });

  it('adds phone and address fields when provided and omits them when null or empty', () => {
    const documentLines = [
      {
        ItemCode: 'A56010004',
        Quantity: 1,
      },
    ];

    const payload = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines,
      U_ACO_Telefono: '+50589496681',
      U_ACO_Telefono2: null,
      Address: '',
      Address2: 'En Ferretería Noelito, sobre la carretera',
    });

    expect(payload.U_ACO_Telefono).toBe('+50589496681');
    expect(payload.Address2).toBe('En Ferretería Noelito, sobre la carretera');
    expect(payload).not.toHaveProperty('U_ACO_Telefono2');
    expect(payload).not.toHaveProperty('Address');
  });

  it('adds PaymentGroupCode when an integer is provided and omits it otherwise', () => {
    const documentLines = [
      {
        ItemCode: 'A56010004',
        Quantity: 1,
      },
    ];

    const withPaymentGroupCode = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines,
      paymentGroupCode: 3,
    });
    expect(withPaymentGroupCode.PaymentGroupCode).toBe(3);

    const withoutPaymentGroupCode = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines,
      paymentGroupCode: null,
    });
    expect(withoutPaymentGroupCode).not.toHaveProperty('PaymentGroupCode');
  });

  it('spreads mapped deal header fields like CardName into the payload', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines: [{ ItemCode: 'A56010004', Quantity: 1 }],
      mappedDealFields: { CardName: 'Maleny Benavides', U_CustomField: 'X' },
    });

    expect(payload.CardName).toBe('Maleny Benavides');
    expect(payload.U_CustomField).toBe('X');
  });

  it('never lets mapped deal fields clobber CardCode, DocumentLines or PaymentGroupCode', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines: [{ ItemCode: 'A56010004', Quantity: 1 }],
      paymentGroupCode: null,
      mappedDealFields: {
        CardCode: 'HACKED',
        DocDueDate: '1999-01-01',
        DocumentLines: [],
        PaymentGroupCode: 'abc',
      },
    });

    expect(payload.CardCode).toBe('CL99999');
    expect(payload.DocDueDate).not.toBe('1999-01-01');
    expect(payload.DocumentLines).toHaveLength(1);
    expect(payload).not.toHaveProperty('PaymentGroupCode');
  });
});

describe('order-builder.service resolvePaymentGroupCode', () => {
  it('prefers the mapped deal value over the config default', () => {
    expect(resolvePaymentGroupCode({
      mappedDeal: { PaymentGroupCode: '3' },
      groupCodeDefaults: { PaymentGroupCode: 2 },
    })).toBe(3);
  });

  it('keeps a mapped value of 0 instead of falling back to the default', () => {
    expect(resolvePaymentGroupCode({
      mappedDeal: { PaymentGroupCode: 0 },
      groupCodeDefaults: { PaymentGroupCode: 2 },
    })).toBe(0);
  });

  it('falls back to the config default when the mapped value is missing or invalid', () => {
    expect(resolvePaymentGroupCode({
      mappedDeal: {},
      groupCodeDefaults: { PaymentGroupCode: 2 },
    })).toBe(2);

    expect(resolvePaymentGroupCode({
      mappedDeal: { PaymentGroupCode: 'abc' },
      groupCodeDefaults: { PaymentGroupCode: '2' },
    })).toBe(2);
  });

  it('returns null when neither the mapping nor the config provides a value', () => {
    expect(resolvePaymentGroupCode({ mappedDeal: {}, groupCodeDefaults: null })).toBeNull();
    expect(resolvePaymentGroupCode({})).toBeNull();
  });
});

describe('order-builder.service quotation payloads and PaymentGroupCode', () => {
  const documentLines = [
    {
      ItemCode: 'A56010004',
      Quantity: 1,
    },
  ];

  it('adds PaymentGroupCode to the quotation payload when an integer is provided', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL99999',
      documentLines,
      paymentGroupCode: 2,
    });

    expect(payload.PaymentGroupCode).toBe(2);
  });

  it('omits PaymentGroupCode from the quotation payload when it is null', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL99999',
      documentLines,
      paymentGroupCode: null,
    });

    expect(payload).not.toHaveProperty('PaymentGroupCode');
  });

  it('spreads mapped deal header fields like CardName into the quotation payload', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL99999',
      documentLines,
      mappedDealFields: { CardName: 'Maleny Benavides', CardCode: 'HACKED' },
    });

    expect(payload.CardName).toBe('Maleny Benavides');
    expect(payload.CardCode).toBe('CL99999');
  });

  it('omits mapped deal header fields when no mapping produced values', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL99999',
      documentLines,
    });

    expect(payload).not.toHaveProperty('CardName');
  });

  it('never emits PaymentGroupCode when converting a quotation to an order', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL99999',
      baseEntry: 12345,
      baseLines: [{ sapLineNum: 0 }],
    });

    expect(payload).not.toHaveProperty('PaymentGroupCode');
    expect(payload.DocumentLines[0]).toMatchObject({ BaseEntry: 12345, BaseLine: 0 });
  });
});
