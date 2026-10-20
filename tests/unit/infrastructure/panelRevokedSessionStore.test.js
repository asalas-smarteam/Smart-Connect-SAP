import { jest } from '@jest/globals';
import MongooseRevokedSessionStore from '../../../src/infrastructure/database/repositories/MongooseRevokedSessionStore.js';

describe('MongooseRevokedSessionStore', () => {
  it('revokes with an idempotent upsert', async () => {
    const model = { updateOne: jest.fn().mockResolvedValueOnce({ upsertedCount: 1 }).mockResolvedValueOnce({ upsertedCount: 0 }) };
    const store = new MongooseRevokedSessionStore({ model });
    const expiresAt = new Date('2026-10-13T20:00:00.000Z');

    await expect(store.revoke({ sid: 's1', userId: 'u1', expiresAt })).resolves.toBe(true);
    await expect(store.revoke({ sid: 's1', userId: 'u1', expiresAt })).resolves.toBe(false);

    expect(model.updateOne).toHaveBeenCalledWith(
      { sid: 's1' },
      { $setOnInsert: { sid: 's1', userId: 'u1', expiresAt } },
      { upsert: true }
    );
  });

  it('treats a duplicate key race as already revoked and rethrows other errors', async () => {
    const duplicate = Object.assign(new Error('E11000'), { code: 11000 });
    const store = new MongooseRevokedSessionStore({ model: { updateOne: jest.fn().mockRejectedValue(duplicate) } });
    const failing = new MongooseRevokedSessionStore({ model: { updateOne: jest.fn().mockRejectedValue(new Error('down')) } });

    await expect(store.revoke({ sid: 's1', expiresAt: new Date() })).resolves.toBe(false);
    await expect(failing.revoke({ sid: 's1', expiresAt: new Date() })).rejects.toThrow('down');
  });

  it('checks revocation by sid', async () => {
    const model = { exists: jest.fn().mockResolvedValueOnce({ _id: 'x' }).mockResolvedValueOnce(null) };
    const store = new MongooseRevokedSessionStore({ model });

    await expect(store.isRevoked('s1')).resolves.toBe(true);
    await expect(store.isRevoked('s2')).resolves.toBe(false);
    await expect(store.isRevoked(undefined)).resolves.toBe(false);
    expect(model.exists).toHaveBeenCalledTimes(2);
  });
});

describe('PanelRevokedSession schema (no database)', () => {
  it('declares a unique sid and a TTL on expiresAt', async () => {
    const { default: PanelRevokedSession } = await import('../../../src/infrastructure/database/models/global/PanelRevokedSession.js');
    const indexes = PanelRevokedSession.schema.indexes();

    expect(indexes).toEqual(expect.arrayContaining([
      [{ sid: 1 }, expect.objectContaining({ unique: true })],
      [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
    ]));
    expect(new PanelRevokedSession({ sid: 's', expiresAt: new Date() }).collection.collectionName).toBe('PanelRevokedSessions');
    await expect(new PanelRevokedSession({ sid: 's' }).validate()).rejects.toThrow();
  });
});
