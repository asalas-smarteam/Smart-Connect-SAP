import mongoose from 'mongoose';
import { connect } from '../config/database.js';
import { APP_VERSION } from '../config/appMetadata.js';

export const health = async (req, reply) => {
  try {
    await connect();
    const readyState = mongoose.connection.readyState;
    const stateLabels = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };
    return reply.send({
      ok: readyState === 1,
      database: stateLabels[readyState] || 'unknown',
      timestamp: new Date().toISOString(),
      version: APP_VERSION,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      database: 'error',
      message: error.message,
    });
  }
};
