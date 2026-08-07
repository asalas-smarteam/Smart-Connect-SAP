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
});
