import { jest } from '@jest/globals';
import { buildNotifyWebhookFailure } from '../../../src/infrastructure/hubspot/webhookFailureNotifier.service.js';

function buildDeps(overrides = {}) {
  return {
    hubspotClient: {
      createNote: jest.fn().mockResolvedValue({ id: 'note-1' }),
      associateObjectsDefault: jest.fn().mockResolvedValue({}),
      updateDeal: jest.fn().mockResolvedValue({}),
    },
    hubspotWebhookAdapter: {
      resolveAccessTokenForPortal: jest.fn().mockResolvedValue({ token: 'token-1' }),
    },
    getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue({
      requireMessageHS: true,
      requiereReturnStage: false,
      stageToReturned: null,
    }),
    resolveEventPayload: jest.fn((event) => ({ deal: event?.payload?.deal || null })),
    logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('notifyWebhookFailure', () => {
  const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };

  it('does nothing when requireMessageHS is false', async () => {
    const deps = buildDeps({
      getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue({
        requireMessageHS: false,
        requiereReturnStage: false,
        stageToReturned: null,
      }),
    });
    const notifyWebhookFailure = buildNotifyWebhookFailure(deps);

    await notifyWebhookFailure({ event, lastError: 'boom', tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.createNote).not.toHaveBeenCalled();
    expect(deps.hubspotWebhookAdapter.resolveAccessTokenForPortal).not.toHaveBeenCalled();
  });

  it('creates and associates a note with the deal when enabled', async () => {
    const deps = buildDeps();
    const notifyWebhookFailure = buildNotifyWebhookFailure(deps);

    await notifyWebhookFailure({ event, lastError: 'ItemCode is required', tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.createNote).toHaveBeenCalledWith('token-1', { body: 'ItemCode is required' });
    expect(deps.hubspotClient.associateObjectsDefault).toHaveBeenCalledWith('token-1', 'note', 'note-1', 'deal', 'deal-1');
    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('also reverts the dealstage when requiereReturnStage and stageToReturned are set', async () => {
    const deps = buildDeps({
      getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue({
        requireMessageHS: true,
        requiereReturnStage: true,
        stageToReturned: 'stage-99',
      }),
    });
    const notifyWebhookFailure = buildNotifyWebhookFailure(deps);

    await notifyWebhookFailure({ event, lastError: 'boom', tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.updateDeal).toHaveBeenCalledWith('token-1', 'deal-1', {
      properties: { dealstage: 'stage-99' },
    });
  });

  it('does not revert the dealstage when requiereReturnStage is true but stageToReturned is missing', async () => {
    const deps = buildDeps({
      getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue({
        requireMessageHS: true,
        requiereReturnStage: true,
        stageToReturned: null,
      }),
    });
    const notifyWebhookFailure = buildNotifyWebhookFailure(deps);

    await notifyWebhookFailure({ event, lastError: 'boom', tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('skips without throwing when the event has no dealId', async () => {
    const deps = buildDeps({
      resolveEventPayload: jest.fn(() => ({ deal: null })),
    });
    const notifyWebhookFailure = buildNotifyWebhookFailure(deps);

    await expect(
      notifyWebhookFailure({ event: { _id: 'event-2', payload: {} }, lastError: 'boom', tenantModels: {} })
    ).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.hubspotClient.createNote).not.toHaveBeenCalled();
  });

  it('skips without throwing when no HubSpot credentials are found', async () => {
    const deps = buildDeps({
      hubspotWebhookAdapter: { resolveAccessTokenForPortal: jest.fn().mockResolvedValue(null) },
    });
    const notifyWebhookFailure = buildNotifyWebhookFailure(deps);

    await expect(
      notifyWebhookFailure({ event, lastError: 'boom', tenantModels: {} })
    ).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.hubspotClient.createNote).not.toHaveBeenCalled();
  });

  it('logs and swallows errors instead of throwing', async () => {
    const deps = buildDeps({
      hubspotClient: {
        createNote: jest.fn().mockRejectedValue(new Error('HubSpot down')),
        associateObjectsDefault: jest.fn(),
        updateDeal: jest.fn(),
      },
    });
    const notifyWebhookFailure = buildNotifyWebhookFailure(deps);

    await expect(
      notifyWebhookFailure({ event, lastError: 'boom', tenantModels: {} })
    ).resolves.toBeUndefined();

    expect(deps.logger.error).toHaveBeenCalled();
  });
});
