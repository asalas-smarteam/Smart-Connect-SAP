import { jest } from '@jest/globals';
import {
  DEFAULT_SAP_ERROR_BYPASS_CONFIG,
  SAP_ERROR_BYPASS_CONFIG_KEY,
  SAP_ERROR_BYPASS_AREAS,
  normalizeSapErrorBypassConfig,
} from '../../../src/infrastructure/config/sapErrorBypass.config.js';

function leanValue(value) {
  return jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) });
}

describe('normalizeSapErrorBypassConfig', () => {
  // El default decide si un negocio se sincroniza o falla, asi que es la parte de esta
  // config que mas importa: sin llave, sin valor o con basura, NADA se bypassea y el
  // documento se bloquea. Prender el bypass tiene que ser un acto explicito.
  it('no bypassea nada por default', () => {
    expect(DEFAULT_SAP_ERROR_BYPASS_CONFIG).toEqual({ contactEmployee: false });
  });

  it.each([null, undefined, 'true', 42, [], { }])(
    'no bypassea nada cuando el value es %p',
    (value) => {
      expect(normalizeSapErrorBypassConfig(value)).toEqual({ contactEmployee: false });
    }
  );

  it('acepta true y el string "true"', () => {
    expect(normalizeSapErrorBypassConfig({ contactEmployee: true }))
      .toEqual({ contactEmployee: true });
    expect(normalizeSapErrorBypassConfig({ contactEmployee: 'true' }))
      .toEqual({ contactEmployee: true });
  });

  it.each([false, 'false', 'si', 1, null])(
    'no bypassea con %p (solo true o "true" cuentan)',
    (value) => {
      expect(normalizeSapErrorBypassConfig({ contactEmployee: value }))
        .toEqual({ contactEmployee: false });
    }
  );

  // La forma es namespaced a proposito: hoy solo contactEmployee, pero agregar otra area
  // (bpAddress, businessPartnerUpdate, ...) debe ser una llave mas y nada mas. Una llave
  // desconocida se ignora en vez de colarse al objeto normalizado.
  it('ignora areas desconocidas en vez de propagarlas', () => {
    expect(normalizeSapErrorBypassConfig({ contactEmployee: true, contactEmployees: true }))
      .toEqual({ contactEmployee: true });
  });

  it('declara las areas soportadas para que agregar una sea una linea', () => {
    expect(SAP_ERROR_BYPASS_AREAS).toEqual(['contactEmployee']);
  });

  it('usa la llave bypassSapErrors', () => {
    expect(SAP_ERROR_BYPASS_CONFIG_KEY).toBe('bypassSapErrors');
  });
});

describe('TenantWebhookRuntimeRepository.resolveSapErrorBypassConfig', () => {
  async function resolveWith(configurationDoc) {
    const { default: TenantWebhookRuntimeRepository } = await import(
      '../../../src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js'
    );
    const repository = new TenantWebhookRuntimeRepository();
    const findOne = leanValue(configurationDoc);

    const config = await repository.resolveSapErrorBypassConfig({
      Configuration: { findOne, findOneAndUpdate: jest.fn() },
    });

    return { config, findOne };
  }

  it('lee la llave bypassSapErrors del tenant', async () => {
    const { config, findOne } = await resolveWith({ value: { contactEmployee: true } });

    expect(findOne).toHaveBeenCalledWith({ key: SAP_ERROR_BYPASS_CONFIG_KEY });
    expect(config).toEqual({ contactEmployee: true });
  });

  it('cae al default sin bypass cuando el tenant no tiene la llave', async () => {
    const { config } = await resolveWith(null);

    expect(config).toEqual({ contactEmployee: false });
  });

  it('cae al default sin bypass cuando no hay modelo Configuration', async () => {
    const { default: TenantWebhookRuntimeRepository } = await import(
      '../../../src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js'
    );
    const repository = new TenantWebhookRuntimeRepository();

    expect(await repository.resolveSapErrorBypassConfig({})).toEqual({ contactEmployee: false });
    expect(await repository.resolveSapErrorBypassConfig()).toEqual({ contactEmployee: false });
  });
});
