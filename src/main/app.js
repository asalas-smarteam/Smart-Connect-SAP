import Fastify from 'fastify';
import routes from '#interfaces/http/routes/index.js';
import appConfig from '#infrastructure/config/app.config.js';
import { registerBullBoard } from '#bootstrap/bullBoard.js';
import { registerAppLifecycle } from '#bootstrap/appLifecycle.bootstrap.js';
import logger from '#infrastructure/logger/logger.adapter.js';

const app = Fastify({
  logger: appConfig.logger
});

// 🧩 Asegura que Fastify pueda leer JSON (importante para Power BI y Postman)
app.addContentTypeParser(appConfig.jsonContentType, { parseAs: 'string' }, function (req, body, done) {
  try {
    const json = JSON.parse(body);
    done(null, json);
  } catch (err) {
    done(err, undefined);
  }
});

// Middleware opcional de auditoría
app.addHook('onRequest', async (req, reply) => {
  logger.info({
    msg: 'Incoming request',
    method: req.method,
    url: req.url,
    ip: req.ip
  });
});

// Rutas principales
app.register(routes);
registerBullBoard(app);
registerAppLifecycle(app);

export default app;
