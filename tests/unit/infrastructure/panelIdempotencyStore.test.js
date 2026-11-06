import { jest } from '@jest/globals';
import MongooseIdempotencyStore from '../../../src/infrastructure/database/repositories/MongooseIdempotencyStore.js';
import { IdempotencyStorePort } from '../../../src/application/ports/panel/idempotency-store.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const OWNER = 'token:6729a1c0f1e2d3c4b5a69788';
const KEY = '0b6f6c1e-8d2a-4f7e-9c11-3f2b8a1d5e70';
const FINGERPRINT = 'f'.repeat(64);
const AT = new Date('2026-11-04T21:10:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function leanQuery(result) {
  return { lean: jest.fn().mockResolvedValue(result) };
}

function keyDocument(overrides = {}) {
  return {
    _id: 'x',
    ownerKey: OWNER,
    key: KEY,
    fingerprint: FINGERPRINT,
    state: 'pending',
    tenantKey: null,
    ticketId: null,
    entryId: null,
    status: null,
    createdAt: AT,
    expiresAt: new Date(AT.getTime() + DAY),
    ...overrides,
  };
}

describe('MongooseIdempotencyStore', () => {
  it('implements IdempotencyStorePort', () => {
    expect(() => assertPort(new MongooseIdempotencyStore({ model: {} }), IdempotencyStorePort)).not.toThrow();
  });

  it('finds by owner and key and returns a plain record', async () => {
    const model = { findOne: jest.fn(() => leanQuery(keyDocument())) };
    const store = new MongooseIdempotencyStore({ model, now: () => AT });

    const record = await store.find({ ownerKey: OWNER, key: KEY });

    expect(model.findOne).toHaveBeenCalledWith({ ownerKey: OWNER, key: KEY, expiresAt: { $gt: AT } });
    expect(record).toEqual({
      ownerKey: OWNER,
      key: KEY,
      fingerprint: FINGERPRINT,
      state: 'pending',
      tenantKey: null,
      ticketId: null,
      entryId: null,
      status: null,
      createdAt: AT,
      expiresAt: new Date(AT.getTime() + DAY),
    });
    expect(record).not.toHaveProperty('_id');
    expect(await store.find({ ownerKey: OWNER, key: { $ne: null } })).toBeNull();
    expect(model.findOne).toHaveBeenCalledTimes(1);
  });

  it('ignores an expired key the TTL monitor has not purged yet (expiresAt > now)', async () => {
    const later = new Date(AT.getTime() + DAY + 1);
    const model = { findOne: jest.fn(() => leanQuery(null)) };
    const store = new MongooseIdempotencyStore({ model, now: () => AT });

    expect(await store.find({ ownerKey: OWNER, key: KEY, now: later })).toBeNull();
    expect(model.findOne).toHaveBeenCalledWith({ ownerKey: OWNER, key: KEY, expiresAt: { $gt: later } });
  });

  it('uses the system clock by default', async () => {
    const model = { findOne: jest.fn(() => leanQuery(null)) };
    const store = new MongooseIdempotencyStore({ model });
    const before = Date.now();

    await store.find({ ownerKey: OWNER, key: KEY });

    const [[filter]] = model.findOne.mock.calls;
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
    expect(filter.expiresAt.$gt.getTime()).toBeGreaterThanOrEqual(before);
    expect(filter.expiresAt.$gt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reserves as pending with expiresAt = at + 24 h', async () => {
    const model = { create: jest.fn().mockResolvedValue({ toObject: () => keyDocument() }) };
    const store = new MongooseIdempotencyStore({ model });

    const record = await store.reserve({ ownerKey: OWNER, key: KEY, fingerprint: FINGERPRINT, at: AT });

    expect(model.create).toHaveBeenCalledWith({
      ownerKey: OWNER,
      key: KEY,
      fingerprint: FINGERPRINT,
      state: 'pending',
      tenantKey: null,
      ticketId: null,
      entryId: null,
      status: null,
      createdAt: AT,
      expiresAt: new Date(AT.getTime() + DAY),
    });
    expect(record.state).toBe('pending');
  });

  it('returns null on a duplicate key race and rethrows other errors', async () => {
    const duplicate = Object.assign(new Error('E11000'), { code: 11000 });
    const store = new MongooseIdempotencyStore({ model: { create: jest.fn().mockRejectedValue(duplicate) } });
    const failing = new MongooseIdempotencyStore({ model: { create: jest.fn().mockRejectedValue(new Error('down')) } });
    const input = { ownerKey: OWNER, key: KEY, fingerprint: FINGERPRINT, at: AT };

    await expect(store.reserve(input)).resolves.toBeNull();
    await expect(failing.reserve(input)).rejects.toThrow('down');
  });

  it('takes over a stale pending key with the same fingerprint without moving expiresAt', async () => {
    const later = new Date(AT.getTime() + 90 * 1000);
    const staleBefore = new Date(later.getTime() - 60 * 1000);
    const model = {
      findOneAndUpdate: jest.fn()
        .mockResolvedValueOnce(keyDocument({ createdAt: later }))
        .mockResolvedValueOnce(null),
    };
    const store = new MongooseIdempotencyStore({ model });
    const input = { ownerKey: OWNER, key: KEY, fingerprint: FINGERPRINT, staleBefore, at: later };

    const record = await store.takeOver(input);
    const lost = await store.takeOver(input);

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { ownerKey: OWNER, key: KEY, state: 'pending', fingerprint: FINGERPRINT, createdAt: { $lt: staleBefore } },
      { $set: { createdAt: later } },
      { new: true, lean: true }
    );
    expect(record.createdAt).toEqual(later);
    expect(lost).toBeNull();
  });

  it('completes only its own pending reservation', async () => {
    const model = { updateOne: jest.fn().mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValueOnce({ modifiedCount: 0 }) };
    const store = new MongooseIdempotencyStore({ model });
    const input = {
      ownerKey: OWNER,
      key: KEY,
      createdAt: AT,
      tenantKey: 'sap_integration_acme',
      ticketId: '6711b2c3d4e5f60123456789',
      entryId: '6729b0aa1b2c3d4e5f607182',
      status: 201,
    };

    await expect(store.complete(input)).resolves.toBe(true);
    await expect(store.complete(input)).resolves.toBe(false);

    expect(model.updateOne).toHaveBeenCalledWith(
      { ownerKey: OWNER, key: KEY, state: 'pending', createdAt: AT },
      {
        $set: {
          state: 'done',
          tenantKey: 'sap_integration_acme',
          ticketId: '6711b2c3d4e5f60123456789',
          entryId: '6729b0aa1b2c3d4e5f607182',
          status: 201,
        },
      }
    );
  });

  it('releases only its own pending reservation', async () => {
    const model = { deleteOne: jest.fn().mockResolvedValueOnce({ deletedCount: 1 }).mockResolvedValueOnce({ deletedCount: 0 }) };
    const store = new MongooseIdempotencyStore({ model });

    await expect(store.release({ ownerKey: OWNER, key: KEY, createdAt: AT })).resolves.toBe(true);
    await expect(store.release({ ownerKey: OWNER, key: KEY, createdAt: AT })).resolves.toBe(false);
    expect(model.deleteOne).toHaveBeenCalledWith({ ownerKey: OWNER, key: KEY, state: 'pending', createdAt: AT });
  });
});

describe('PanelIdempotencyKey schema (no database)', () => {
  it('declares the unique owner+key and a TTL on expiresAt, without body fields', async () => {
    const { default: PanelIdempotencyKey } = await import('../../../src/infrastructure/database/models/global/PanelIdempotencyKey.js');
    const indexes = PanelIdempotencyKey.schema.indexes();

    expect(indexes).toEqual(expect.arrayContaining([
      [{ ownerKey: 1, key: 1 }, expect.objectContaining({ unique: true })],
      [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
    ]));
    const { _id, ...fields } = keyDocument();
    const document = new PanelIdempotencyKey(fields);
    expect(document.collection.collectionName).toBe('PanelIdempotencyKeys');
    await expect(document.validate()).resolves.toBeUndefined();
    document.state = 'otro';
    await expect(document.validate()).rejects.toThrow();
    for (const field of ['summary', 'internalNote', 'body', 'response']) {
      expect(PanelIdempotencyKey.schema.path(field)).toBeUndefined();
    }
  });
});
