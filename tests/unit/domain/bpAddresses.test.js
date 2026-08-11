import { buildBpAddresses } from '../../../src/domain/business-partners/bp-addresses.service.js';

const CONFIG = {
  strategy: 'payloadArray',
  byName: {
    factura: { AddressType: 'bo_BillTo', Country: 'GT' },
    entrega: { AddressType: 'bo_ShipTo', Country: 'GT' },
  },
  required: [],
};

const DEFAULTS = { TaxCode: 'IVA' };

describe('buildBpAddresses', () => {
  it('arma dos direcciones uniendo payload, byName y defaults', () => {
    const { addresses, warnings } = buildBpAddresses({
      mappedAddresses: [
        { AddressName: 'factura', Street: 'Calle 1', County: 'La Habana' },
        { AddressName: 'Entrega', Street: 'Calle 2', County: 'La Habana' },
      ],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(warnings).toEqual([]);
    expect(addresses).toEqual([
      { TaxCode: 'IVA', AddressType: 'bo_BillTo', Country: 'GT', AddressName: 'factura', Street: 'Calle 1', County: 'La Habana' },
      { TaxCode: 'IVA', AddressType: 'bo_ShipTo', Country: 'GT', AddressName: 'Entrega', Street: 'Calle 2', County: 'La Habana' },
    ]);
  });

  it('soporta una sola direccion', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'Unica' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toHaveLength(1);
    expect(addresses[0].AddressType).toBe('bo_BillTo');
  });

  it('soporta mas de dos direcciones', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [
        { AddressName: 'factura', Street: 'A' },
        { AddressName: 'entrega', Street: 'B' },
        { AddressName: 'entrega', Street: 'C' },
      ],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toHaveLength(3);
    expect(addresses.map((address) => address.Street)).toEqual(['A', 'B', 'C']);
  });

  it('une byName sin importar mayusculas ni espacios en el AddressName', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: '  FACTURA  ', Street: 'A' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses[0].AddressType).toBe('bo_BillTo');
    expect(addresses[0].AddressName).toBe('FACTURA');
  });

  it('el valor del payload gana sobre byName y sobre los defaults', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', AddressType: 'bo_ShipTo', TaxCode: 'EXE', Country: 'CU' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses[0]).toMatchObject({ AddressType: 'bo_ShipTo', TaxCode: 'EXE', Country: 'CU' });
  });

  it('avisa cuando el AddressName no esta en byName pero crea la direccion', () => {
    const { addresses, warnings } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'bodega', Street: 'X' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toEqual([{ TaxCode: 'IVA', AddressName: 'bodega', Street: 'X' }]);
    expect(warnings).toEqual([{ code: 'BP_ADDRESS_NAME_NOT_CONFIGURED', addressName: 'bodega' }]);
  });

  it('descarta entradas sin AddressName y avisa', () => {
    const { addresses, warnings } = buildBpAddresses({
      mappedAddresses: [{ Street: 'Sin nombre' }, { AddressName: 'factura', Street: 'A' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toHaveLength(1);
    expect(warnings).toEqual([{ code: 'BP_ADDRESS_WITHOUT_NAME' }]);
  });

  it('omite los campos vacios en vez de mandar null a SAP', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'A', ZipCode: null, County: '' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses[0]).not.toHaveProperty('ZipCode');
    expect(addresses[0]).not.toHaveProperty('County');
  });

  it('lanza PermanentWebhookError cuando falta una direccion obligatoria', () => {
    expect(() => buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'A' }],
      addressesConfig: { ...CONFIG, required: ['factura', 'entrega'] },
      addressDefaults: DEFAULTS,
    })).toThrow(/entrega/);
  });

  it('no lanza cuando todas las obligatorias estan presentes', () => {
    expect(() => buildBpAddresses({
      mappedAddresses: [{ AddressName: 'Factura', Street: 'A' }, { AddressName: 'ENTREGA', Street: 'B' }],
      addressesConfig: { ...CONFIG, required: ['factura', 'entrega'] },
      addressDefaults: DEFAULTS,
    })).not.toThrow();
  });

  it('devuelve vacio cuando la strategy esta apagada', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'A' }],
      addressesConfig: { strategy: 'none', byName: {}, required: [] },
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toEqual([]);
  });

  it('devuelve vacio cuando el payload no trae direcciones', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: undefined,
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toEqual([]);
  });
});
