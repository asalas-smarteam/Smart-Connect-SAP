import AddressSyncConfigRepository
  from '../../../src/infrastructure/config/AddressSyncConfigRepository.js';

function buildConfigurationModel(documentsByKey) {
  return {
    findOne({ key }) {
      return { lean: async () => (key in documentsByKey ? { key, value: documentsByKey[key] } : null) };
    },
  };
}

describe('AddressSyncConfigRepository', () => {
  const repository = new AddressSyncConfigRepository();

  it('la clave ausente significa apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({}) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false });
  });

  it('lee required true', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: { required: true } }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: true });
  });

  it('un valor que no es objeto queda apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: 'si' }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false });
  });

  it('nunca lanza', async () => {
    const tenantModels = { Configuration: { findOne() { throw new Error('mongo caido'); } } };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false });
  });
});
