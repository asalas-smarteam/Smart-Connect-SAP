const echoController = require('../controllers/echo.controller');

function echoRoutes(fastify) {
  fastify.post('/echo_test', echoController.echoTest);
}

module.exports = echoRoutes;
