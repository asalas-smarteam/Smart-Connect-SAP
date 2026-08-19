import { jest } from '@jest/globals';
import {
  DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG,
  WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY,
  getWebhookFailureNotificationConfig,
} from '../../../src/infrastructure/config/webhookFailureNotification.config.js';

describe('getWebhookFailureNotificationConfig', () => {
  it('returns the default config when the tenant has no Configuration model', async () => {
    const config = await getWebhookFailureNotificationConfig({ tenantModels: {} });

    expect(config).toEqual(DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG);
    expect(config.integrationStatusProperty).toBeNull();
    expect(config.integrationStatusValues).toBeNull();
  });

  it('returns the default config when no document exists for the key', async () => {
    const findOne = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const config = await getWebhookFailureNotificationConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(findOne).toHaveBeenCalledWith({ key: WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY });
    expect(config).toEqual(DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG);
  });

  it('normalizes booleans and trims stageToReturned', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: { requireMessageHS: 'true', requiereReturnStage: true, stageToReturned: '  12345  ' },
      }),
    });

    const config = await getWebhookFailureNotificationConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual({
      requireMessageHS: true,
      requiereReturnStage: true,
      stageToReturned: '12345',
      integrationStatusProperty: null,
      integrationStatusValues: null,
    });
  });

  it('normalizes an empty stageToReturned to null', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: { requireMessageHS: true, requiereReturnStage: false, stageToReturned: '' },
      }),
    });

    const config = await getWebhookFailureNotificationConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual({
      requireMessageHS: true,
      requiereReturnStage: false,
      stageToReturned: null,
      integrationStatusProperty: null,
      integrationStatusValues: null,
    });
  });

  it('falls back to defaults when value is not an object', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ value: 'not-an-object' }),
    });

    const config = await getWebhookFailureNotificationConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual(DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG);
  });

  describe('propiedad de estado de integración', () => {
    function readConfig(value) {
      const findOne = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ value }) });
      return getWebhookFailureNotificationConfig({ tenantModels: { Configuration: { findOne } } });
    }

    const validValues = {
      completed: 'completed',
      errorRetry: 'error_retry',
      errorSupport: 'error_support',
    };

    it('lee el nombre de la propiedad y los tres valores', async () => {
      const config = await readConfig({
        requireMessageHS: true,
        integrationStatusProperty: '  sap_integration_status  ',
        integrationStatusValues: validValues,
      });

      expect(config.integrationStatusProperty).toBe('sap_integration_status');
      expect(config.integrationStatusValues).toEqual(validValues);
    });

    it('queda apagada cuando no hay nombre de propiedad', async () => {
      const config = await readConfig({
        requireMessageHS: true,
        integrationStatusValues: validValues,
      });

      expect(config.integrationStatusProperty).toBeNull();
      expect(config.integrationStatusValues).toBeNull();
    });

    // Falla apagado, igual que bypassSapErrors: escribir la propiedad con solo dos de los tres
    // valores configurados dejaría al asesor mirando un estado que no significa lo que dice.
    it.each(['completed', 'errorRetry', 'errorSupport'])(
      'queda apagada por completo cuando falta el valor %s',
      async (missing) => {
        const incomplete = { ...validValues };
        delete incomplete[missing];

        const config = await readConfig({
          requireMessageHS: true,
          integrationStatusProperty: 'sap_integration_status',
          integrationStatusValues: incomplete,
        });

        expect(config.integrationStatusProperty).toBeNull();
        expect(config.integrationStatusValues).toBeNull();
      }
    );

    it('queda apagada cuando integrationStatusValues no es un objeto', async () => {
      const config = await readConfig({
        integrationStatusProperty: 'sap_integration_status',
        integrationStatusValues: 'nope',
      });

      expect(config.integrationStatusProperty).toBeNull();
      expect(config.integrationStatusValues).toBeNull();
    });

    it('no afecta a los campos de la nota ni de la etapa', async () => {
      const config = await readConfig({
        requireMessageHS: true,
        requiereReturnStage: true,
        stageToReturned: 'stage-7',
      });

      expect(config).toMatchObject({
        requireMessageHS: true,
        requiereReturnStage: true,
        stageToReturned: 'stage-7',
        integrationStatusProperty: null,
        integrationStatusValues: null,
      });
    });
  });
});
