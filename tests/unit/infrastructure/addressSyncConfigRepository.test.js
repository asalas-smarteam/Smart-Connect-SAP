import { jest } from '@jest/globals';
import AddressSyncConfigRepository
  from '../../../src/infrastructure/config/AddressSyncConfigRepository.js';

function buildConfigurationModel(documentsByKey) {
  return {
    findOne({ key }) {
      return { lean: async () => (key in documentsByKey ? { key, value: documentsByKey[key] } : null) };
    },
  };
}

const SHIP_TO_STREET = { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' };
const BILL_TO_STREET = { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' };

// What AMC loads: only the street of the ship-to and of the bill-to.
const AMC_VALUE = { required: true, addresses: [SHIP_TO_STREET, BILL_TO_STREET] };

describe('AddressSyncConfigRepository', () => {
  const repository = new AddressSyncConfigRepository();

  // The first four tests are the original contract. The only change is that the result now also
  // carries `addresses`, which is empty whenever nothing valid is configured.
  it('la clave ausente significa apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({}) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false, addresses: [] });
  });

  it('lee required true', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: { required: true } }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: true, addresses: [] });
  });

  it('un valor que no es objeto queda apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: 'si' }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false, addresses: [] });
  });

  it('nunca lanza', async () => {
    const tenantModels = { Configuration: { findOne() { throw new Error('mongo caido'); } } };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false, addresses: [] });
  });

  it('keeps what Printer has today, { required: false }, exactly as before', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: { required: false } }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false, addresses: [] });
  });

  it('reads the AMC shape and returns the normalized rules', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: AMC_VALUE }) };

    const config = await repository.getAddressSyncConfig({ tenantModels });

    expect(config.required).toBe(true);
    expect(config.addresses).toEqual([
      { addressType: 'bo_ShipTo', addressName: null, sourceField: 'Street', targetField: 'direccion_entrega' },
      { addressType: 'bo_BillTo', addressName: null, sourceField: 'Street', targetField: 'direccion_fiscal' },
    ]);
  });

  it('keeps several rules that share one address row', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        requireAddress: {
          required: true,
          addresses: [SHIP_TO_STREET, { AddressType: 'bo_ShipTo', sourceField: 'City', targetField: 'ciudad_entrega' }],
        },
      }),
    };

    const config = await repository.getAddressSyncConfig({ tenantModels });

    expect(config.addresses.map((rule) => rule.targetField)).toEqual(['direccion_entrega', 'ciudad_entrega']);
  });

  it('returns only required and addresses, the issues stay out of the result', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: AMC_VALUE }) };

    expect(Object.keys(await repository.getAddressSyncConfig({ tenantModels })).sort()).toEqual(['addresses', 'required']);
  });

  it('ignores a legacy byName document: it counts as no valid addresses', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        requireAddress: { required: true, byName: { entrega: { AddressType: 'bo_ShipTo', fields: { Street: 'x' } } } },
      }),
    };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: true, addresses: [] });
  });

  it('reads the config from the tenantContext as well', async () => {
    const tenantContext = { tenantModels: { Configuration: buildConfigurationModel({ requireAddress: AMC_VALUE }) } };

    expect((await repository.getAddressSyncConfig({ tenantContext })).required).toBe(true);
  });

  // Review finding R3-s4-required-flip. On a tenant that is not B1 the object is ignored, but what
  // the tenant asked for is not rewritten: `required` stays as configured, so the consumer still
  // sees "asked for it and there is nothing to write" and warns, exactly as it did before this
  // change and exactly as it does for `required: true` with an empty addresses list.
  it('keeps required and clears only addresses on a tenant that is not B1', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tenantModels = {
      Configuration: buildConfigurationModel({ requireAddress: AMC_VALUE, sapFlavor: 'S4' }),
    };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: true, addresses: [] });
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('answers the same on a tenant that is not B1 whether or not addresses is there', async () => {
    const withAddresses = { Configuration: buildConfigurationModel({ requireAddress: AMC_VALUE, sapFlavor: 'S4' }) };
    const withoutAddresses = {
      Configuration: buildConfigurationModel({ requireAddress: { required: true }, sapFlavor: 'S4' }),
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await repository.getAddressSyncConfig({ tenantModels: withAddresses }))
      .toEqual(await repository.getAddressSyncConfig({ tenantModels: withoutAddresses }));

    warn.mockRestore();
  });

  it('keeps required false on a tenant that is not B1 when that is what was configured', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tenantModels = {
      Configuration: buildConfigurationModel({
        requireAddress: { ...AMC_VALUE, required: false },
        sapFlavor: 'S4',
      }),
    };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false, addresses: [] });

    warn.mockRestore();
  });

  it('treats a tenant with no sapFlavor document as B1', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: AMC_VALUE }) };

    expect((await repository.getAddressSyncConfig({ tenantModels })).required).toBe(true);
  });

  it('logs the entries it dropped, once, and still returns the valid ones', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tenantModels = {
      Configuration: buildConfigurationModel({
        requireAddress: {
          required: true,
          addresses: [{ AddressType: 'bo_Other', sourceField: 'Street', targetField: 'x' }, BILL_TO_STREET],
        },
      }),
    };

    const config = await repository.getAddressSyncConfig({ tenantModels });

    expect(config.addresses.map((rule) => rule.targetField)).toEqual(['direccion_fiscal']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('NO_MATCH_CRITERIA');

    warn.mockRestore();
  });

  it('does not log anything for a valid config', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: AMC_VALUE }) };

    await repository.getAddressSyncConfig({ tenantModels });

    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('never throws on a malformed addresses', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: { required: true, addresses: 7 } }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: true, addresses: [] });
  });
});
