import {
  normalizeAddressSyncConfig,
  readSapAddressesToProperties,
} from '../../../src/domain/business-partners/address-sync.service.js';

const rule = (AddressType, sourceField, targetField, extra = {}) => ({ AddressType, sourceField, targetField, ...extra });

// Several rules read fields of the same address row: one rule is one HubSpot property.
const AMC = normalizeAddressSyncConfig({
  required: true,
  addresses: [
    rule('bo_ShipTo', 'Street', 'direccion_entrega'),
    rule('bo_ShipTo', 'City', 'ciudad_entrega'),
    rule('bo_ShipTo', 'State', 'departamento_entrega'),
    rule('bo_BillTo', 'Street', 'direccion_fiscal'),
    rule('bo_BillTo', 'City', 'ciudad_fiscal'),
    rule('bo_BillTo', 'State', 'departamento_fiscal'),
  ],
});

// What AMC actually loads: only the street of each address.
const AMC_STREET_ONLY = normalizeAddressSyncConfig({
  required: true,
  addresses: [rule('bo_ShipTo', 'Street', 'direccion_entrega'), rule('bo_BillTo', 'Street', 'direccion_fiscal')],
});

// Rows with the shape a B1 Service Layer BusinessPartner returns, with synthetic values.
const SHIP_TO = { AddressName: 'ENTREGA', AddressType: 'bo_ShipTo', Street: 'Calle de entrega 2', City: 'ESCUINTLA', State: '6' };
const BILL_TO = { AddressName: 'FISCAL', AddressType: 'bo_BillTo', Street: 'Calle fiscal 1', City: 'GUATEMALA', State: '7' };

const businessPartner = (rows) => ({ CardCode: 'C90001', BPAddresses: rows });

const SIX_PROPERTIES = {
  direccion_entrega: 'Calle de entrega 2',
  ciudad_entrega: 'ESCUINTLA',
  departamento_entrega: '6',
  direccion_fiscal: 'Calle fiscal 1',
  ciudad_fiscal: 'GUATEMALA',
  departamento_fiscal: '7',
};

