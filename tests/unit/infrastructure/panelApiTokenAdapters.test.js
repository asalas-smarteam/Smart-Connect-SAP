import crypto from 'crypto';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import MongoosePanelApiTokenRepository from '../../../src/infrastructure/database/repositories/MongoosePanelApiTokenRepository.js';
import RandomApiToken from '../../../src/infrastructure/auth/RandomApiToken.js';
import { ApiTokenRepositoryPort } from '../../../src/application/ports/panel/api-token-repository.port.js';
import { ApiTokenCodecPort } from '../../../src/application/ports/panel/api-token-codec.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const USER_ID = '6710a1b2c3d4e5f601234567';
const TOKEN_ID = '6729a1c0f1e2d3c4b5a69788';
const OTHER_ID = '6729a1c0f1e2d3c4b5a69799';
const DAY = 24 * 60 * 60 * 1000;
const CREATED_AT = new Date('2026-11-04T15:00:00.000Z');
const EXPIRES_AT = new Date('2027-02-02T15:00:00.000Z');

function leanQuery(result) {
  const query = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(result),
  };
  return query;
}

function tokenDocument(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(TOKEN_ID),
    userId: new mongoose.Types.ObjectId(USER_ID),
    name: 'Claude Code - laptop',
    tokenHash: 'a'.repeat(64),
    prefix: 'spn_a1b2',
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    purgeAt: new Date(EXPIRES_AT.getTime() + 30 * DAY),
    ...overrides,
  };
}

const PUBLIC_RECORD = {
  id: TOKEN_ID,
  userId: USER_ID,
  name: 'Claude Code - laptop',
  prefix: 'spn_a1b2',
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
  lastUsedAt: null,
  revokedAt: null,
  revokedReason: null,
};

