import { jest } from '@jest/globals';
import {
  normalizeProductPriceSource,
  resolveProductPriceFromItemPrices,
} from '../../../src/domain/products/product-price-source.service.js';
import {
  DEFAULT_PRODUCT_PRICE_SOURCE,
  PRODUCT_PRICE_SOURCES,
  PRODUCT_SYNC_ON_MISSING_PRICE,
} from '../../../src/domain/products/product-sync-strategy.constants.js';

// Payload real del tenant sap_integration_printer: la lista 1 tiene tarifa y
// de la 3 en adelante vienen en 0.0 con Currency null.
const ITEM_PRICES = [
  { PriceList: 1, Price: 36.607143, Currency: 'QTZ', AdditionalPrice1: 12.5, AdditionalCurrency1: 'USD' },
  { PriceList: 2, Price: 36.607143, Currency: 'QTZ', AdditionalPrice1: 0.0, AdditionalCurrency1: null },
  { PriceList: 3, Price: 0.0, Currency: null, AdditionalPrice1: 0.0, AdditionalCurrency1: null },
];

describe('normalizeProductPriceSource', () => {
  it('cae a mapped cuando requirePrice no trae source (tenant productivo)', () => {
    const result = normalizeProductPriceSource({ value: false, field: '' });

    expect(result.from).toBe(DEFAULT_PRODUCT_PRICE_SOURCE);
    expect(result.from).toBe(PRODUCT_PRICE_SOURCES.MAPPED);
  });

  it('cae a mapped cuando requirePrice es undefined', () => {
    expect(normalizeProductPriceSource(undefined).from).toBe(PRODUCT_PRICE_SOURCES.MAPPED);
  });

  it('lee from: itemPrices con sus defaults', () => {
    const result = normalizeProductPriceSource({
      value: false,
      field: '',
      source: { from: 'itemPrices' },
    });

    expect(result).toEqual({
      from: PRODUCT_PRICE_SOURCES.ITEM_PRICES,
      priceField: 'Price',
      onMissingPrice: PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO,
    });
  });

  it('respeta un priceField alterno', () => {
    const result = normalizeProductPriceSource({
      source: { from: 'itemPrices', priceField: 'AdditionalPrice1' },
    });

    expect(result.priceField).toBe('AdditionalPrice1');
  });

  it('cae a mapped y avisa cuando from no es soportado', () => {
    const logger = { warn: jest.fn() };

    const result = normalizeProductPriceSource({ source: { from: 'inventado' } }, { logger });

    expect(result.from).toBe(PRODUCT_PRICE_SOURCES.MAPPED);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('cae a SET_ZERO y avisa cuando onMissingPrice no esta implementado', () => {
    const logger = { warn: jest.fn() };

    const result = normalizeProductPriceSource(
      { source: { from: 'itemPrices', onMissingPrice: 'SKIP_PRODUCT' } },
      { logger }
    );

    expect(result.onMissingPrice).toBe(PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('resolveProductPriceFromItemPrices', () => {
  it('toma el Price de la fila cuyo PriceList coincide', () => {
    const result = resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: 1 });

    expect(result.price).toBe(36.607143);
    expect(result.row.PriceList).toBe(1);
  });

  it('acepta PriceList como string, porque SAP y Mongo mezclan tipos', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: '2' }).price)
      .toBe(36.607143);
  });

  it('devuelve null cuando la lista existe pero su Price es 0 (sin tarifa cargada)', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: 3 })).toBeNull();
  });

  it('devuelve null cuando no hay fila para la lista pedida', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: 9 })).toBeNull();
  });

  it('toma la columna alterna cuando se pide priceField', () => {
    const result = resolveProductPriceFromItemPrices({
      itemPrices: ITEM_PRICES,
      priceList: 1,
      priceField: 'AdditionalPrice1',
    });

    expect(result.price).toBe(12.5);
  });

  it('no revienta con ItemPrices ausente, vacio o no-array', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: undefined, priceList: 1 })).toBeNull();
    expect(resolveProductPriceFromItemPrices({ itemPrices: [], priceList: 1 })).toBeNull();
    expect(resolveProductPriceFromItemPrices({ itemPrices: 'nope', priceList: 1 })).toBeNull();
  });

  it('devuelve null cuando no hay lista de precios', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: null })).toBeNull();
  });
});
