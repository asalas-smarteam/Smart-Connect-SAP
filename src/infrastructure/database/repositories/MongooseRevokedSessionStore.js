import PanelRevokedSession from '../models/global/PanelRevokedSession.js';

const DUPLICATE_KEY_ERROR = 11000;

export class MongooseRevokedSessionStore {
  constructor({ model = PanelRevokedSession } = {}) {
    this.model = model;
  }

  // Idempotente: revocar dos veces la misma sesión no falla. Devuelve true solo si esta llamada
  // la revocó (para no auditar cada logout repetido). Un E11000 solo puede venir de dos
  // revocaciones simultáneas del mismo sid; la otra ya la dejó revocada.
  async revoke({ sid, userId = null, expiresAt }) {
    try {
      const result = await this.model.updateOne(
        { sid },
        { $setOnInsert: { sid, userId, expiresAt } },
        { upsert: true }
      );
      return Number(result?.upsertedCount ?? 0) > 0;
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY_ERROR) {
        throw error;
      }
      return false;
    }
  }

  async isRevoked(sid) {
    if (!sid) {
      return false;
    }

    const found = await this.model.exists({ sid });
    return Boolean(found);
  }
}

export default MongooseRevokedSessionStore;