describe('MongoosePanelApiTokenRepository', () => {
  it('implements ApiTokenRepositoryPort', () => {
    expect(() => assertPort(new MongoosePanelApiTokenRepository({ model: {} }), ApiTokenRepositoryPort)).not.toThrow();
  });

  it('creates with purgeAt = expiresAt + 30 days and never returns the hash', async () => {
    const model = { create: jest.fn().mockResolvedValue({ toObject: () => tokenDocument() }) };
    const repository = new MongoosePanelApiTokenRepository({ model });

    const record = await repository.create({
      userId: USER_ID,
      name: 'Claude Code - laptop',
      tokenHash: 'a'.repeat(64),
      prefix: 'spn_a1b2',
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });

    expect(model.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      tokenHash: 'a'.repeat(64),
      lastUsedAt: null,
      revokedAt: null,
      revokedReason: null,
      purgeAt: new Date(EXPIRES_AT.getTime() + 30 * DAY),
    }));
    expect(record).toEqual(PUBLIC_RECORD);
    expect(record).not.toHaveProperty('tokenHash');
    expect(record).not.toHaveProperty('purgeAt');
    expect(record).not.toHaveProperty('_id');
  });

  it('lists only active tokens of the user, newest first, without the hash', async () => {
    const query = leanQuery([tokenDocument()]);
    const model = { find: jest.fn(() => query) };
    const repository = new MongoosePanelApiTokenRepository({ model });
    const now = new Date('2026-11-05T00:00:00.000Z');

    const items = await repository.listActiveByUser(USER_ID, now);

    expect(model.find).toHaveBeenCalledWith({ userId: USER_ID, revokedAt: null, expiresAt: { $gt: now } });
    expect(query.select).toHaveBeenCalledWith({ tokenHash: 0 });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(items).toEqual([PUBLIC_RECORD]);
  });

  it('counts active tokens with the same filter', async () => {
    const model = { countDocuments: jest.fn().mockResolvedValue(3) };
    const repository = new MongoosePanelApiTokenRepository({ model });
    const now = new Date();

    await expect(repository.countActiveByUser(USER_ID, now)).resolves.toBe(3);
    expect(model.countDocuments).toHaveBeenCalledWith({ userId: USER_ID, revokedAt: null, expiresAt: { $gt: now } });
  });

  it('finds by hash, including revoked ones, and ignores non-text hashes', async () => {
    const revokedAt = new Date('2026-11-06T00:00:00.000Z');
    const query = leanQuery(tokenDocument({ revokedAt, revokedReason: 'user' }));
    const model = { findOne: jest.fn(() => query) };
    const repository = new MongoosePanelApiTokenRepository({ model });

    const record = await repository.findByHash('b'.repeat(64));

    expect(model.findOne).toHaveBeenCalledWith({ tokenHash: 'b'.repeat(64) });
    expect(query.select).toHaveBeenCalledWith({ tokenHash: 0 });
    expect(record).toEqual({ ...PUBLIC_RECORD, revokedAt, revokedReason: 'user' });
    expect(await repository.findByHash({ $ne: null })).toBeNull();
    expect(await repository.findByHash('')).toBeNull();
    expect(model.findOne).toHaveBeenCalledTimes(1);
  });

  it('revokes only a non-revoked token of the same user and moves purgeAt to revokedAt + 30 days', async () => {
    const at = new Date('2026-11-06T00:00:00.000Z');
    const model = {
      findOneAndUpdate: jest.fn()
        .mockResolvedValueOnce(tokenDocument({ revokedAt: at, revokedReason: 'user' }))
        .mockResolvedValueOnce(null),
    };
    const repository = new MongoosePanelApiTokenRepository({ model });

    const record = await repository.revoke({ userId: USER_ID, id: TOKEN_ID, reason: 'user', at });
    const again = await repository.revoke({ userId: USER_ID, id: TOKEN_ID, reason: 'user', at });

    const [filter, update, options] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: TOKEN_ID, userId: USER_ID, revokedAt: null });
    expect(update).toEqual({ $set: { revokedAt: at, revokedReason: 'user', purgeAt: new Date(at.getTime() + 30 * DAY) } });
    expect(options).toEqual(expect.objectContaining({ new: true, lean: true, runValidators: true, projection: { tokenHash: 0 } }));
    expect(record).toEqual({ ...PUBLIC_RECORD, revokedAt: at, revokedReason: 'user' });
    expect(again).toBeNull();
  });

  it('returns null for malformed ids without querying', async () => {
    const model = { findOneAndUpdate: jest.fn(), updateOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() };
    const repository = new MongoosePanelApiTokenRepository({ model });
    const at = new Date();

    expect(await repository.revoke({ userId: USER_ID, id: 'abc', reason: 'user', at })).toBeNull();
    expect(await repository.revoke({ userId: USER_ID, id: { $ne: null }, reason: 'user', at })).toBeNull();
    expect(await repository.revoke({ userId: 'x', id: TOKEN_ID, reason: 'user', at })).toBeNull();
    expect(await repository.touchLastUsed('abc', at)).toBe(false);
    expect(await repository.listActiveByUser('abc', at)).toEqual([]);
    expect(await repository.countActiveByUser('abc', at)).toBe(0);
    expect(await repository.revokeAllForUser({ userId: 'abc', reason: 'user', at })).toEqual([]);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
    expect(model.find).not.toHaveBeenCalled();
    expect(model.countDocuments).not.toHaveBeenCalled();
  });

  it('revokes every non-revoked token (expired too) and returns only the ones this call revoked', async () => {
    const at = new Date('2026-11-06T00:00:00.000Z');
    const query = leanQuery([
      { _id: new mongoose.Types.ObjectId(TOKEN_ID) },
      { _id: new mongoose.Types.ObjectId(OTHER_ID) },
    ]);
    const model = {
      find: jest.fn(() => query),
      findOneAndUpdate: jest.fn()
        .mockResolvedValueOnce(tokenDocument({ revokedAt: at, revokedReason: 'user_deactivated' }))
        .mockResolvedValueOnce(null),
    };
    const repository = new MongoosePanelApiTokenRepository({ model });

    const revoked = await repository.revokeAllForUser({ userId: USER_ID, reason: 'user_deactivated', at });

    expect(model.find).toHaveBeenCalledWith({ userId: USER_ID, revokedAt: null });
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(model.findOneAndUpdate.mock.calls[1][0]).toEqual({ _id: OTHER_ID, userId: USER_ID, revokedAt: null });
    expect(revoked).toEqual([{ ...PUBLIC_RECORD, revokedAt: at, revokedReason: 'user_deactivated' }]);
  });

  it('touches lastUsedAt only when empty or older than 60 seconds', async () => {
    const at = new Date('2026-11-06T12:00:00.000Z');
    const model = { updateOne: jest.fn().mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValueOnce({ modifiedCount: 0 }) };
    const repository = new MongoosePanelApiTokenRepository({ model });

    await expect(repository.touchLastUsed(TOKEN_ID, at)).resolves.toBe(true);
    await expect(repository.touchLastUsed(TOKEN_ID, at)).resolves.toBe(false);

    expect(model.updateOne).toHaveBeenCalledWith(
      {
        _id: TOKEN_ID,
        $or: [
          { lastUsedAt: null },
          { lastUsedAt: { $lt: new Date('2026-11-06T11:59:00.000Z') } },
        ],
      },
      { $set: { lastUsedAt: at } }
    );
  });
});

