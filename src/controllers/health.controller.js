import database from '../config/database.js';

export const health = async (req, reply) => {
  try {
    await database.sequelize.authenticate();

    return reply.send({
      ok: true,
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return reply.send({
      ok: false,
      database: 'error',
      message: error.message,
    });
  }
};
