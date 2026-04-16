import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { FastifyAdapter } from '@bull-board/fastify';
import { getSapSyncQueue } from '../queues/sapSync.queue.js';
import { getWebhookQueue } from '../queues/webhook.queue.js';
import { internalKeyAuthOnly } from '../middleware/internalAuth.js';
import logger from '../core/logger.js';

const DEFAULT_BULL_BOARD_PATH = '/admin/queues';

export function registerBullBoard(app) {
  const sapSyncQueue = getSapSyncQueue();
  const webhookQueue = getWebhookQueue();
  const serverAdapter = new FastifyAdapter();
  const basePath = process.env.BULL_BOARD_PATH || DEFAULT_BULL_BOARD_PATH;
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: [
      new BullMQAdapter(sapSyncQueue, {
        readOnlyMode: true,
        description: 'Managed by BullMQ schedulers and internal SAP sync admin APIs.',
      }),
      new BullMQAdapter(webhookQueue),
    ],
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: 'SAP Sync Queues',
      },
    },
  });

  app.register(async (instance) => {
    //instance.addHook('onRequest', internalKeyAuthOnly);
    instance.register(serverAdapter.registerPlugin(), {
      prefix: basePath,
    });
  });

  logger.info({
    msg: 'Bull Board registered',
    basePath,
  });
}
