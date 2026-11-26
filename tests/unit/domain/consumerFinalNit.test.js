import {
  isConsumerFinalNit,
  normalizeConsumerFinalNitConfig,
  resolveConsumerFinalIdentity,
} from '../../../src/domain/business-partners/consumer-final-nit.service.js';

describe('isConsumerFinalNit', () => {
  it.each([
    '00000000C.F.',
    '00000000c.f.',
    '00000000C.F',
    'C.F.',
    'c.f',
    'CF',
    '0000-0000 C.F.',
    '  00000000C.F.  ',
  ])('detects %p as consumer final', (value) => {
    expect(isConsumerFinalNit(value)).toBe(true);
  });

  it.each([
    '1234567-8',
    '2345678901234',
    '12345678C.F.',
    'C.F.1',
    'ACF',
    '',
    null,
    undefined,
  ])('does not treat %p as consumer final', (value) => {
    expect(isConsumerFinalNit(value)).toBe(false);
  });
});

describe('normalizeConsumerFinalNitConfig', () => {
  it('is disabled when the key is absent or malformed', () => {
    const disabled = { enabled: false, identityProperty: null };
    expect(normalizeConsumerFinalNitConfig(undefined)).toEqual(disabled);
    expect(normalizeConsumerFinalNitConfig('yes')).toEqual(disabled);
    expect(normalizeConsumerFinalNitConfig({ enabled: 'true', identityProperty: 'cui' })).toEqual(disabled);
    expect(normalizeConsumerFinalNitConfig({ enabled: false, identityProperty: 'cui' })).toEqual(disabled);
  });

  it('is disabled when enabled but no identity property is named', () => {
    expect(normalizeConsumerFinalNitConfig({ enabled: true })).toEqual({
      enabled: false,
      identityProperty: null,
    });
  });

  it('keeps the identity property when enabled', () => {
    expect(normalizeConsumerFinalNitConfig({ enabled: true, identityProperty: ' cui ' })).toEqual({
      enabled: true,
      identityProperty: 'cui',
    });
  });
});

describe('resolveConsumerFinalIdentity', () => {
  const config = { enabled: true, identityProperty: 'cui' };

  it('returns the trimmed deal value when enabled', () => {
    expect(resolveConsumerFinalIdentity({ config, deal: { cui: ' 2345678901234 ' } }))
      .toBe('2345678901234');
  });

  it('returns null when disabled, missing or empty', () => {
    expect(resolveConsumerFinalIdentity({ config: { enabled: false, identityProperty: null }, deal: { cui: '1' } }))
      .toBeNull();
    expect(resolveConsumerFinalIdentity({ config, deal: {} })).toBeNull();
    expect(resolveConsumerFinalIdentity({ config, deal: { cui: '  ' } })).toBeNull();
    expect(resolveConsumerFinalIdentity({ config, deal: null })).toBeNull();
  });

  it('does not alter the value (no digit filtering)', () => {
    expect(resolveConsumerFinalIdentity({ config, deal: { cui: '2345 67890 1234' } }))
      .toBe('2345 67890 1234');
  });
});
