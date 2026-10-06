import { buildOAuthState, parseOAuthState } from '../../../src/application/services/oauth-state.service.js';

const SECRET = 'state-secret-test';
const NOW = 1_800_000_000_000;

function base64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

describe('oauth-state.service', () => {
  const payload = { clientConfigId: 'cfg-1', tenantKey: 'printer', portalId: '50082681' };

  it('round-trips a signed state with the same secret', () => {
    const state = buildOAuthState(payload, { secret: SECRET, now: NOW });

    expect(parseOAuthState(state, { secret: SECRET, now: NOW })).toEqual(payload);
  });

  it('rejects the legacy unsigned base64 JSON state', () => {
    const legacy = base64Url(JSON.stringify({ clientConfigId: 'cfg-1', tenantKey: 'printer' }));

    expect(parseOAuthState(legacy, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects a state whose payload was swapped for another tenant', () => {
    const state = buildOAuthState(payload, { secret: SECRET, now: NOW });
    const [, signature] = state.split('.');
    const forgedBody = base64Url(JSON.stringify({ ...payload, tenantKey: 'victim', exp: NOW + 60_000 }));

    expect(parseOAuthState(`${forgedBody}.${signature}`, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects a state signed with a different secret', () => {
    const state = buildOAuthState(payload, { secret: 'other-secret', now: NOW });

    expect(parseOAuthState(state, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects a state once it has expired', () => {
    const state = buildOAuthState(payload, { secret: SECRET, now: NOW, ttlSeconds: 900 });

    expect(parseOAuthState(state, { secret: SECRET, now: NOW + 901_000 })).toBeNull();
  });

  it('refuses to build a state without a secret', () => {
    expect(() => buildOAuthState(payload, { secret: '' })).toThrow('OAuth state secret is required');
  });

  it('refuses to parse when no secret is configured', () => {
    const state = buildOAuthState(payload, { secret: SECRET, now: NOW });

    expect(parseOAuthState(state, { secret: undefined, now: NOW })).toBeNull();
  });
});
