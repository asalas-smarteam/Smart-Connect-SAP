import { connect, database } from './master/database.js';

const STATE_LABELS = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
});

export class MongooseDatabaseStatusProvider {
  async getStatus() {
    await connect();
    const readyState = database.readyState;

    return {
      ok: readyState === 1,
      database: STATE_LABELS[readyState] || 'unknown',
    };
  }
}

export default MongooseDatabaseStatusProvider;

