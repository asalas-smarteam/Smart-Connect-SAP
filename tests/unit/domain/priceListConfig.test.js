import { resolvePriceListFromConfigValue } from '../../../src/domain/prices/price-list-config.service.js';

describe('price-list-config.service resolvePriceListFromConfigValue', () => {
  it('rejects scalar values (legacy format is no longer supported)', () => {
    expect(resolvePriceListFromConfigValue('4')).toBeNull();
    expect(resolvePriceListFromConfigValue(4)).toBeNull();
    expect(resolvePriceListFromConfigValue('')).toBeNull();
    expect(resolvePriceListFromConfigValue(null)).toBeNull();
    expect(resolvePriceListFromConfigValue(undefined)).toBeNull();
    expect(resolvePriceListFromConfigValue([4])).toBeNull();
  });

  it('resolves the currency entry from the currency map', () => {
    const value = { default: 4, GTQ: 4, USD: 5 };

    expect(resolvePriceListFromConfigValue(value, { currency: 'USD' })).toBe(5);
    expect(resolvePriceListFromConfigValue(value, { currency: 'GTQ' })).toBe(4);
  });

  it('matches currency keys case-insensitively and trims whitespace', () => {
    expect(resolvePriceListFromConfigValue({ default: 4, USD: 5 }, { currency: ' usd ' })).toBe(5);
    expect(resolvePriceListFromConfigValue({ default: 4, usd: 5 }, { currency: 'USD' })).toBe(5);
  });

  it('falls back to the default entry when the currency is missing or its value is invalid', () => {
    expect(resolvePriceListFromConfigValue({ default: 4, USD: 5 }, { currency: 'CRC' })).toBe(4);
    expect(resolvePriceListFromConfigValue({ default: 4, USD: 'abc' }, { currency: 'USD' })).toBe(4);
    expect(resolvePriceListFromConfigValue({ default: '4', USD: 5 })).toBe(4);
  });

  it('accepts string and number entry values, rejecting non positive integers', () => {
    expect(resolvePriceListFromConfigValue({ default: '7' })).toBe(7);
    expect(resolvePriceListFromConfigValue({ default: 0 })).toBeNull();
    expect(resolvePriceListFromConfigValue({ default: -2 })).toBeNull();
    expect(resolvePriceListFromConfigValue({ default: 4.5 })).toBeNull();
  });

  it('returns null for a map without a resolvable entry', () => {
    expect(resolvePriceListFromConfigValue({}, { currency: 'USD' })).toBeNull();
    expect(resolvePriceListFromConfigValue({ USD: 5 }, { currency: 'CRC' })).toBeNull();
    expect(resolvePriceListFromConfigValue({ default: 'abc' })).toBeNull();
  });
});
