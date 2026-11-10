import {
  ADDRESS_STREET_MAX_LENGTH,
  buildAddressExtension,
  normalizeStreetMaxLength,
} from '../../../src/domain/orders/address-extension.service.js';
import { PermanentWebhookError } from '../../../src/shared/errors/index.js';

describe('buildAddressExtension', () => {
  it('maps the billing and shipping fields through the FieldMapping rows', () => {
    const result = buildAddressExtension({
      source: {
        billing_street: 'Calle 1',
        shipping_street: 'Calle 2',
        zip: '01010',
        country: 'GT',
      },
      mappings: [
        { sourceField: 'BillToStreet', targetField: 'billing_street' },
        { sourceField: 'ShipToStreet', targetField: 'shipping_street' },
        { sourceField: 'BillToZipCode', targetField: 'zip' },
        { sourceField: 'ShipToZipCode', targetField: 'zip' },
        { sourceField: 'BillToCountry', targetField: 'country' },
        { sourceField: 'ShipToCountry', targetField: 'country' },
      ],
    });

    expect(result).toEqual({
      BillToStreet: 'Calle 1',
      ShipToStreet: 'Calle 2',
      BillToZipCode: '01010',
      ShipToZipCode: '01010',
      BillToCountry: 'GT',
      ShipToCountry: 'GT',
    });
  });

  it('omits blank values instead of sending null to SAP', () => {
    const result = buildAddressExtension({
      source: { billing_street: 'Calle 1', zip: null, shipping_street: '' },
      mappings: [
        { sourceField: 'BillToStreet', targetField: 'billing_street' },
        { sourceField: 'BillToZipCode', targetField: 'zip' },
        { sourceField: 'ShipToStreet', targetField: 'shipping_street' },
      ],
    });

    expect(result).toEqual({ BillToStreet: 'Calle 1' });
  });

  it.each([[null], [undefined]])('returns null when the payload carries no address extension (%s)', (source) => {
    expect(buildAddressExtension({
      source,
      mappings: [{ sourceField: 'BillToStreet', targetField: 'billing_street' }],
    })).toBeNull();
  });

  // A malformed object is a workflow bug that repeats on every event, so it must fail loudly
  // instead of creating the quotation without an address and without anyone noticing.
  it.each([
    ['an array', []],
    ['a non-empty array', [{ billing_street: 'Calle 1' }]],
    ['a string', 'Calle 1'],
    ['an empty string', ''],
    ['a number', 0],
  ])('throws a PermanentWebhookError when addressExtension is %s', (_label, source) => {
    const call = () => buildAddressExtension({
      source,
      mappings: [{ sourceField: 'BillToStreet', targetField: 'billing_street' }],
    });

    expect(call).toThrow(PermanentWebhookError);
    expect(call).toThrow(/addressExtension/);
  });

  it('returns null when there are no mappings configured for the tenant', () => {
    expect(buildAddressExtension({ source: { billing_street: 'Calle 1' }, mappings: [] })).toBeNull();
  });

  it('returns null when every mapped value is blank', () => {
    expect(buildAddressExtension({
      source: { billing_street: '' },
      mappings: [{ sourceField: 'BillToStreet', targetField: 'billing_street' }],
    })).toBeNull();
  });

  // SAP silently drops the whole street when it is longer than its limit (it answers with
  // ShipToStreet null and no error), so the document would be created without a delivery address.
  // The integration only transports data: it never cuts the street, it rejects the event.
  describe('street length limit', () => {
    const streetMappings = [
      { sourceField: 'BillToStreet', targetField: 'billing_street' },
      { sourceField: 'ShipToStreet', targetField: 'shipping_street' },
    ];

    it('sends a street of exactly 100 characters as it is', () => {
      const street = 'a'.repeat(100);

      const result = buildAddressExtension({
        source: { billing_street: street, shipping_street: street },
        mappings: streetMappings,
      });

      expect(result).toEqual({ BillToStreet: street, ShipToStreet: street });
    });

    it('rejects a street longer than 100 characters instead of cutting it', () => {
      const call = () => buildAddressExtension({
        source: { billing_street: 'Calle 1', shipping_street: 'x'.repeat(116) },
        mappings: streetMappings,
      });

      expect(call).toThrow(PermanentWebhookError);
      expect(call).toThrow(/ShipToStreet has 116 characters/);
      expect(call).toThrow(/at most 100/);
    });

    it('names every street that is too long in one error', () => {
      expect(() => buildAddressExtension({
        source: { billing_street: 'b'.repeat(101), shipping_street: 's'.repeat(116) },
        mappings: streetMappings,
      })).toThrow(/BillToStreet has 101 characters and ShipToStreet has 116 characters/);
    });

    it('never puts the address text in the error', () => {
      let message = '';

      try {
        buildAddressExtension({
          source: { shipping_street: 'x'.repeat(116) },
          mappings: streetMappings,
        });
      } catch (error) {
        message = error.message;
      }

      expect(message).not.toContain('xxxxx');
    });

    it('does not check fields other than the streets', () => {
      const city = 'c'.repeat(150);

      const result = buildAddressExtension({
        source: { city },
        mappings: [{ sourceField: 'ShipToCity', targetField: 'city' }],
      });

      expect(result).toEqual({ ShipToCity: city });
    });

    it('accepts a longer street when the tenant raises the limit', () => {
      const street = 'a'.repeat(150);

      const result = buildAddressExtension({
        source: { shipping_street: street },
        mappings: streetMappings,
        streetMaxLength: 200,
      });

      expect(result).toEqual({ ShipToStreet: street });
    });

    it('rejects a street that exceeds a limit the tenant lowered', () => {
      expect(() => buildAddressExtension({
        source: { shipping_street: 'a'.repeat(61) },
        mappings: streetMappings,
        streetMaxLength: 60,
      })).toThrow(/ShipToStreet has 61 characters.*at most 60/);
    });
  });

  describe('normalizeStreetMaxLength', () => {
    it.each([
      [200, 200],
      ['150', 150],
      [' 80 ', 80],
    ])('keeps the usable limit %p as %p', (value, expected) => {
      expect(normalizeStreetMaxLength(value)).toBe(expected);
    });

    it.each([[null], [undefined], [0], [-5], [12.5], ['abc'], ['']])(
      'falls back to the default for the unusable value %p',
      (value) => {
        expect(normalizeStreetMaxLength(value)).toBe(ADDRESS_STREET_MAX_LENGTH);
      }
    );
  });
});
