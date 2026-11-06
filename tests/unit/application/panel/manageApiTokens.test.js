import { jest } from '@jest/globals';
import ManageApiTokens from '../../../../src/application/use-cases/panel/ManageApiTokens.js';
import { panelReasons } from '../../../../src/application/use-cases/panel/panelReasons.js';
import {
  FakeLoginAttempts,
  FakePasswordHasher,
  InMemoryPanelUserRepository,
  RecordingAuditLog,
  staffUser,
} from './panelFakes.js';
import { FakeApiTokenCodec, InMemoryApiTokenRepository } from './apiTokenFakes.js';

const NOW = new Date('2026-11-04T15:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'clave-del-staff';
const TOKEN_FORMAT = /^spn_[A-Za-z0-9_-]{43}$/;

function setup(users = [staffUser()]) {
  const userRepository = new InMemoryPanelUserRepository(users);
  const apiTokenRepository = new InMemoryApiTokenRepository();
  const apiTokenCodec = new FakeApiTokenCodec();
  const passwordAttempts = new FakeLoginAttempts(5);
  const auditLog = new RecordingAuditLog();
  let current = NOW;
  const useCase = new ManageApiTokens({
    apiTokenRepository,
    apiTokenCodec,
    userRepository,
    passwordHasher: new FakePasswordHasher(),
    passwordAttempts,
    auditLog,
    now: () => current,
  });
  const sessionUser = (user = users[0]) => ({ id: user.id, name: user.name, email: user.email, accountType: user.accountType });
  return {
    userRepository,
    apiTokenRepository,
    apiTokenCodec,
    passwordAttempts,
    auditLog,
    useCase,
    sessionUser,
    setNow: (value) => { current = value; },
  };
}

async function seedToken(ctx, { userId, createdAt = NOW, expiresAt = new Date(NOW.getTime() + 90 * DAY_MS), name = 'Viejo', revoked = false }) {
  const { hash, prefix } = ctx.apiTokenCodec.generate();
  const record = await ctx.apiTokenRepository.create({ userId, name, tokenHash: hash, prefix, createdAt, expiresAt });
  if (revoked) {
    await ctx.apiTokenRepository.revoke({ userId, id: record.id, reason: 'user', at: createdAt });
  }
  return record;
}

describe('ManageApiTokens.create', () => {
  it('answers 201 with a spn_ token shown once, stores only the SHA-256 and expires in 90 days', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();

    const result = await ctx.useCase.create({ user, fields: { name: '  Claude Code - laptop  ', currentPassword: PASSWORD }, ip: '10.0.0.1' });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(201);
    const { token, item } = result.data;
    expect(token).toMatch(TOKEN_FORMAT);
    expect(token).toHaveLength(47);
    expect(item).toEqual({
      id: expect.any(String),
      name: 'Claude Code - laptop',
      prefix: token.slice(0, 8),
      createdAt: '2026-11-04T15:00:00.000Z',
      expiresAt: '2027-02-02T15:00:00.000Z',
      lastUsedAt: null,
    });
    expect(new Date(item.expiresAt).getTime() - new Date(item.createdAt).getTime()).toBe(90 * DAY_MS);
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('tokenHash');

    const [stored] = ctx.apiTokenRepository.records;
    expect(stored.tokenHash).toBe(ctx.apiTokenCodec.hash(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.userId).toBe(user.id);
  });

  it('audits api_token.created with id, prefix, name and expiresAt, never the token', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();

    const result = await ctx.useCase.create({ user, fields: { name: 'Laptop', currentPassword: PASSWORD }, ip: '10.0.0.1' });

    expect(ctx.auditLog.entries).toHaveLength(1);
    const [entry] = ctx.auditLog.entries;
    expect(entry).toEqual(expect.objectContaining({
      action: 'api_token.created',
      actor: { userId: user.id, email: user.email, accountType: 'smarteam' },
      target: { userId: user.id, email: user.email, tenantKey: null },
      details: { tokenId: result.data.item.id, prefix: result.data.item.prefix, name: 'Laptop', expiresAt: result.data.item.expiresAt },
      ip: '10.0.0.1',
      expiresAt: null,
    }));
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(result.data.token);
    expect(serialized).not.toContain(ctx.apiTokenCodec.hash(result.data.token));
  });

  it.each([
    ['an empty name', ''],
    ['a name of only spaces', '    '],
    ['a 61-character name', 'x'.repeat(61)],
    ['a missing name', undefined],
  ])('rejects %s with validation_error', async (_label, name) => {
    const ctx = setup();

    const result = await ctx.useCase.create({ user: ctx.sessionUser(), fields: { name, currentPassword: PASSWORD } });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message: 'El nombre debe tener entre 1 y 60 caracteres.' });
    expect(ctx.apiTokenRepository.records).toHaveLength(0);
  });

  it.each([
    ['a line break', 'Laptop\nnueva'],
    ['a tab', 'Laptop\tnueva'],
    ['a NUL character', 'Laptop\u0000'],
  ])('rejects a name with %s instead of cleaning it', async (_label, name) => {
    const ctx = setup();

    const result = await ctx.useCase.create({ user: ctx.sessionUser(), fields: { name, currentPassword: PASSWORD } });

    expect(result).toEqual({
      ok: false,
      reason: panelReasons.VALIDATION_ERROR,
      message: 'El nombre no puede tener saltos de línea ni caracteres especiales.',
    });
  });

  it('accepts a 60-character name and repeated names', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();

    const first = await ctx.useCase.create({ user, fields: { name: 'x'.repeat(60), currentPassword: PASSWORD } });
    const second = await ctx.useCase.create({ user, fields: { name: 'x'.repeat(60), currentPassword: PASSWORD } });

    expect(first.ok && second.ok).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not text', 12345],
  ])('rejects a %s currentPassword with validation_error before counting or verifying', async (_label, currentPassword) => {
    const ctx = setup();

    const result = await ctx.useCase.create({ user: ctx.sessionUser(), fields: { name: 'Laptop', currentPassword } });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message: 'Escribe tu contraseña actual.' });
    expect(ctx.passwordAttempts.failures.size).toBe(0);
  });

  it('answers invalid_current_password (400, same body as change-password) and creates nothing', async () => {
    const ctx = setup();

    const result = await ctx.useCase.create({ user: ctx.sessionUser(), fields: { name: 'Laptop', currentPassword: 'otra' } });

    expect(result).toEqual({
      ok: false,
      reason: panelReasons.INVALID_CURRENT_PASSWORD,
      message: 'La contraseña actual no es correcta.',
    });
    expect(ctx.apiTokenRepository.records).toHaveLength(0);
    expect(ctx.apiTokenCodec.count).toBe(0);
    expect(ctx.auditLog.entries).toHaveLength(0);
  });

  it('blocks the sixth attempt with 429 and Retry-After even with the right password, without verifying', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await ctx.useCase.create({ user, fields: { name: 'Laptop', currentPassword: 'mala' } });
      expect(wrong.reason).toBe(panelReasons.INVALID_CURRENT_PASSWORD);
    }
    const verify = jest.spyOn(FakePasswordHasher.prototype, 'verify');

    const result = await ctx.useCase.create({ user, fields: { name: 'Laptop', currentPassword: PASSWORD } });

    expect(result).toEqual({
      ok: false,
      reason: panelReasons.TOO_MANY_ATTEMPTS,
      message: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.',
      retryAfterSeconds: 900,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(ctx.apiTokenRepository.records).toHaveLength(0);
    verify.mockRestore();
  });

  it('counts per user id and resets the counter after a right password', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await ctx.useCase.create({ user, fields: { name: 'Laptop', currentPassword: 'mala' } });
    }

    const ok = await ctx.useCase.create({ user, fields: { name: 'Laptop', currentPassword: PASSWORD } });

    expect(ok.ok).toBe(true);
    expect(ctx.passwordAttempts.failures.has(user.id)).toBe(false);
  });

  it('answers token_limit with the right password and 5 active tokens', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();
    for (let index = 0; index < 5; index += 1) {
      await seedToken(ctx, { userId: user.id });
    }

    const result = await ctx.useCase.create({ user, fields: { name: 'Sexto', currentPassword: PASSWORD } });

    expect(result).toEqual({
      ok: false,
      reason: panelReasons.TOKEN_LIMIT,
      message: 'Ya tienes 5 tokens activos. Revoca uno para crear otro.',
    });
    expect(ctx.apiTokenRepository.records).toHaveLength(5);
  });

  it('checks the password before the token limit, so token_limit does not test passwords', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();
    for (let index = 0; index < 5; index += 1) {
      await seedToken(ctx, { userId: user.id });
    }

    const result = await ctx.useCase.create({ user, fields: { name: 'Sexto', currentPassword: 'mala' } });

    expect(result.reason).toBe(panelReasons.INVALID_CURRENT_PASSWORD);
  });

  it('creates with 4 active tokens plus expired and revoked ones', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();
    for (let index = 0; index < 4; index += 1) {
      await seedToken(ctx, { userId: user.id });
    }
    await seedToken(ctx, { userId: user.id, createdAt: new Date('2026-07-01T00:00:00Z'), expiresAt: new Date('2026-09-29T00:00:00Z') });
    await seedToken(ctx, { userId: user.id, createdAt: new Date('2026-07-02T00:00:00Z'), expiresAt: new Date('2026-09-30T00:00:00Z') });
    await seedToken(ctx, { userId: user.id, revoked: true });

    const result = await ctx.useCase.create({ user, fields: { name: 'Quinto', currentPassword: PASSWORD } });

    expect(result.ok).toBe(true);
  });

  it('answers unauthorized when the session user no longer exists or is inactive', async () => {
    const inactive = staffUser({ active: false });
    const ctx = setup([inactive]);

    const result = await ctx.useCase.create({ user: ctx.sessionUser(), fields: { name: 'Laptop', currentPassword: PASSWORD } });

    expect(result).toEqual({ ok: false, reason: panelReasons.UNAUTHORIZED });
  });
});

