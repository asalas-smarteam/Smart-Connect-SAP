import {
  isConsumerFinalNit,
  normalizeConsumerFinalPlaceholders,
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
      placeholders: [],
    });
  });

  it('normalizes the configured placeholders and drops invalid entries', () => {
    expect(normalizeConsumerFinalNitConfig({
      enabled: true,
      identityProperty: 'cui',
      placeholders: [' 0000-0000 c.f. ', '', '  ', 5, null, 'X.Y'],
    })).toEqual({ enabled: true, identityProperty: 'cui', placeholders: ['00000000CF', 'XY'] });
  });

  it('yields no placeholders when the field is not an array', () => {
    expect(normalizeConsumerFinalNitConfig({ enabled: true, identityProperty: 'cui', placeholders: 'CF' }))
      .toEqual({ enabled: true, identityProperty: 'cui', placeholders: [] });
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

describe('isConsumerFinalNit with custom placeholders', () => {
  const placeholders = normalizeConsumerFinalPlaceholders(['00000000C.F.', 'consumidor-final']);

  it.each(['00000000C.F.', '0000 0000 c-f', 'Consumidor Final', 'consumidor.final'])(
    'matches %p',
    (value) => {
      expect(isConsumerFinalNit(value, placeholders)).toBe(true);
    }
  );

  it.each(['C.F.', '000000000C.F.', '1234567-8', 'consumidor', null, ''])(
    'does not match %p (exact match only, no legacy pattern)',
    (value) => {
      expect(isConsumerFinalNit(value, placeholders)).toBe(false);
    }
  );

  it.each([undefined, null, [], 'CF', [' ', 3, null]])(
    'falls back to the legacy pattern when placeholders is %p',
    (list) => {
      expect(isConsumerFinalNit('00000000C.F.', list)).toBe(true);
      expect(isConsumerFinalNit('C.F.', list)).toBe(true);
      expect(isConsumerFinalNit('1234567-8', list)).toBe(false);
    }
  );
});
