import mongoose from 'mongoose';
import { connect } from '../config/database.js';

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
      version: "1.1.0" 
    });
  } catch (error) {
    return reply.send({
      ok: false,
      database: 'error',
      message: error.message,
    });
  }
};
