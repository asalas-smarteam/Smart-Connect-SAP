import LogoutPanelSession from '../../../../src/application/use-cases/panel/LogoutPanelSession.js';
import ResolvePanelSession from '../../../../src/application/use-cases/panel/ResolvePanelSession.js';
import {
  FakeRevokedSessions,
  FakeSessionToken,
  InMemoryPanelUserRepository,
  RecordingAuditLog,
  clientUser,
} from './panelFakes.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');

function setup(users = []) {
  const sessionToken = new FakeSessionToken();
  const revokedSessions = new FakeRevokedSessions();
  const auditLog = new RecordingAuditLog();
  const userRepository = new InMemoryPanelUserRepository(users);
  return {
    sessionToken,
    revokedSessions,
    auditLog,
    logout: new LogoutPanelSession({ sessionToken, revokedSessions, auditLog, now: () => NOW }),
    resolve: new ResolvePanelSession({ userRepository, sessionToken, revokedSessions }),
  };
}

describe('LogoutPanelSession', () => {
  it('revokes only this session until the token expires, and audits it', async () => {
    const client = clientUser();
    const ctx = setup([client]);
    const first = ctx.sessionToken.sign({ sub: client.id, tv: 0 });
    const second = ctx.sessionToken.sign({ sub: client.id, tv: 0 });
    const { sid, exp } = ctx.sessionToken.verify(first);

    const result = await ctx.logout.execute({ token: first, ip: '203.0.113.7' });

    expect(result).toEqual({ ok: true, data: { revoked: true } });
    expect(ctx.revokedSessions.revoked.get(sid)).toEqual({ userId: client.id, expiresAt: new Date(exp * 1000) });
    expect((await ctx.resolve.execute({ token: first })).ok).toBe(false);
    expect((await ctx.resolve.execute({ token: second })).ok).toBe(true);
    expect(ctx.auditLog.entries).toEqual([expect.objectContaining({
      action: 'auth.logout',
      actor: expect.objectContaining({ userId: client.id }),
      ip: '203.0.113.7',
    })]);
    expect(JSON.stringify(ctx.auditLog.entries)).not.toContain(first);
  });

  it.each([
    ['no token', undefined],
    ['an invalid token', 'garbage'],
  ])('does nothing with %s', async (_label, token) => {
    const ctx = setup();

    await expect(ctx.logout.execute({ token })).resolves.toEqual({ ok: true, data: { revoked: false } });
    expect(ctx.revokedSessions.revoked.size).toBe(0);
    expect(ctx.auditLog.entries).toEqual([]);
  });

  it('does not audit a repeated logout with the same token', async () => {
    const client = clientUser();
    const ctx = setup([client]);
    const token = ctx.sessionToken.sign({ sub: client.id, tv: 0 });

    await ctx.logout.execute({ token });
    await ctx.logout.execute({ token });
    await ctx.logout.execute({ token });

    expect(ctx.auditLog.actions()).toEqual(['auth.logout']);
  });

  it('reports a failed revocation without throwing', async () => {
    const client = clientUser();
    const ctx = setup([client]);
    ctx.revokedSessions.revoke = async () => { throw new Error('master down'); };

    const result = await ctx.logout.execute({ token: ctx.sessionToken.sign({ sub: client.id, tv: 0 }) });

    expect(result).toEqual({ ok: true, data: { revoked: false, failed: true, error: 'master down' } });
  });
});

describe('ResolvePanelSession and session ids', () => {
  it('rejects a token without sid', async () => {
    const client = clientUser();
    const ctx = setup([client]);
    const withoutSid = `token:${JSON.stringify({ sub: client.id, tv: 0 })}`;

    await expect(ctx.resolve.execute({ token: withoutSid })).resolves.toEqual({ ok: false, reason: 'UNAUTHORIZED' });
  });
});
