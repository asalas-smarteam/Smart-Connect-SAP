import { jest } from '@jest/globals';

const env = {
  SAP_SYNC_CRON_ENABLED: 'false',
  WEBHOOK_PROCESSOR_CRON_ENABLED: undefined,
};
const mockInitializeExternalConnections = jest.fn();
const mockBootstrapSapSyncScheduler = jest.fn();
const mockStartSapSync = jest.fn();
const mockStartWebhookProcessor = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/config/env.js', () => ({
  default: env,
}));

jest.unstable_mockModule('../../src/infrastructure/database/externalDb.js', () => ({
  initializeExternalConnections: mockInitializeExternalConnections,
}));

jest.unstable_mockModule('../../src/bootstrap/sapSyncScheduler.bootstrap.js', () => ({
  bootstrapSapSyncScheduler: mockBootstrapSapSyncScheduler,
}));

jest.unstable_mockModule('../../src/interfaces/jobs/tasks/sapSyncTask.js', () => ({
  default: mockStartSapSync,
}));

jest.unstable_mockModule('../../src/interfaces/jobs/tasks/webhookProcessorTask.js', () => ({
  default: mockStartWebhookProcessor,
}));

const { registerAppLifecycle } = await import('../../src/bootstrap/appLifecycle.bootstrap.js');

function createApp() {
  const app = {
    onReadyHook: null,
    addHook: jest.fn((name, callback) => {
      app.onReadyHook = callback;
    }),
  };
  return app;
}

describe('appLifecycle.bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    env.SAP_SYNC_CRON_ENABLED = 'false';
    env.WEBHOOK_PROCESSOR_CRON_ENABLED = undefined;
    mockInitializeExternalConnections.mockResolvedValue(undefined);
    mockBootstrapSapSyncScheduler.mockResolvedValue(undefined);
    mockStartSapSync.mockReturnValue({ start: jest.fn() });
    mockStartWebhookProcessor.mockReturnValue({ start: jest.fn() });
  });

  it('does not start webhook dispatcher cron unless explicitly enabled', async () => {
    const app = createApp();

    registerAppLifecycle(app);
    await app.onReadyHook();

    expect(mockStartWebhookProcessor).not.toHaveBeenCalled();
  });

  it('starts webhook dispatcher cron when WEBHOOK_PROCESSOR_CRON_ENABLED is true', async () => {
    const app = createApp();
    const webhookJob = { start: jest.fn() };
    env.WEBHOOK_PROCESSOR_CRON_ENABLED = 'true';
    mockStartWebhookProcessor.mockReturnValue(webhookJob);

    registerAppLifecycle(app);
    await app.onReadyHook();

    expect(mockStartWebhookProcessor).toHaveBeenCalledTimes(1);
    expect(webhookJob.start).toHaveBeenCalledTimes(1);
  });
});
