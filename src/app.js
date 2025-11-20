const fastify = require('fastify')();
const dotenv = require('dotenv');
const { connect } = require('./config/database');
const echoRoutes = require('./routes/echo.routes');
const logger = require('./core/logger');

dotenv.config();

fastify.register(echoRoutes);

async function start() {
  await connect();

  const port = process.env.PORT || 3000;

  try {

    await fastify.listen({ port, host: '0.0.0.0' });
    logger.info(`Server running on port ${port}`);
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

start();
