import { buildAddressExtension } from '../../../src/domain/orders/address-extension.service.js';
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
});
