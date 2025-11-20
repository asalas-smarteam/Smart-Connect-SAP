const fastify = require('fastify')();
const dotenv = require('dotenv');
const { connect } = require('./config/database');
const echoRoutes = require('./routes/echo.routes');

dotenv.config();

fastify.register(require('@fastify/fast-json-stringify-compiler'));
fastify.register(echoRoutes);

async function start() {
  await connect();

  const port = process.env.PORT || 3000;

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on port ${port}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

start();
