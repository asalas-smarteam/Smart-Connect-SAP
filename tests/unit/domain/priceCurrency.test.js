import {
  getPriceForCurrency,
  selectPriceListRow,
} from '../../../src/domain/prices/price-currency.service.js';

// Fila real de ejemplo validada por Postman contra el Service Layer de SAP.
const ITEM_PRICES = [
  {
    PriceList: 2,
    Price: 0.0,
    Currency: 'QTZ',
    AdditionalPrice1: 49.96,
    AdditionalCurrency1: 'USD',
    AdditionalPrice2: 0.0,
    AdditionalCurrency2: null,
  },
  {
    PriceList: 4,
    Price: 1011.84,
    Currency: 'QTZ',
    AdditionalPrice1: 126.48,
    AdditionalCurrency1: 'USD',
    AdditionalPrice2: 0.0,
    AdditionalCurrency2: '',
  },
  {
    PriceList: 6,
    Price: 1241.2,
    Currency: 'QTZ',
    AdditionalPrice1: 155.15,
    AdditionalCurrency1: 'USD',
    AdditionalPrice2: 0.0,
    AdditionalCurrency2: '',
  },
];

describe('price-currency.service selectPriceListRow', () => {
  it('finds the row matching the price list number', () => {
    expect(selectPriceListRow(ITEM_PRICES, 6)).toMatchObject({ PriceList: 6 });
    expect(selectPriceListRow(ITEM_PRICES, '4')).toMatchObject({ PriceList: 4 });
  });

  it('returns null for missing lists or invalid input', () => {
    expect(selectPriceListRow(ITEM_PRICES, 99)).toBeNull();
    expect(selectPriceListRow(ITEM_PRICES, null)).toBeNull();
    expect(selectPriceListRow(null, 6)).toBeNull();
  });
});

describe('price-currency.service getPriceForCurrency', () => {
  it('returns the base Price when the base currency matches', () => {
    expect(getPriceForCurrency(ITEM_PRICES[2], 'QTZ')).toBe(1241.2);
  });

  it('returns AdditionalPrice1 when the additional currency matches', () => {
    expect(getPriceForCurrency(ITEM_PRICES[2], 'USD')).toBe(155.15);
  });

  it('skips pairs whose price is zero', () => {
    // Lista 2: Price QTZ es 0.0, así que en QTZ no hay precio aunque la fila exista.
    expect(getPriceForCurrency(ITEM_PRICES[0], 'QTZ')).toBeNull();
    expect(getPriceForCurrency(ITEM_PRICES[0], 'USD')).toBe(49.96);
  });

  it('returns null when the currency is not present in the row', () => {
    expect(getPriceForCurrency(ITEM_PRICES[2], 'EUR')).toBeNull();
  });

  it('matches currencies case-insensitively', () => {
    expect(getPriceForCurrency(ITEM_PRICES[2], 'usd')).toBe(155.15);
  });

  it('returns null for missing row or currency', () => {
    expect(getPriceForCurrency(null, 'USD')).toBeNull();
    expect(getPriceForCurrency(ITEM_PRICES[2], null)).toBeNull();
    expect(getPriceForCurrency(ITEM_PRICES[2], '')).toBeNull();
  });
});
