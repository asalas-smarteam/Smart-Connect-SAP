import {
  INVENTORY_TRANSFER_REQUEST_BASE_TYPE,
  buildInventoryTransferRequestPayload,
  mapStockTransferLines,
} from '../../../src/domain/inventory/inventory-transfer-request-builder.service.js';

const ITEM_LINE_MAPPINGS = [
  { sourceField: 'ItemCode', targetField: 'hs_sku' },
  { sourceField: 'Quantity', targetField: 'quantity' },
  { sourceField: 'FromWarehouseCode', targetField: 'filler' },
  { sourceField: 'WarehouseCode', targetField: 'towhscode' },
];

const HEADER_MAPPINGS = [
  { sourceField: 'FromWarehouse', targetField: 'filler' },
  { sourceField: 'ToWarehouse', targetField: 'towhscode' },
];

function mapDealHeader(deal, mappings = HEADER_MAPPINGS) {
  // Mirrors what the use case does: mapHubspotToSapFields(deal, dealInventoryTransferRequestMappings).
  const mapped = {};
  for (const mapping of mappings) {
    const value = deal?.[mapping.targetField];
    if (value !== null && typeof value !== 'undefined' && value !== '') {
      mapped[mapping.sourceField] = value;
    }
  }
  return mapped;
}

describe('mapStockTransferLines', () => {
  it('maps a line purely from FieldMapping output, with no extra or reserved fields', () => {
    const lines = mapStockTransferLines({
      lineItems: [{ hs_sku: 'A01', quantity: '3', filler: 'B01', towhscode: 'B02' }],
      lineMappings: ITEM_LINE_MAPPINGS,
    });

    expect(lines).toEqual([
      { ItemCode: 'A01', Quantity: 3, FromWarehouseCode: 'B01', WarehouseCode: 'B02' },
    ]);
  });

  it('does not add TaxCode or DiscountPercent: this document has neither', () => {
    const lines = mapStockTransferLines({
      lineItems: [{ hs_sku: 'A01', quantity: '1', hs_tax_rate: '13' }],
      lineMappings: ITEM_LINE_MAPPINGS,
    });

    expect(lines[0]).not.toHaveProperty('TaxCode');
    expect(lines[0]).not.toHaveProperty('DiscountPercent');
  });

  it('spreads mapped extra fields (e.g. U_Motivo) through untouched', () => {
    const lines = mapStockTransferLines({
      lineItems: [{ hs_sku: 'A01', quantity: '1', motivo: 'Reposición' }],
      lineMappings: [...ITEM_LINE_MAPPINGS, { sourceField: 'U_Motivo', targetField: 'motivo' }],
    });

    expect(lines[0].U_Motivo).toBe('Reposición');
  });

  it('does not inherit warehouses from the header: a line without its own mapping is sent without them', () => {
    const lines = mapStockTransferLines({
      lineItems: [{ hs_sku: 'A01', quantity: '1' }],
      lineMappings: ITEM_LINE_MAPPINGS,
    });

    expect(lines[0]).not.toHaveProperty('FromWarehouseCode');
    expect(lines[0]).not.toHaveProperty('WarehouseCode');
  });

  it('coerces a string Quantity to a number', () => {
    const lines = mapStockTransferLines({
      lineItems: [{ hs_sku: 'A01', quantity: '3' }],
      lineMappings: ITEM_LINE_MAPPINGS,
    });

    expect(lines[0].Quantity).toBe(3);
  });

  it('throws a permanent error naming the field and context when ItemCode is missing', () => {
    expect(() => mapStockTransferLines({
      lineItems: [{ quantity: '1' }],
      lineMappings: ITEM_LINE_MAPPINGS,
    })).toThrow(/ItemCode/);

    try {
      mapStockTransferLines({ lineItems: [{ quantity: '1' }], lineMappings: ITEM_LINE_MAPPINGS });
    } catch (error) {
      expect(error.permanent).toBe(true);
      expect(error.message).toMatch(/inventory-transfer-request/);
    }
  });

  it('throws a permanent error when Quantity is zero, non-numeric, or absent', () => {
    for (const badLineItem of [
      { hs_sku: 'A01', quantity: '0' },
      { hs_sku: 'A01', quantity: 'abc' },
      { hs_sku: 'A01' },
    ]) {
      expect(() => mapStockTransferLines({
        lineItems: [badLineItem],
        lineMappings: ITEM_LINE_MAPPINGS,
      })).toThrow(/Quantity/);
    }
  });
});

