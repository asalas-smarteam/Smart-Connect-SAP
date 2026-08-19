import { jest } from '@jest/globals';
import { INTEGRATION_STATUS_KEYS } from '../../../src/domain/webhooks/integration-status.constants.js';
import { buildPublishIntegrationStatus } from '../../../src/infrastructure/hubspot/dealIntegrationStatus.service.js';

const CONFIGURED = {
  requireMessageHS: false,
  requiereReturnStage: false,
  stageToReturned: null,
  integrationStatusProperty: 'sap_integration_status',
  integrationStatusValues: {
    completed: 'completed',
    errorRetry: 'error_retry',
    errorSupport: 'error_support',
  },
};

function buildDeps(overrides = {}) {
  return {
    hubspotClient: {
      updateDeal: jest.fn().mockResolvedValue({}),
    },
    hubspotWebhookAdapter: {
      resolveAccessTokenForPortal: jest.fn().mockResolvedValue({ token: 'token-1' }),
    },
    getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue(CONFIGURED),
    resolveEventPayload: jest.fn((event) => ({ deal: event?.payload?.deal || null })),
    logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('publishIntegrationStatus', () => {
  const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };

  it.each([
    [INTEGRATION_STATUS_KEYS.COMPLETED, 'completed'],
    [INTEGRATION_STATUS_KEYS.ERROR_RETRY, 'error_retry'],
    [INTEGRATION_STATUS_KEYS.ERROR_SUPPORT, 'error_support'],
  ])('escribe el valor configurado para %s', async (status, expected) => {
    const deps = buildDeps();
    const publish = buildPublishIntegrationStatus(deps);

    await publish({ event, status, tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.updateDeal).toHaveBeenCalledWith('token-1', 'deal-1', {
      properties: { sap_integration_status: expected },
    });
  });

  it('no hace nada cuando la función no está configurada', async () => {
    const deps = buildDeps({
      getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue({
        ...CONFIGURED,
        integrationStatusProperty: null,
        integrationStatusValues: null,
      }),
    });
    const publish = buildPublishIntegrationStatus(deps);

    await publish({
      event,
      status: INTEGRATION_STATUS_KEYS.ERROR_RETRY,
      tenantModels: {},
      portalId: 'p1',
    });

    expect(deps.hubspotWebhookAdapter.resolveAccessTokenForPortal).not.toHaveBeenCalled();
    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('no hace nada ante un status desconocido', async () => {
    const deps = buildDeps();
    const publish = buildPublishIntegrationStatus(deps);

    await publish({ event, status: 'inventado', tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('avisa y se detiene cuando el payload no trae dealId', async () => {
    const deps = buildDeps();
    const publish = buildPublishIntegrationStatus(deps);

    await publish({
      event: { _id: 'event-2', payload: {} },
      status: INTEGRATION_STATUS_KEYS.COMPLETED,
      tenantModels: {},
      portalId: 'p1',
    });

    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('avisa y se detiene cuando el tenant no tiene credenciales de HubSpot', async () => {
    const deps = buildDeps({
      hubspotWebhookAdapter: {
        resolveAccessTokenForPortal: jest.fn().mockResolvedValue({ token: null }),
      },
    });
    const publish = buildPublishIntegrationStatus(deps);

    await publish({
      event,
      status: INTEGRATION_STATUS_KEYS.COMPLETED,
      tenantModels: {},
      portalId: 'p1',
    });

    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  // La regla dura: esto corre DESPUÉS del bookkeeping. Si dejara escapar el error, un hipo de
  // HubSpot desandaría un markFailed/markCompleted que ya se guardó.
  it('nunca lanza cuando HubSpot falla', async () => {
    const deps = buildDeps({
      hubspotClient: { updateDeal: jest.fn().mockRejectedValue(new Error('HubSpot 500')) },
    });
    const publish = buildPublishIntegrationStatus(deps);

    await expect(
      publish({
        event,
        status: INTEGRATION_STATUS_KEYS.COMPLETED,
        tenantModels: {},
        portalId: 'p1',
      })
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('nunca lanza cuando la lectura de configuración falla', async () => {
    const deps = buildDeps({
      getWebhookFailureNotificationConfig: jest.fn().mockRejectedValue(new Error('Mongo down')),
    });
    const publish = buildPublishIntegrationStatus(deps);

    await expect(
      publish({
        event,
        status: INTEGRATION_STATUS_KEYS.COMPLETED,
        tenantModels: {},
        portalId: 'p1',
      })
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
