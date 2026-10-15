import { withBpAddressesSelectField }
  from '../../../src/domain/business-partners/bp-addresses-select.service.js';
import { normalizeAddressSyncConfig } from '../../../src/domain/business-partners/address-sync.service.js';
import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

const ENABLED = normalizeAddressSyncConfig({
  required: true,
  addresses: [
    { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
    { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' },
  ],
});

const BASE = [
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
  { sourceField: 'CardName', targetField: 'firstname', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
];

const SYNTHETIC = {
  sourceField: 'BPAddresses',
  targetField: null,
  objectType: 'company',
  sourceContext: 'businessPartner',
  includeInServiceLayerSelect: true,
  isActive: true,
};

function urlFor(mappings, objectType = 'company') {
  return decodeURIComponent(buildServiceLayerUrl(
    { serviceLayerBaseUrl: 'https://sap.example.com', serviceLayerPath: '/BusinessPartners', objectType, integrationModeName: 'SERVICE_LAYER' },
    mappings
  ));
}

function selectedFields(mappings, objectType) {
  return urlFor(mappings, objectType).match(/\$select=([^&]*)/)?.[1].split(',') ?? [];
}

describe('withBpAddressesSelectField', () => {
  it('injects BPAddresses when the address sync is on, for company', () => {
    const result = withBpAddressesSelectField(BASE, ENABLED, { objectType: 'company' });

    expect(result).toHaveLength(BASE.length + 1);
    expect(result[result.length - 1]).toEqual(SYNTHETIC);
  });

  it('injects for contact as well, carrying the objectType', () => {
    const result = withBpAddressesSelectField(BASE, ENABLED, { objectType: 'contact' });

    expect(result[result.length - 1]).toEqual({ ...SYNTHETIC, objectType: 'contact' });
  });

  it('does not touch the list passed in', () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));

    withBpAddressesSelectField(BASE, ENABLED, { objectType: 'company' });

    expect(BASE).toEqual(snapshot);
  });

  describe('is a no-op when the address sync is off', () => {
    it.each([
      ['required is false', normalizeAddressSyncConfig({ required: false, addresses: [{ AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'x' }] })],
      ['there are no addresses', normalizeAddressSyncConfig({ required: true })],
      ['the document is the legacy byName shape', normalizeAddressSyncConfig({ required: true, byName: { entrega: { AddressType: 'bo_ShipTo', fields: { Street: 'x' } } } })],
      ['the config is null', null],
      ['the config is undefined', undefined],
      ['the config is empty', {}],
    ])('returns the very same list when %s', (_label, config) => {
      expect(withBpAddressesSelectField(BASE, config, { objectType: 'company' })).toBe(BASE);
    });
  });

  it('does not inject for product, deal or an unknown object type, even when the sync is on', () => {
    expect(withBpAddressesSelectField(BASE, ENABLED, { objectType: 'product' })).toBe(BASE);
    expect(withBpAddressesSelectField(BASE, ENABLED, { objectType: 'deal' })).toBe(BASE);
    expect(withBpAddressesSelectField(BASE, ENABLED, {})).toBe(BASE);
    expect(withBpAddressesSelectField(BASE, ENABLED)).toBe(BASE);
  });

  it('tolerates an invalid mappings list', () => {
    expect(withBpAddressesSelectField(null, ENABLED, { objectType: 'company' })).toEqual([SYNTHETIC]);
    expect(withBpAddressesSelectField(undefined, ENABLED, { objectType: 'contact' }))
      .toEqual([{ ...SYNTHETIC, objectType: 'contact' }]);
    expect(withBpAddressesSelectField(null, null, { objectType: 'company' })).toEqual([]);
  });

  it('always gives the synthetic the businessPartner context', () => {
    const result = withBpAddressesSelectField(BASE, ENABLED, { objectType: 'company' });

    expect(result[result.length - 1].sourceContext).toBe('businessPartner');
  });

  // The test that matters: the synthetic must survive sanitizeSelectFields, or SAP never returns
  // the collection and every address property stays empty with no error at all.
  it('puts BPAddresses in the final Service Layer URL exactly once', () => {
    const fields = selectedFields(withBpAddressesSelectField(BASE, ENABLED, { objectType: 'company' }), 'company');

    expect(fields).toEqual(expect.arrayContaining(['CardCode', 'CardName', 'BPAddresses']));
    expect(fields.filter((field) => field === 'BPAddresses')).toHaveLength(1);
  });

  it('keeps the URL exactly as it was when the sync is off', () => {
    const off = normalizeAddressSyncConfig({ required: false });

    expect(urlFor(withBpAddressesSelectField(BASE, off, { objectType: 'company' }))).toBe(urlFor(BASE));
    expect(urlFor(BASE)).not.toContain('BPAddresses');
  });
});

// A BPAddresses row that sanitizeSelectFields drops is not "already selected": trusting it would
// skip the injection and the address properties would stay empty with no error.
describe('withBpAddressesSelectField only trusts a BPAddresses row that survives the select', () => {
  const EXISTING = {
    sourceField: 'BPAddresses',
    targetField: null,
    sourceContext: 'businessPartner',
    includeInServiceLayerSelect: true,
    isActive: true,
  };

  it('does not duplicate when an active businessPartner BPAddresses mapping already feeds the select', () => {
    const already = [...BASE, EXISTING];

    expect(withBpAddressesSelectField(already, ENABLED, { objectType: 'company' })).toBe(already);
    expect(selectedFields(already, 'company').filter((field) => field === 'BPAddresses')).toHaveLength(1);
  });

  it('injects when the existing BPAddresses mapping is inactive', () => {
    const inactive = [...BASE, { ...EXISTING, isActive: false }];

    const result = withBpAddressesSelectField(inactive, ENABLED, { objectType: 'company' });

    expect(result).toHaveLength(inactive.length + 1);
    expect(selectedFields(result, 'company')).toContain('BPAddresses');
  });

  it('injects when the existing BPAddresses mapping is excluded from the select', () => {
    const excluded = [...BASE, { ...EXISTING, includeInServiceLayerSelect: false }];

    const result = withBpAddressesSelectField(excluded, ENABLED, { objectType: 'company' });

    expect(result).toHaveLength(excluded.length + 1);
    expect(selectedFields(result, 'company')).toContain('BPAddresses');
  });

  it.each(['bpAddress', 'contactEmployee'])(
    'injects when the existing BPAddresses mapping has the %s context, which the select drops',
    (sourceContext) => {
      const excludedContext = [...BASE, { ...EXISTING, sourceContext }];

      const result = withBpAddressesSelectField(excludedContext, ENABLED, { objectType: 'company' });

      expect(result).toHaveLength(excludedContext.length + 1);
      expect(selectedFields(result, 'company')).toContain('BPAddresses');
    }
  );
});
