import { jest } from '@jest/globals';
import ResolveApiToken from '../../../../src/application/use-cases/panel/ResolveApiToken.js';
import { panelReasons } from '../../../../src/application/use-cases/panel/panelReasons.js';
import { InMemoryPanelUserRepository, clientUser, staffUser } from './panelFakes.js';
import { FakeApiTokenCodec, InMemoryApiTokenRepository } from './apiTokenFakes.js';

const NOW = new Date('2026-11-04T15:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID = { ok: false, reason: panelReasons.INVALID_TOKEN };

async function setup(owner = staffUser(), { expiresAt = new Date(NOW.getTime() + 90 * DAY_MS), revoked = false } = {}) {
  const userRepository = new InMemoryPanelUserRepository([owner]);
  const apiTokenRepository = new InMemoryApiTokenRepository();
  const apiTokenCodec = new FakeApiTokenCodec();
  const logger = { warn: jest.fn() };
  const { token, hash, prefix } = apiTokenCodec.generate();
  const record = await apiTokenRepository.create({ userId: owner.id, name: 'Laptop', tokenHash: hash, prefix, createdAt: new Date(NOW.getTime() - DAY_MS), expiresAt });
  if (revoked) {
    await apiTokenRepository.revoke({ userId: owner.id, id: record.id, reason: 'user', at: NOW });
  }
  const useCase = new ResolveApiToken({ apiTokenRepository, apiTokenCodec, userRepository, logger, now: () => NOW });
  return { owner, token, record, userRepository, apiTokenRepository, apiTokenCodec, logger, useCase };
}

describe('ResolveApiToken', () => {
  it('resolves a valid token into the same user shape as the session, plus tokenId and prefix', async () => {
    const ctx = await setup(staffUser({ mustChangePassword: true }));

    const result = await ctx.useCase.execute({ token: ctx.token });

    expect(result).toEqual({
      ok: true,
      data: {
        user: {
          id: ctx.owner.id,
          name: ctx.owner.name,
          email: ctx.owner.email,
          accountType: 'smarteam',
          role: null,
          tenantKey: null,
          permissions: expect.arrayContaining(['staff.tickets']),
        },
        mustChangePassword: true,
        tokenId: ctx.record.id,
        prefix: ctx.token.slice(0, 8),
      },
    });
  });

  it('touches lastUsedAt without awaiting it', async () => {
    const ctx = await setup();
    const touch = jest.spyOn(ctx.apiTokenRepository, 'touchLastUsed');

    await ctx.useCase.execute({ token: ctx.token });

    expect(touch).toHaveBeenCalledWith(ctx.record.id, NOW);
    expect(ctx.apiTokenRepository.records[0].lastUsedAt).toEqual(NOW);
  });

  it('still answers when touchLastUsed fails and logs without the token', async () => {
    const ctx = await setup();
    ctx.apiTokenRepository.failNextTouch = true;

    const result = await ctx.useCase.execute({ token: ctx.token });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.ok).toBe(true);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain(ctx.token);
  });

  it.each([
    ['an uppercase SPN_ prefix', (token) => `SPN_${token.slice(4)}`],
    ['42 characters after spn_', (token) => token.slice(0, -1)],
    ['44 characters after spn_', (token) => `${token}A`],
    ['a padding =', (token) => `${token.slice(0, -1)}=`],
    ['a +', (token) => `${token.slice(0, -1)}+`],
    ['a /', (token) => `${token.slice(0, -1)}/`],
    ['surrounding spaces', (token) => ` ${token}`],
    ['an empty string', () => ''],
    ['no token', () => undefined],
    ['a non-string', () => 12345],
  ])('rejects %s without hashing or querying the repository', async (_label, mutate) => {
    const ctx = await setup();
    const findByHash = jest.spyOn(ctx.apiTokenRepository, 'findByHash');
    const hash = jest.spyOn(ctx.apiTokenCodec, 'hash');

    const result = await ctx.useCase.execute({ token: mutate(ctx.token) });

    expect(result).toEqual(INVALID);
    expect(findByHash).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects a well-formed unknown token', async () => {
    const ctx = await setup();

    expect(await ctx.useCase.execute({ token: `spn_${'Z'.repeat(43)}` })).toEqual(INVALID);
  });

  it('rejects a revoked token', async () => {
    const ctx = await setup(staffUser(), { revoked: true });

    expect(await ctx.useCase.execute({ token: ctx.token })).toEqual(INVALID);
  });

  it('rejects an expired token (expiresAt not after now)', async () => {
    const ctx = await setup(staffUser(), { expiresAt: NOW });

    expect(await ctx.useCase.execute({ token: ctx.token })).toEqual(INVALID);
  });

  it('rejects the token of an inactive user and does not touch lastUsedAt', async () => {
    const ctx = await setup(staffUser({ active: false }));
    const touch = jest.spyOn(ctx.apiTokenRepository, 'touchLastUsed');

    expect(await ctx.useCase.execute({ token: ctx.token })).toEqual(INVALID);
    expect(touch).not.toHaveBeenCalled();
  });

  it('rejects the token of a client account', async () => {
    const ctx = await setup(clientUser());

    expect(await ctx.useCase.execute({ token: ctx.token })).toEqual(INVALID);
  });

  it('rejects the token of a deleted user', async () => {
    const ctx = await setup();
    ctx.userRepository.users = [];

    expect(await ctx.useCase.execute({ token: ctx.token })).toEqual(INVALID);
  });
});