describe('PanelApiToken schema (no database)', () => {
  it('declares the unique hash, the user index and the purge TTL', async () => {
    const { default: PanelApiToken } = await import('../../../src/infrastructure/database/models/global/PanelApiToken.js');
    const indexes = PanelApiToken.schema.indexes();

    expect(indexes).toEqual(expect.arrayContaining([
      [{ tokenHash: 1 }, expect.objectContaining({ unique: true })],
      [{ userId: 1, createdAt: -1 }, expect.anything()],
      [{ purgeAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
    ]));
    const valid = new PanelApiToken({
      userId: USER_ID,
      name: 'x',
      tokenHash: 'a'.repeat(64),
      prefix: 'spn_a1b2',
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      purgeAt: EXPIRES_AT,
    });
    expect(valid.collection.collectionName).toBe('PanelApiTokens');
    expect(valid.revokedReason).toBeNull();
    expect(valid.lastUsedAt).toBeNull();
    await expect(valid.validate()).resolves.toBeUndefined();
    valid.revokedReason = 'password_reset';
    await expect(valid.validate()).resolves.toBeUndefined();
    valid.revokedReason = 'otro';
    await expect(valid.validate()).rejects.toThrow();
    await expect(new PanelApiToken({ userId: USER_ID, name: 'x'.repeat(61) }).validate()).rejects.toThrow();
    expect(PanelApiToken.schema.path('token')).toBeUndefined();
  });
});

describe('RandomApiToken', () => {
  it('implements ApiTokenCodecPort', () => {
    expect(() => assertPort(new RandomApiToken(), ApiTokenCodecPort)).not.toThrow();
  });

  it('generates spn_ + 43 base64url characters with its 8-character prefix and SHA-256 hash', () => {
    const codec = new RandomApiToken();
    const { token, hash, prefix } = codec.generate();

    expect(token).toMatch(/^spn_[A-Za-z0-9_-]{43}$/);
    expect(token).toHaveLength(47);
    expect(prefix).toBe(token.slice(0, 8));
    expect(prefix.startsWith('spn_')).toBe(true);
    expect(hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(codec.hash(token)).toBe(hash);
  });

  it('never repeats a token', () => {
    const codec = new RandomApiToken();
    const tokens = new Set(Array.from({ length: 50 }, () => codec.generate().token));
    expect(tokens.size).toBe(50);
  });
});
