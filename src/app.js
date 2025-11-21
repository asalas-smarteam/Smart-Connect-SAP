import Fastify from 'fastify';
import routes from './routes/index.js';
import winstonLogger from './core/logger.js';

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

export default app;