describe('readSapAddressesToProperties', () => {
  it('writes only the two streets with the AMC shape, whatever the row order', () => {
    const expected = { direccion_entrega: 'Calle de entrega 2', direccion_fiscal: 'Calle fiscal 1' };

    expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO, BILL_TO]), config: AMC_STREET_ONLY }))
      .toEqual(expected);
    expect(readSapAddressesToProperties({ sapRecord: businessPartner([BILL_TO, SHIP_TO]), config: AMC_STREET_ONLY }))
      .toEqual(expected);
  });

  it('writes the six properties from the row of the right type', () => {
    expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO, BILL_TO]), config: AMC }))
      .toEqual(SIX_PROPERTIES);
  });

  it('does not depend on the order of the rows', () => {
    expect(readSapAddressesToProperties({ sapRecord: businessPartner([BILL_TO, SHIP_TO]), config: AMC }))
      .toEqual(SIX_PROPERTIES);
  });

  it('keeps State as the code SAP stores, which is the value of the /States dropdown', () => {
    const properties = readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO, BILL_TO]), config: AMC });

    expect(properties.departamento_entrega).toBe('6');
    expect(properties.departamento_fiscal).toBe('7');
  });

  describe('when the feature is off', () => {
    it.each([
      ['required is false', normalizeAddressSyncConfig({ required: false, addresses: [rule('bo_ShipTo', 'Street', 'x')] })],
      ['there are no addresses', normalizeAddressSyncConfig({ required: true })],
      ['the document is the legacy byName shape', normalizeAddressSyncConfig({ required: true, byName: { entrega: { AddressType: 'bo_ShipTo', fields: { Street: 'x' } } } })],
      ['the config is missing', null],
      ['the config is undefined', undefined],
      ['the config is empty', {}],
      ['addresses is malformed', { required: true, addresses: 'entrega' }],
    ])('returns null, which is not the same as nothing to write, when %s', (_label, config) => {
      expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO, BILL_TO]), config })).toBeNull();
    });
  });

  describe('when there is nothing to read', () => {
    it.each([
      ['an empty list', businessPartner([])],
      ['no BPAddresses', { CardCode: 'C90001' }],
      ['a null BPAddresses', businessPartner(null)],
      ['a BPAddresses that is not a list', businessPartner('x')],
      ['a record that is null', null],
      ['a record that is undefined', undefined],
    ])('returns an empty object for %s', (_label, sapRecord) => {
      expect(readSapAddressesToProperties({ sapRecord, config: AMC })).toEqual({});
    });
  });

  it('writes only the address the BusinessPartner has', () => {
    expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO]), config: AMC })).toEqual({
      direccion_entrega: 'Calle de entrega 2',
      ciudad_entrega: 'ESCUINTLA',
      departamento_entrega: '6',
    });
  });

  // A value SAP leaves empty is left out, never sent blank: it would erase what someone typed by
  // hand in HubSpot, and the existing-record update path already drops empty values for that reason.
  it.each([null, undefined, '', '   '])('leaves a field out when SAP has %p', (empty) => {
    const properties = readSapAddressesToProperties({
      sapRecord: businessPartner([{ ...SHIP_TO, City: empty, State: empty }]),
      config: AMC,
    });

    expect(properties).toEqual({ direccion_entrega: 'Calle de entrega 2' });
  });

  it('takes the first row when several match', () => {
    const properties = readSapAddressesToProperties({
      sapRecord: businessPartner([SHIP_TO, { ...SHIP_TO, Street: 'Otra calle', State: '9' }]),
      config: AMC,
    });

    expect(properties.direccion_entrega).toBe('Calle de entrega 2');
    expect(properties.departamento_entrega).toBe('6');
  });

  it('compares the address type ignoring case', () => {
    const properties = readSapAddressesToProperties({
      sapRecord: businessPartner([{ ...SHIP_TO, AddressType: 'BO_SHIPTO' }]),
      config: AMC,
    });

    expect(properties.direccion_entrega).toBe('Calle de entrega 2');
  });

  describe('matching by name', () => {
    const nameOnly = normalizeAddressSyncConfig({
      required: true,
      addresses: [{ AddressName: 'Fiscal', sourceField: 'Street', targetField: 'direccion_fiscal' }],
    });

    it('matches by AddressName alone, ignoring case and spaces', () => {
      expect(readSapAddressesToProperties({
        sapRecord: businessPartner([SHIP_TO, { ...BILL_TO, AddressName: '  fiscal ' }]),
        config: nameOnly,
      })).toEqual({ direccion_fiscal: 'Calle fiscal 1' });
    });

    it('needs both criteria when both are configured', () => {
      const both = normalizeAddressSyncConfig({
        required: true,
        addresses: [rule('bo_ShipTo', 'Street', 'direccion_entrega', { AddressName: 'entrega' })],
      });

      expect(readSapAddressesToProperties({
        sapRecord: businessPartner([{ ...SHIP_TO, AddressName: 'OTRA' }]),
        config: both,
      })).toEqual({});
      expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO]), config: both }))
        .toEqual({ direccion_entrega: 'Calle de entrega 2' });
    });
  });

  describe('values', () => {
    const extraFields = normalizeAddressSyncConfig({
      required: true,
      addresses: [
        rule('bo_ShipTo', 'ZipCode', 'zip_entrega'),
        rule('bo_ShipTo', 'Block', 'bloque_entrega'),
        rule('bo_ShipTo', 'RowNum', 'fila_entrega'),
        rule('bo_ShipTo', 'Missing', 'no_existe'),
      ],
    });

    it('keeps numbers, drops objects and arrays, and ignores a field the row does not have', () => {
      const properties = readSapAddressesToProperties({
        sapRecord: businessPartner([{ ...SHIP_TO, ZipCode: 1013, Block: { nested: true }, RowNum: ['x'] }]),
        config: extraFields,
      });

      expect(properties).toEqual({ zip_entrega: 1013 });
    });

    it('keeps a string exactly as SAP has it', () => {
      const properties = readSapAddressesToProperties({
        sapRecord: businessPartner([{ ...SHIP_TO, ZipCode: ' 01013 ' }]),
        config: extraFields,
      });

      expect(properties.zip_entrega).toBe(' 01013 ');
    });
  });

  // Review finding R3-match-all-unnormalized-entry. The function is exported and only checks that the
  // feature is on, so a caller can hand it a config that never went through the normalizer. Such an
  // entry has no `addressType` or `addressName` (the raw keys are capitalized), and it used to match
  // the first row of the list: the wrong address would reach HubSpot with no error, which is picking
  // by position, the one thing this function promises not to do.
  describe('with a config that was not normalized', () => {
    const RAW = {
      required: true,
      addresses: [
        { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
        { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' },
      ],
    };

    it('matches nothing for a rule that sets no criteria, instead of taking the first row', () => {
      expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO, BILL_TO]), config: RAW }))
        .toEqual({});
    });

    it('does not throw when a rule has no sourceField or targetField', () => {
      const config = {
        required: true,
        addresses: [
          { addressType: 'bo_ShipTo', addressName: null },
          { addressType: 'bo_ShipTo', addressName: null, sourceField: 'Street' },
          { addressType: 'bo_ShipTo', addressName: null, targetField: 'direccion_entrega' },
        ],
      };

      expect(() => readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO]), config })).not.toThrow();
      expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO]), config })).toEqual({});
    });

    it.each([['a string', 'x'], ['null', null], ['a number', 7], ['a list', []]])(
      'ignores a rule that is %s',
      (_label, entry) => {
        const config = { required: true, addresses: [entry] };

        expect(() => readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO]), config })).not.toThrow();
        expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO]), config })).toEqual({});
      }
    );

    it('still works for the rules that are fine next to a broken one', () => {
      const config = {
        required: true,
        addresses: [
          { sourceField: 'Street', targetField: 'direccion_entrega' },
          { addressType: 'bo_BillTo', addressName: null, sourceField: 'Street', targetField: 'direccion_fiscal' },
        ],
      };

      expect(readSapAddressesToProperties({ sapRecord: businessPartner([SHIP_TO, BILL_TO]), config }))
        .toEqual({ direccion_fiscal: 'Calle fiscal 1' });
    });
  });

  it('ignores rows that are not objects', () => {
    expect(readSapAddressesToProperties({ sapRecord: businessPartner([null, 'x', 7, SHIP_TO]), config: AMC }))
      .toEqual({
        direccion_entrega: 'Calle de entrega 2',
        ciudad_entrega: 'ESCUINTLA',
        departamento_entrega: '6',
      });
  });

  it('does not mutate the record or the config', () => {
    const sapRecord = businessPartner([SHIP_TO, BILL_TO]);
    const recordSnapshot = JSON.parse(JSON.stringify(sapRecord));
    const configSnapshot = JSON.parse(JSON.stringify(AMC));

    readSapAddressesToProperties({ sapRecord, config: AMC });

    expect(sapRecord).toEqual(recordSnapshot);
    expect(AMC).toEqual(configSnapshot);
  });
});
