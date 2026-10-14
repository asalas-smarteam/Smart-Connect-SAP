import {
  isAddressSyncEnabled,
  normalizeAddressSyncConfig,
} from '../../../src/domain/business-partners/address-sync.service.js';

const SHIP_TO_STREET = { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' };
const BILL_TO_STREET = { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' };

// What AMC loads: only the street of the ship-to and of the bill-to.
const AMC_CONFIG = { required: true, addresses: [SHIP_TO_STREET, BILL_TO_STREET] };

const DISABLED = { required: false, addresses: [], issues: [] };

describe('normalizeAddressSyncConfig', () => {
  it('reads the AMC shape into one normalized rule per HubSpot property', () => {
    expect(normalizeAddressSyncConfig(AMC_CONFIG)).toEqual({
      required: true,
      addresses: [
        { addressType: 'bo_ShipTo', addressName: null, sourceField: 'Street', targetField: 'direccion_entrega' },
        { addressType: 'bo_BillTo', addressName: null, sourceField: 'Street', targetField: 'direccion_fiscal' },
      ],
      issues: [],
    });
  });

  it.each([null, undefined, 'si', 5, true, []])('turns %p into the disabled default', (raw) => {
    expect(normalizeAddressSyncConfig(raw)).toEqual(DISABLED);
  });

  it('keeps a value with no addresses as disabled data, not as an error', () => {
    expect(normalizeAddressSyncConfig({ required: false })).toEqual(DISABLED);
    expect(normalizeAddressSyncConfig({ required: true })).toEqual({ required: true, addresses: [], issues: [] });
  });

  it('only accepts the boolean true as required', () => {
    expect(normalizeAddressSyncConfig({ required: 'true', addresses: AMC_CONFIG.addresses }).required).toBe(false);
    expect(normalizeAddressSyncConfig({ required: 1, addresses: AMC_CONFIG.addresses }).required).toBe(false);
  });

  it('keeps the rules when required is false, so the data is visible but the feature stays off', () => {
    const config = normalizeAddressSyncConfig({ required: false, addresses: AMC_CONFIG.addresses });

    expect(config.required).toBe(false);
    expect(config.addresses.map((rule) => rule.targetField)).toEqual(['direccion_entrega', 'direccion_fiscal']);
    expect(isAddressSyncEnabled(config)).toBe(false);
  });

  // The old object shape is gone and nothing is deployed with it: the key is not read at all.
  it('ignores a legacy byName document, which counts as no valid addresses', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      byName: { entrega: { AddressType: 'bo_ShipTo', fields: { Street: 'direccion_entrega' } } },
    });

    expect(config).toEqual({ required: true, addresses: [], issues: [] });
    expect(isAddressSyncEnabled(config)).toBe(false);
  });

  it('accepts the address type in any case and returns it canonical', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ ...SHIP_TO_STREET, AddressType: 'BO_SHIPTO' }],
    });

    expect(config.addresses[0].addressType).toBe('bo_ShipTo');
  });

  it('can match by AddressName alone, lowercased and trimmed', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ AddressName: ' FISCAL ', sourceField: 'Street', targetField: 'direccion_fiscal' }],
    });

    expect(config.addresses).toEqual([
      { addressType: null, addressName: 'fiscal', sourceField: 'Street', targetField: 'direccion_fiscal' },
    ]);
  });

  it('keeps both criteria when a rule sets both', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ ...SHIP_TO_STREET, AddressName: 'Entrega' }],
    });

    expect(config.addresses[0]).toEqual({
      addressType: 'bo_ShipTo',
      addressName: 'entrega',
      sourceField: 'Street',
      targetField: 'direccion_entrega',
    });
  });

  // One rule is one property, so Street and City of the same ship-to are two rules.
  it('keeps several rules that read different fields of the same address', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [
        SHIP_TO_STREET,
        { AddressType: 'bo_ShipTo', sourceField: 'City', targetField: 'ciudad_entrega' },
        { AddressType: 'bo_ShipTo', sourceField: 'State', targetField: 'departamento_entrega' },
      ],
    });

    expect(config.addresses.map((rule) => [rule.addressType, rule.sourceField, rule.targetField])).toEqual([
      ['bo_ShipTo', 'Street', 'direccion_entrega'],
      ['bo_ShipTo', 'City', 'ciudad_entrega'],
      ['bo_ShipTo', 'State', 'departamento_entrega'],
    ]);
    expect(config.issues).toEqual([]);
  });

  it('drops a rule with neither a valid AddressType nor an AddressName, and says why', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ AddressType: 'bo_Other', sourceField: 'Street', targetField: 'direccion_entrega' }, BILL_TO_STREET],
    });

    expect(config.addresses.map((rule) => rule.targetField)).toEqual(['direccion_fiscal']);
    expect(config.issues).toEqual([{ entry: 0, code: 'NO_MATCH_CRITERIA' }]);
  });

  it('drops a rule that sets no criteria at all', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ sourceField: 'Street', targetField: 'direccion_entrega' }],
    });

    expect(config.addresses).toEqual([]);
    expect(config.issues).toEqual([{ entry: 0, code: 'NO_MATCH_CRITERIA' }]);
  });

  it.each(['x', null, 7, []])('drops a rule that is %p, and says why', (rule) => {
    const config = normalizeAddressSyncConfig({ required: true, addresses: [rule, BILL_TO_STREET] });

    expect(config.addresses.map((entry) => entry.targetField)).toEqual(['direccion_fiscal']);
    expect(config.issues).toEqual([{ entry: 0, code: 'INVALID_ENTRY' }]);
  });

  it.each([
    ['a sourceField with a space', { ...SHIP_TO_STREET, sourceField: 'Street Name' }],
    ['a sourceField that starts with a digit', { ...SHIP_TO_STREET, sourceField: '1Street' }],
    ['a missing sourceField', { AddressType: 'bo_ShipTo', targetField: 'direccion_entrega' }],
    ['a sourceField that is not a string', { ...SHIP_TO_STREET, sourceField: 5 }],
    ['a blank targetField', { ...SHIP_TO_STREET, targetField: '  ' }],
    ['a missing targetField', { AddressType: 'bo_ShipTo', sourceField: 'Street' }],
    ['a targetField that is not a string', { ...SHIP_TO_STREET, targetField: 5 }],
  ])('drops a rule with %s, and says why', (_label, rule) => {
    const config = normalizeAddressSyncConfig({ required: true, addresses: [rule, BILL_TO_STREET] });

    expect(config.addresses.map((entry) => entry.targetField)).toEqual(['direccion_fiscal']);
    expect(config.issues).toEqual([{ entry: 0, code: 'INVALID_FIELD' }]);
  });

  it('keeps the HubSpot property exactly as written, trimmed', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ ...SHIP_TO_STREET, targetField: '  Direccion_Entrega ' }],
    });

    expect(config.addresses[0].targetField).toBe('Direccion_Entrega');
  });

  // Two rules writing the same property would overwrite each other without any error,
  // and HubSpot would end up with the bill-to address in the ship-to field.
  it('keeps the first rule for a HubSpot property that two rules write, and reports the clash', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [
        SHIP_TO_STREET,
        { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_entrega' },
        { AddressType: 'bo_BillTo', sourceField: 'City', targetField: 'ciudad_fiscal' },
      ],
    });

    expect(config.addresses).toEqual([
      { addressType: 'bo_ShipTo', addressName: null, sourceField: 'Street', targetField: 'direccion_entrega' },
      { addressType: 'bo_BillTo', addressName: null, sourceField: 'City', targetField: 'ciudad_fiscal' },
    ]);
    expect(config.issues).toEqual([{ entry: 1, code: 'DUPLICATE_PROPERTY', property: 'direccion_entrega' }]);
  });

  it('compares the HubSpot property ignoring case when it looks for a clash', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [SHIP_TO_STREET, { ...BILL_TO_STREET, targetField: 'DIRECCION_ENTREGA' }],
    });

    expect(config.addresses).toHaveLength(1);
    expect(config.issues).toEqual([{ entry: 1, code: 'DUPLICATE_PROPERTY', property: 'DIRECCION_ENTREGA' }]);
  });

  it('does not let a dropped rule claim its property', () => {
    const config = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ sourceField: 'Street', targetField: 'direccion_entrega' }, SHIP_TO_STREET],
    });

    expect(config.addresses.map((rule) => rule.targetField)).toEqual(['direccion_entrega']);
    expect(config.issues).toEqual([{ entry: 0, code: 'NO_MATCH_CRITERIA' }]);
  });

  it('ignores an addresses value that is not an array', () => {
    expect(normalizeAddressSyncConfig({ required: true, addresses: SHIP_TO_STREET }).addresses).toEqual([]);
    expect(normalizeAddressSyncConfig({ required: true, addresses: { entrega: SHIP_TO_STREET } }).addresses).toEqual([]);
    expect(normalizeAddressSyncConfig({ required: true, addresses: 'entrega' }).addresses).toEqual([]);
  });

  it('does not mutate the raw value', () => {
    const raw = JSON.parse(JSON.stringify(AMC_CONFIG));
    const snapshot = JSON.parse(JSON.stringify(raw));

    normalizeAddressSyncConfig(raw);

    expect(raw).toEqual(snapshot);
  });
});

describe('isAddressSyncEnabled', () => {
  it('is true only when required is true and at least one rule survived', () => {
    expect(isAddressSyncEnabled(normalizeAddressSyncConfig(AMC_CONFIG))).toBe(true);
  });

  it('is false when required is true but there is nothing to write', () => {
    expect(isAddressSyncEnabled(normalizeAddressSyncConfig({ required: true }))).toBe(false);
    expect(isAddressSyncEnabled(normalizeAddressSyncConfig({ required: true, addresses: ['x'] }))).toBe(false);
  });

  it('is false for a missing or malformed config', () => {
    expect(isAddressSyncEnabled(null)).toBe(false);
    expect(isAddressSyncEnabled(undefined)).toBe(false);
    expect(isAddressSyncEnabled({})).toBe(false);
    expect(isAddressSyncEnabled({ required: true, addresses: null })).toBe(false);
    expect(isAddressSyncEnabled({ required: true, addresses: {} })).toBe(false);
  });
});
