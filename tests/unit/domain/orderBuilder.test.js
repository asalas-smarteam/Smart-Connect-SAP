import { jest } from '@jest/globals';
import {
  buildOrderFromQuotationPayload,
  buildOrderPayload,
  buildQuotationPayload,
  mapDocumentLines,
  mapHubspotToSapFields,
  resolveDocDueDate,
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

  // The product/product mappings drive the SAP -> HubSpot product sync, so they must never
  // leak into DocumentLines: Price / QuantityOnStock / ItemName do not exist on B1 lines.
  it('never leaks product sync mappings into the line', () => {
    const lines = mapDocumentLines({
      productMappings: [
        { sourceField: 'ItemCode', targetField: 'hs_sku' },
        { sourceField: 'ItemName', targetField: 'name' },
        { sourceField: 'QuantityOnStock', targetField: 'quantity' },
        { sourceField: 'Price', targetField: 'price' },
      ],
      taxCodes: [],
      lineItems: [
        { hs_sku: 'FVP1201N', name: 'Impresora', quantity: '4', price: '14000', warehouses: 'EP07' },
      ],
    });

    expect(lines[0]).toEqual({
      ItemCode: 'FVP1201N',
      Quantity: 4,
      UnitPrice: 14000,
      WarehouseCode: 'EP07',
    });
  });

  it('sends mapped line fields from lineMappings and skips line items without a value', () => {
    const lines = mapDocumentLines({
      productMappings,
      lineMappings: [
        { sourceField: 'U_TEXTO_LIBRE', targetField: 'u_texto_libre' },
        { sourceField: 'U_MESES_GARANTIA', targetField: 'u_meses_garantia' },
      ],
      taxCodes: [],
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          u_texto_libre: 'Texto de la linea',
          u_meses_garantia: '12',
        },
        { hs_sku: 'A56010005', quantity: '2', price: '10', u_texto_libre: '' },
      ],
    });

    expect(lines[0].U_TEXTO_LIBRE).toBe('Texto de la linea');
    expect(lines[0].U_MESES_GARANTIA).toBe('12');
    expect(lines[1]).not.toHaveProperty('U_TEXTO_LIBRE');
    expect(lines[1]).not.toHaveProperty('U_MESES_GARANTIA');
  });

  it('does not let lineMappings clobber the line fields owned by the builder', () => {
    const lines = mapDocumentLines({
      productMappings,
      lineMappings: [
        { sourceField: 'WarehouseCode', targetField: 'wrong_warehouse' },
        { sourceField: 'TaxCode', targetField: 'wrong_tax_code' },
        { sourceField: 'Quantity', targetField: 'wrong_quantity' },
      ],
      taxCodes: [{ Rate: 13, Code: 'IVA13' }],
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          warehouses: 'EP07',
          hs_tax_rate: '13',
          wrong_warehouse: 'ZZZ',
          wrong_tax_code: 'ZZZ',
          wrong_quantity: '999',
        },
      ],
    });

    expect(lines[0].WarehouseCode).toBe('EP07');
    expect(lines[0].TaxCode).toBe('IVA13');
    expect(lines[0].Quantity).toBe(1);
  });

  // B1 takes either the net price or the VAT-inclusive price, never both.
  it('omits UnitPrice when PriceAfterVAT is mapped', () => {
    const lines = mapDocumentLines({
      productMappings,
      lineMappings: [{ sourceField: 'PriceAfterVAT', targetField: 'price' }],
      taxCodes: [],
      lineItems: [{ hs_sku: 'A56010004', quantity: '1', price: '19.21' }],
    });

    expect(lines[0].PriceAfterVAT).toBe('19.21');
    expect(lines[0]).not.toHaveProperty('UnitPrice');
  });

  it('keeps UnitPrice when the line item has no value for the mapped PriceAfterVAT', () => {
    const lines = mapDocumentLines({
      productMappings,
      lineMappings: [{ sourceField: 'PriceAfterVAT', targetField: 'precio_con_iva' }],
      taxCodes: [],
      lineItems: [{ hs_sku: 'A56010004', quantity: '1', price: '19.21', precio_con_iva: '' }],
    });

    expect(lines[0]).not.toHaveProperty('PriceAfterVAT');
    expect(lines[0].UnitPrice).toBe(19.21);
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

  // Comments/U_ACO_Telefono/U_ACO_Telefono2/Address/Address2 no son parametros de
  // buildOrderPayload: ahora salen unicamente del derrame de mappedDealFields. La cobertura de
  // "el campo llega cuando se provee" se traslado a quotationBuilder.test.js ("buildOrderPayload
  // toma la cabecera del mapeo"), incluyendo el caso de un valor de solo espacios que se omite.
  // Esa omision de solo-espacios ya NO depende de un recorte hecho aca: ahora es
  // mapHubspotToSapFields quien descarta el valor antes de que llegue a mappedDealFields
  // (ver tests/unit/domain/mapHubspotToSapFields.test.js), asi que alcanza a los 4 tenants y a
  // todos los contextos, no solo a estos cinco campos de orders-quotations.

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
        DocumentLines: [],
        PaymentGroupCode: 'abc',
      },
    });

    expect(payload.CardCode).toBe('CL99999');
    expect(payload.DocumentLines).toHaveLength(1);
    expect(payload).not.toHaveProperty('PaymentGroupCode');
  });

  it('uses the DocDueDate mapped from HubSpot instead of today', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines: [{ ItemCode: 'A56010004', Quantity: 1 }],
      mappedDealFields: { DocDueDate: '2026-07-21' },
    });

    expect(payload.DocDueDate).toBe('2026-07-21');
  });

  it('falls back to today when the deal carries no DocDueDate', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL99999',
      documentLines: [{ ItemCode: 'A56010004', Quantity: 1 }],
      mappedDealFields: {},
    });

    expect(payload.DocDueDate).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('order-builder.service resolveDocDueDate', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('prefers the mapped HubSpot value over today', () => {
    expect(resolveDocDueDate({ mappedDeal: { DocDueDate: '2026-07-21' } })).toBe('2026-07-21');
  });

  it('trims the time component off an ISO datetime', () => {
    expect(resolveDocDueDate({ mappedDeal: { DocDueDate: '2026-07-21T00:00:00Z' } })).toBe(
      '2026-07-21'
    );
  });

  it('accepts HubSpot epoch-millis date properties', () => {
    const epochMillis = Date.UTC(2026, 6, 21);
    expect(resolveDocDueDate({ mappedDeal: { DocDueDate: String(epochMillis) } })).toBe(
      '2026-07-21'
    );
  });

  it('accepts a Date instance', () => {
    expect(resolveDocDueDate({ mappedDeal: { DocDueDate: new Date('2026-07-21T12:00:00Z') } })).toBe(
      '2026-07-21'
    );
  });

  // DocDueDate is mandatory in SAP, so an unusable value must never reach the payload
  // as-is: it degrades to today rather than failing the document.
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', '   '],
    ['not a date', 'manana'],
    ['impossible calendar date', '2026-13-45'],
  ])('falls back to today when the mapped value is %s', (_label, value) => {
    expect(resolveDocDueDate({ mappedDeal: { DocDueDate: value } })).toBe(today);
  });

  it('falls back to today when there is no mapped deal at all', () => {
    expect(resolveDocDueDate({})).toBe(today);
    expect(resolveDocDueDate()).toBe(today);
  });

  // The FieldMapping is { sourceField: 'DocDueDate', targetField: 'docduedate' }, so the
  // value only reaches the resolver if mapHubspotToSapFields read it off the HubSpot deal.
  it('reads the value produced by the DocDueDate field mapping', () => {
    const mappedDeal = mapHubspotToSapFields(
      { docduedate: '2026-07-21', dealname: 'PGN ROL' },
      [{ sourceField: 'DocDueDate', targetField: 'docduedate', isActive: true }]
    );

    expect(resolveDocDueDate({ mappedDeal })).toBe('2026-07-21');
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
