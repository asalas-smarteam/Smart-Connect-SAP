import {
  buildMappedProperties,
  hasMappedValue,
  resolveValueByPath,
} from '../../../src/application/services/mappingValueResolver.service.js';

// The real shape after the OData normalizer flattens {results:[...]}.
function businessPartner(taxRows, customer = {}) {
  return {
    BusinessPartner: '100051',
    to_Customer: customer,
    to_BusinessPartnerTax: taxRows,
  };
}

const CEDULA_CHAIN = [
  { _id: 1, sourceField: 'to_Customer.TaxNumber1', targetField: 'cedula', isActive: true },
  { _id: 2, sourceField: 'to_BusinessPartnerTax.BPTaxLongNumber', targetField: 'cedula', isActive: true },
];

describe('hasMappedValue', () => {
  it('treats null, undefined and blank strings as absent', () => {
    expect(hasMappedValue(null)).toBe(false);
    expect(hasMappedValue(undefined)).toBe(false);
    expect(hasMappedValue('')).toBe(false);
    expect(hasMappedValue('   ')).toBe(false);
  });

  it('treats zero and false as real values', () => {
    // A tax number of "0" or a boolean flag is data, not a gap.
    expect(hasMappedValue(0)).toBe(true);
    expect(hasMappedValue(false)).toBe(true);
    expect(hasMappedValue('EXPORT')).toBe(true);
  });
});

describe('resolveValueByPath', () => {
  it('keeps the legacy first-element behaviour when scanning is off', () => {
    const record = businessPartner([
      { BPTaxType: 'CR4', BPTaxNumber: '', BPTaxLongNumber: '' },
      { BPTaxType: 'DO5', BPTaxNumber: '', BPTaxLongNumber: '0043402266' },
    ]);

    expect(resolveValueByPath(record, 'to_BusinessPartnerTax.BPTaxLongNumber')).toBe('');
  });

  it('scans past empty collection rows when scanning is on', () => {
    const record = businessPartner([
      { BPTaxType: 'CR4', BPTaxNumber: '', BPTaxLongNumber: '' },
      { BPTaxType: 'DO5', BPTaxNumber: '', BPTaxLongNumber: '0043402266' },
    ]);

    expect(resolveValueByPath(record, 'to_BusinessPartnerTax.BPTaxLongNumber', { scanCollections: true }))
      .toBe('0043402266');
  });

  it('honours the configured collection priority over arrival order', () => {
    // Gateway does not guarantee row order, so two rows that both carry a value
    // must be decided by configuration, not by luck.
    const record = businessPartner([
      { BPTaxType: 'DO5', BPTaxNumber: '', BPTaxLongNumber: 'EXPORT' },
      { BPTaxType: 'GT1', BPTaxNumber: '', BPTaxLongNumber: 'GT-999' },
    ]);

    const value = resolveValueByPath(record, 'to_BusinessPartnerTax.BPTaxLongNumber', {
      scanCollections: true,
      collectionPriority: { to_BusinessPartnerTax: { field: 'BPTaxType', order: ['GT1', 'DO5'] } },
    });

    expect(value).toBe('GT-999');
  });

  it('puts types missing from the priority list last, keeping their relative order', () => {
    const record = businessPartner([
      { BPTaxType: 'ZZ1', BPTaxLongNumber: 'unknown-first' },
      { BPTaxType: 'ZZ2', BPTaxLongNumber: 'unknown-second' },
      { BPTaxType: 'DO5', BPTaxLongNumber: 'listed' },
    ]);

    const value = resolveValueByPath(record, 'to_BusinessPartnerTax.BPTaxLongNumber', {
      scanCollections: true,
      collectionPriority: { to_BusinessPartnerTax: { field: 'BPTaxType', order: ['DO5'] } },
    });

    expect(value).toBe('listed');
  });

  it('falls back to the first row when no row carries a value', () => {
    const record = businessPartner([{ BPTaxType: 'DO1', BPTaxLongNumber: '' }]);

    expect(resolveValueByPath(record, 'to_BusinessPartnerTax.BPTaxLongNumber', { scanCollections: true }))
      .toBe('');
  });

  it('returns null for a path that does not exist', () => {
    // to_Customer.BPTaxLongNumber is exactly this case: A_Customer has no such
    // field, and Gateway 404s if it is named in a $select.
    expect(resolveValueByPath(businessPartner([], { TaxNumber1: '102013209' }), 'to_Customer.BPTaxLongNumber'))
      .toBeNull();
  });

  it('returns null for an empty or missing source field', () => {
    expect(resolveValueByPath({}, '')).toBeNull();
    expect(resolveValueByPath({}, null)).toBeNull();
    expect(resolveValueByPath({}, '  .  ')).toBeNull();
  });
});