describe('ManageApiTokens.list', () => {
  it('returns only the active tokens of the user, newest first, without token or tokenHash', async () => {
    const owner = staffUser();
    const other = staffUser({ email: 'otro@smarteam.test' });
    const ctx = setup([owner, other]);
    const older = await seedToken(ctx, { userId: owner.id, name: 'Viejo', createdAt: new Date('2026-11-01T00:00:00Z') });
    const newer = await seedToken(ctx, { userId: owner.id, name: 'Nuevo', createdAt: new Date('2026-11-03T00:00:00Z') });
    await seedToken(ctx, { userId: owner.id, name: 'Revocado', revoked: true });
    await seedToken(ctx, { userId: owner.id, name: 'Vencido', createdAt: new Date('2026-07-01T00:00:00Z'), expiresAt: new Date('2026-09-29T00:00:00Z') });
    await seedToken(ctx, { userId: other.id, name: 'Ajeno' });
    await ctx.apiTokenRepository.touchLastUsed(newer.id, new Date('2026-11-04T10:00:00Z'));

    const result = await ctx.useCase.list({ user: ctx.sessionUser(owner) });

    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          {
            id: newer.id,
            name: 'Nuevo',
            prefix: newer.prefix,
            createdAt: '2026-11-03T00:00:00.000Z',
            expiresAt: newer.expiresAt.toISOString(),
            lastUsedAt: '2026-11-04T10:00:00.000Z',
          },
          {
            id: older.id,
            name: 'Viejo',
            prefix: older.prefix,
            createdAt: '2026-11-01T00:00:00.000Z',
            expiresAt: older.expiresAt.toISOString(),
            lastUsedAt: null,
          },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('tokenHash');
    ctx.apiTokenCodec.generated.forEach(({ token, hash }) => {
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(hash);
    });
  });
});

