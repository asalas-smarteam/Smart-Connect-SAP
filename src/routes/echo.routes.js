const echoController = require('../controllers/echo.controller');

async function echoRoutes(fastify, opts) {
  fastify.post('/echo_test', echoController.echoTest);
}

module.exports = echoRoutes;
