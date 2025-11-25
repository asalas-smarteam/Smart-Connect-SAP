import Fastify from 'fastify';
import routes from './routes/index.js';
import winstonLogger from './core/logger.js';
import startSapSync from './tasks/sapSyncTask.js';
import { initializeExternalConnections } from './utils/externalDb.js';

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
app.register(routes, { prefix: '/api' });

app.addHook('onReady', async () => {
  await initializeExternalConnections();
  const job = startSapSync();
  job.start();
});

export default app;