describe('buildInventoryTransferRequestPayload', () => {
  const stockTransferLines = [{ ItemCode: 'A01', Quantity: 1 }];

  it('emits StockTransferLines, not DocumentLines/DocDueDate/PaymentGroupCode', () => {
    const payload = buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      stockTransferLines,
    });

    expect(payload.StockTransferLines).toEqual(stockTransferLines);
    expect(payload.DocumentLines).toBeUndefined();
    expect(payload.DocDueDate).toBeUndefined();
    expect(payload.PaymentGroupCode).toBeUndefined();
  });

  it('emits nothing beyond what was mapped: no DocDate, no Comments, no DueDate by default', () => {
    const payload = buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      stockTransferLines,
    });

    expect(payload.DocDate).toBeUndefined();
    expect(payload.DueDate).toBeUndefined();
    expect(payload.Comments).toBeUndefined();
  });

  it('passes through mapped optional header fields (e.g. Comments, U_*) untouched', () => {
    const mappedDealFields = {
      ...mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      Comments: 'HS-DEAL-59680314911',
      U_Sucursal: 'CENTRAL',
    };

    const payload = buildInventoryTransferRequestPayload({ mappedDealFields, stockTransferLines });

    expect(payload.Comments).toBe('HS-DEAL-59680314911');
    expect(payload.U_Sucursal).toBe('CENTRAL');
  });

  it('drops a DocumentLines field that leaked in from a copy-pasted orders mapping', () => {
    const mappedDealFields = {
      ...mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      DocumentLines: [{ ItemCode: 'ROGUE' }],
    };

    const payload = buildInventoryTransferRequestPayload({ mappedDealFields, stockTransferLines });

    expect(payload.DocumentLines).toBeUndefined();
    expect(payload.StockTransferLines).toEqual(stockTransferLines);
  });

  it('omits CardCode and SalesPersonCode when neither resolves', () => {
    const payload = buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      stockTransferLines,
      cardCode: null,
      slpCode: null,
    });

    expect(payload).not.toHaveProperty('CardCode');
    expect(payload).not.toHaveProperty('SalesPersonCode');
  });

  it('includes CardCode and SalesPersonCode when both resolve', () => {
    const payload = buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      stockTransferLines,
      cardCode: 'CL00129',
      slpCode: 61,
    });

    expect(payload.CardCode).toBe('CL00129');
    expect(payload.SalesPersonCode).toBe(61);
  });

  it('a resolved cardCode wins over one mapped from the deal', () => {
    const mappedDealFields = {
      ...mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      CardCode: 'CL_FROM_MAPPING',
    };

    const payload = buildInventoryTransferRequestPayload({
      mappedDealFields,
      stockTransferLines,
      cardCode: 'CL_RESOLVED',
    });

    expect(payload.CardCode).toBe('CL_RESOLVED');
  });

  it('throws a permanent error naming FromWarehouse/filler when the source warehouse is missing', () => {
    expect(() => buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ towhscode: 'B02' }),
      stockTransferLines,
    })).toThrow(/FromWarehouse/);
  });

  it('throws a permanent error naming ToWarehouse/towhscode when the destination warehouse is missing', () => {
    expect(() => buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ filler: 'B01' }),
      stockTransferLines,
    })).toThrow(/ToWarehouse/);
  });

  it('marks the warehouse errors as permanent (no retry)', () => {
    try {
      buildInventoryTransferRequestPayload({
        mappedDealFields: mapDealHeader({}),
        stockTransferLines,
      });
      throw new Error('expected buildInventoryTransferRequestPayload to throw');
    } catch (error) {
      expect(error.permanent).toBe(true);
    }
  });

  it('throws when source and destination warehouse are the same', () => {
    expect(() => buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ filler: 'B01', towhscode: 'B01' }),
      stockTransferLines,
    })).toThrow(/same/);
  });

  it('throws when there are no line items', () => {
    expect(() => buildInventoryTransferRequestPayload({
      mappedDealFields: mapDealHeader({ filler: 'B01', towhscode: 'B02' }),
      stockTransferLines: [],
    })).toThrow(/line_item/);
  });

  it('exposes the OWTQ base type constant used for the SapDocumentLink', () => {
    expect(INVENTORY_TRANSFER_REQUEST_BASE_TYPE).toBe(1250000001);
  });
});
