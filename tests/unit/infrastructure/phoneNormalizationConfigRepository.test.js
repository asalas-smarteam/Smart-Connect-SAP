import { jest } from '@jest/globals';
import PhoneNormalizationConfigRepository, {
  PHONE_NORMALIZATION_CONFIG_KEY,
} from '../../../src/infrastructure/config/PhoneNormalizationConfigRepository.js';

function models(values) {
  return {
    Configuration: {
      findOne: jest.fn(({ key }) => ({
        lean: async () => (
          Object.prototype.hasOwnProperty.call(values, key) ? { key, value: values[key] } : null
        ),
      })),
    },
  };
}

function read(value, { logger } = {}) {
  const repository = new PhoneNormalizationConfigRepository(logger ? { logger } : undefined);

  return repository.getPhoneNormalizationConfig({
    tenantModels: models(
      typeof value === 'undefined' ? {} : { [PHONE_NORMALIZATION_CONFIG_KEY]: value }
    ),
  });
}

const DEFAULT = {
  enabled: false,
  defaultCountryCode: null,
  nationalNumberLengths: [],
  targetFields: ['phone'],
};

describe('PhoneNormalizationConfigRepository', () => {
  it('sin documento devuelve la conducta histórica', async () => {
    await expect(read()).resolves.toEqual(DEFAULT);
  });

  it('lee la config completa de un tenant de Guatemala', async () => {
    await expect(read({
      enabled: true,
      defaultCountryCode: '+502',
      nationalNumberLengths: [8],
      targetFields: ['phone', 'mobilephone'],
    })).resolves.toEqual({
      enabled: true,
      defaultCountryCode: '+502',
      nationalNumberLengths: [8],
      targetFields: ['phone', 'mobilephone'],
    });
  });

  it('acepta el código de país sin "+" y el largo suelto', async () => {
    // Quien escribe la config pone '506' y 8 antes que '+506' y [8]; rechazarlo
    // por la forma no protege de nada.
    await expect(read({
      enabled: true,
      defaultCountryCode: '506',
      nationalNumberLengths: 8,
      targetFields: 'phone',
    })).resolves.toMatchObject({
      enabled: true,
      defaultCountryCode: '+506',
      nationalNumberLengths: [8],
      targetFields: ['phone'],
    });
  });

  it('normaliza los targetFields a minúsculas y sin repetidos', async () => {
    await expect(read({
      targetFields: [' Phone ', 'phone', 'Telefono_Movil', 42, ''],
    })).resolves.toMatchObject({
      targetFields: ['phone', 'telefono_movil'],
    });
  });

  it('un enabled sin país o sin largo NO prefija, y lo avisa', async () => {
    // Prefijar sin saber el largo local no distingue '31923094' de
    // '50231923094' y produce un número válido pero equivocado.
    const logger = { warn: jest.fn(), error: jest.fn() };

    await expect(read({ enabled: true, targetFields: ['phone'] }, { logger }))
      .resolves.toMatchObject({ enabled: false, defaultCountryCode: null });
    await expect(read({ enabled: true, defaultCountryCode: '+502' }, { logger }))
      .resolves.toMatchObject({ enabled: false });
    await expect(read({ enabled: true, nationalNumberLengths: [8] }, { logger }))
      .resolves.toMatchObject({ enabled: false });

    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('no se enciende con un enabled que no sea exactamente true', async () => {
    for (const enabled of ['true', 1, null]) {
      await expect(read({
        enabled,
        defaultCountryCode: '+502',
        nationalNumberLengths: [8],
      })).resolves.toMatchObject({ enabled: false });
    }
  });

  it('descarta códigos de país y largos imposibles', async () => {
    const logger = { warn: jest.fn(), error: jest.fn() };

    await expect(read({
      enabled: true,
      defaultCountryCode: '+0502',
      nationalNumberLengths: [8],
    }, { logger })).resolves.toMatchObject({ enabled: false });

    // 13 + 3 dígitos del país pasan de los 15 de E.164: prefijarlo daría un
    // número que HubSpot rechaza igual.
    await expect(read({
      enabled: true,
      defaultCountryCode: '+502',
      nationalNumberLengths: [13, 0, 'ocho', 8],
    })).resolves.toMatchObject({ enabled: true, nationalNumberLengths: [8] });
  });

  it('un value que no es objeto cae al default sin lanzar', async () => {
    for (const value of ['+502', 42, [], null]) {
      await expect(read(value)).resolves.toEqual(DEFAULT);
    }
  });

  it('una lista de teléfonos vacía cae al default en vez de apagar la limpieza', async () => {
    // Con [] no se normalizaría ni `phone`, y volvería el 400 que esto evita.
    await expect(read({ targetFields: [] })).resolves.toMatchObject({ targetFields: ['phone'] });
  });

  it('si la lectura falla, el sync sigue con la conducta histórica', async () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const repository = new PhoneNormalizationConfigRepository({ logger });
    const tenantModels = {
      Configuration: { findOne: jest.fn(() => { throw new Error('mongo down'); }) },
    };

    await expect(repository.getPhoneNormalizationConfig({ tenantModels })).resolves.toEqual(DEFAULT);
    expect(logger.error).toHaveBeenCalled();
  });

  it('acepta un tenantContext en vez de tenantModels', async () => {
    // MappingSyncRepository pasa tenantContext; FieldMappingService pasa tenantModels.
    const repository = new PhoneNormalizationConfigRepository();

    await expect(repository.getPhoneNormalizationConfig({
      tenantContext: {
        tenantModels: models({
          [PHONE_NORMALIZATION_CONFIG_KEY]: {
            enabled: true,
            defaultCountryCode: '+502',
            nationalNumberLengths: [8],
          },
        }),
      },
    })).resolves.toMatchObject({ enabled: true, defaultCountryCode: '+502' });
  });
});
