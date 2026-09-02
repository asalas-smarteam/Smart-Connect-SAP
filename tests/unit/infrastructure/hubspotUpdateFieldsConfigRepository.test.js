import { jest } from '@jest/globals';
import HubspotUpdateFieldsConfigRepository, {
  HUBSPOT_UPDATE_FIELDS_CONFIG_KEY,
} from '../../../src/infrastructure/config/HubspotUpdateFieldsConfigRepository.js';

function models(value) {
  return {
    Configuration: {
      findOne: jest.fn(({ key }) => ({
        lean: async () => (
          key === HUBSPOT_UPDATE_FIELDS_CONFIG_KEY && typeof value !== 'undefined'
            ? { key, value }
            : null
        ),
      })),
    },
  };
}

function read(value, objectType = 'company') {
  return new HubspotUpdateFieldsConfigRepository()
    .getHubspotUpdateFields({ tenantModels: models(value), objectType });
}

describe('HubspotUpdateFieldsConfigRepository', () => {
  it('sin documento devuelve lista vacía (conducta previa a la config)', async () => {
    await expect(read()).resolves.toEqual([]);
  });

  it('lee la lista del objectType pedido', async () => {
    const value = {
      company: ['u_subgrupo', 'mobile_phone', 'cardcurrency', 'phone'],
      contact: ['firstname', 'lastname'],
    };

    await expect(read(value, 'company'))
      .resolves.toEqual(['u_subgrupo', 'mobile_phone', 'cardcurrency', 'phone']);
    await expect(read(value, 'contact')).resolves.toEqual(['firstname', 'lastname']);
  });

  it('un objectType que la config no nombra queda vacío', async () => {
    // Configurar company no puede prender el pisado en contact por accidente.
    await expect(read({ company: ['phone'] }, 'contact')).resolves.toEqual([]);
    await expect(read({ company: ['phone'] }, 'product')).resolves.toEqual([]);
  });

  it('acepta un array suelto para todos los objectType', async () => {
    await expect(read(['phone'], 'company')).resolves.toEqual(['phone']);
    await expect(read(['phone'], 'contact')).resolves.toEqual(['phone']);
  });

  it('limpia espacios, descarta lo que no es texto y no repite', async () => {
    await expect(read({ company: [' phone ', 'phone', 'PHONE', 42, '', null, 'u_subgrupo'] }))
      .resolves.toEqual(['phone', 'u_subgrupo']);
  });

  it('conserva la forma escrita del nombre', async () => {
    // Tiene que coincidir con el targetField del mapeo, que puede llevar
    // mayúsculas; bajarlo a minúsculas rompería la comparación.
    await expect(read({ company: ['U_SubGrupo'] })).resolves.toEqual(['U_SubGrupo']);
  });

  it('un value con forma inesperada no rompe el sync', async () => {
    for (const value of [null, 42, 'phone,mobile']) {
      await expect(read(value)).resolves.toBeInstanceOf(Array);
    }
  });

  it('si la lectura falla, devuelve vacío en vez de tumbar la corrida', async () => {
    const tenantModels = {
      Configuration: { findOne: jest.fn(() => { throw new Error('mongo down'); }) },
    };

    await expect(new HubspotUpdateFieldsConfigRepository()
      .getHubspotUpdateFields({ tenantModels, objectType: 'company' })).resolves.toEqual([]);
  });
});
