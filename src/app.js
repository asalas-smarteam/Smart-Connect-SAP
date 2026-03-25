import Fastify from 'fastify';
import routes from './routes/index.js';
import winstonLogger from './core/logger.js';
import startSapSync from './tasks/sapSyncTask.js';
import startWebhookProcessor from './tasks/webhookProcessorTask.js';
import { initializeExternalConnections } from './utils/externalDb.js';
import env from './config/env.js';
import { bootstrapSapSyncScheduler } from './bootstrap/sapSyncScheduler.bootstrap.js';
import { registerBullBoard } from './bootstrap/bullBoard.js';

const app = Fastify({
  logger: true
});

// 🧩 Asegura que Fastify pueda leer JSON (importante para Power BI y Postman)
app.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
  try {
    const json = JSON.parse(body);
    done(null, json);
  } catch (err) {
    done(err, undefined);
  }
});

// Middleware opcional de auditoría
app.addHook('onRequest', async (req, reply) => {
  winstonLogger.info({
    msg: 'Incoming request',
    method: req.method,
    url: req.url,
    ip: req.ip
  });
});

// Rutas principales
app.register(routes);
registerBullBoard(app);

app.addHook('onReady', async () => {
  await initializeExternalConnections();
  await bootstrapSapSyncScheduler();
  const isSapSyncEnabled = env.SAP_SYNC_CRON_ENABLED !== 'false';

  if (isSapSyncEnabled) {
    const job = await startSapSync();
    if (job?.start) {
      job.start();
    }
  }

  const isWebhookProcessorEnabled = env.WEBHOOK_PROCESSOR_CRON_ENABLED !== 'false';
  if (isWebhookProcessorEnabled) {
    const webhookJob = await startWebhookProcessor();
    if (webhookJob?.start) {
      webhookJob.start();
    }
  }
});

export default app;