describe('ManageApiTokens.revoke', () => {
  it('revokes an own token (204) and audits api_token.revoked with reason user', async () => {
    const ctx = setup();
    const user = ctx.sessionUser();
    const token = await seedToken(ctx, { userId: user.id });

    const result = await ctx.useCase.revoke({ user, id: token.id, ip: '10.0.0.2' });

    expect(result).toEqual({ ok: true, statusCode: 204 });
    expect(ctx.apiTokenRepository.records[0]).toEqual(expect.objectContaining({ revokedAt: NOW, revokedReason: 'user' }));
    expect(ctx.auditLog.entries).toEqual([expect.objectContaining({
      action: 'api_token.revoked',
      actor: expect.objectContaining({ userId: user.id }),
      target: expect.objectContaining({ userId: user.id }),
      details: { tokenId: token.id, prefix: token.prefix, reason: 'user' },
      ip: '10.0.0.2',
    })]);
    expect((await ctx.useCase.list({ user })).data.items).toEqual([]);
  });

  it('answers not_found for another user token, an unknown id, an invalid id or an already revoked one', async () => {
    const owner = staffUser();
    const other = staffUser({ email: 'otro@smarteam.test' });
    const ctx = setup([owner, other]);
    const foreign = await seedToken(ctx, { userId: other.id });
    const revoked = await seedToken(ctx, { userId: owner.id, revoked: true });
    const user = ctx.sessionUser(owner);

    for (const id of [foreign.id, 'ffffffffffffffffffffffff', 'no-es-id', revoked.id, undefined]) {
      expect(await ctx.useCase.revoke({ user, id })).toEqual({ ok: false, reason: panelReasons.NOT_FOUND });
    }
    expect(ctx.apiTokenRepository.records.find((record) => record.id === foreign.id).revokedAt).toBeNull();
    expect(ctx.auditLog.entries).toHaveLength(0);
  });
});

