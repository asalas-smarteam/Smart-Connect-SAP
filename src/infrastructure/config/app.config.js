import env from './env.js';

const DEFAULT_PORT = 3000;

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

function buildFastifyLoggerConfig() {
  if (process.env.FASTIFY_PRETTY_LOGS !== 'true') {
    return true;
  }

  return {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  };
}

export const appConfig = Object.freeze({
  port: normalizePort(env.PORT),
  logger: buildFastifyLoggerConfig(),
  jsonContentType: 'application/json',
});

export default appConfig;