describe('buildMappedProperties', () => {
  it('lets the last mapping win when the chain is disabled', () => {
    // Today's behaviour, reproduced: a second cedula row nulls out a good value.
    const record = businessPartner(
      [{ BPTaxType: 'DO1', BPTaxNumber: '102013209', BPTaxLongNumber: '' }],
      { TaxNumber1: '102013209' }
    );

    const properties = buildMappedProperties({
      input: record,
      mappings: [
        { sourceField: 'to_Customer.TaxNumber1', targetField: 'cedula', isActive: true },
        { sourceField: 'to_Customer.BPTaxLongNumber', targetField: 'cedula', isActive: true },
      ],
    });

    expect(properties.cedula).toBeNull();
  });

  it('takes the first mapping that yields a value when the chain is enabled', () => {
    const record = businessPartner(
      [{ BPTaxType: 'DO1', BPTaxNumber: '102013209', BPTaxLongNumber: '' }],
      { TaxNumber1: '102013209' }
    );

    const properties = buildMappedProperties({
      input: record,
      mappings: CEDULA_CHAIN,
      fallbackConfig: { enabled: true },
    });

    expect(properties.cedula).toBe('102013209');
  });

  it('falls through to the next mapping when the first resolves blank', () => {
    // The foreign-customer case: TaxNumber1 is "" and the value lives in the
    // long number of the tax collection.
    const record = businessPartner(
      [{ BPTaxType: 'DO5', BPTaxNumber: '', BPTaxLongNumber: '0043402266' }],
      { TaxNumber1: '' }
    );

    const properties = buildMappedProperties({
      input: record,
      mappings: CEDULA_CHAIN,
      fallbackConfig: { enabled: true },
    });

    expect(properties.cedula).toBe('0043402266');
  });

  it('never lets a later mapping blank out a value already found', () => {
    const record = businessPartner([], { TaxNumber1: '102013209' });

    const properties = buildMappedProperties({
      input: record,
      mappings: CEDULA_CHAIN,
      fallbackConfig: { enabled: true },
    });

    expect(properties.cedula).toBe('102013209');
  });

  it('skips inactive mappings in the chain', () => {
    const record = businessPartner(
      [{ BPTaxType: 'DO5', BPTaxLongNumber: '0043402266' }],
      { TaxNumber1: '' }
    );

    const properties = buildMappedProperties({
      input: record,
      mappings: [
        CEDULA_CHAIN[0],
        { ...CEDULA_CHAIN[1], isActive: false },
      ],
      fallbackConfig: { enabled: true },
    });

    // "" rather than null: TaxNumber1 exists and is blank in SAP. The disabled
    // row is never consulted, so the long number is not picked up.
    expect(properties.cedula).toBe('');
  });

  it('leaves single-mapping fields untouched either way', () => {
    const record = { BusinessPartner: '100051', BusinessPartnerName: 'ACME' };
    const mappings = [{ sourceField: 'BusinessPartnerName', targetField: 'name', isActive: true }];

    expect(buildMappedProperties({ input: record, mappings }).name).toBe('ACME');
    expect(buildMappedProperties({ input: record, mappings, fallbackConfig: { enabled: true } }).name).toBe('ACME');
  });
});