describe('ManageApiTokens.revokeAllForUser', () => {
  it('revokes every token of the owner and audits one entry per token (actor = admin, target = owner)', async () => {
    const owner = staffUser();
    const admin = staffUser({ email: 'admin@smarteam.test' });
    const ctx = setup([owner, admin]);
    const first = await seedToken(ctx, { userId: owner.id });
    const second = await seedToken(ctx, { userId: owner.id });
    await seedToken(ctx, { userId: admin.id });

    const revoked = await ctx.useCase.revokeAllForUser({
      userId: owner.id,
      reason: 'user_deactivated',
      actor: { id: admin.id, email: admin.email, accountType: 'smarteam' },
      ip: '10.0.0.3',
    });

    expect(revoked.map((record) => record.id).sort()).toEqual([first.id, second.id].sort());
    expect(ctx.apiTokenRepository.records.filter((record) => record.userId === owner.id).every((record) => record.revokedReason === 'user_deactivated')).toBe(true);
    expect(ctx.apiTokenRepository.records.find((record) => record.userId === admin.id).revokedAt).toBeNull();
    expect(ctx.auditLog.entries).toHaveLength(2);
    ctx.auditLog.entries.forEach((entry) => {
      expect(entry).toEqual(expect.objectContaining({
        action: 'api_token.revoked',
        actor: expect.objectContaining({ userId: admin.id }),
        target: { userId: owner.id, email: owner.email, tenantKey: null },
        details: expect.objectContaining({ reason: 'user_deactivated' }),
        ip: '10.0.0.3',
      }));
    });
  });

  it('does nothing and audits nothing when there is nothing to revoke', async () => {
    const ctx = setup();

    expect(await ctx.useCase.revokeAllForUser({ userId: ctx.sessionUser().id, reason: 'password_reset' })).toEqual([]);
    expect(ctx.auditLog.entries).toHaveLength(0);
  });

  it('propagates a repository failure', async () => {
    const ctx = setup();
    ctx.apiTokenRepository.failNextRevokeAll = true;

    await expect(ctx.useCase.revokeAllForUser({ userId: ctx.sessionUser().id, reason: 'password_reset' })).rejects.toThrow('api token revoke failed');
  });
});
