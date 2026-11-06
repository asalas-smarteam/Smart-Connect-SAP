import {
  API_TOKEN_DISPLAY_PREFIX_LENGTH,
  API_TOKEN_NAME_MAX,
  API_TOKEN_PREFIX,
  API_TOKEN_REVOKE_REASONS,
  API_TOKEN_TTL_DAYS,
  MAX_ACTIVE_API_TOKENS,
  apiTokenExpiresAt,
  apiTokenPurgeAt,
  checkApiTokenName,
  checkCurrentPassword,
  isActiveToken,
  isApiTokenFormat,
} from '../../../src/domain/panel/apiTokens.js';

const VALID_TOKEN = 'spn_a1b2PS_CSLc3PsRJ0AuX9eCvOmSePN2v3yW4sWhVHYw';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('api token constants', () => {
  it('match the contract', () => {
    expect(API_TOKEN_PREFIX).toBe('spn_');
    expect(API_TOKEN_TTL_DAYS).toBe(90);
    expect(MAX_ACTIVE_API_TOKENS).toBe(5);
    expect(API_TOKEN_NAME_MAX).toBe(60);
    expect(API_TOKEN_DISPLAY_PREFIX_LENGTH).toBe(8);
    expect(Object.values(API_TOKEN_REVOKE_REASONS)).toEqual(['user', 'user_deactivated', 'password_reset']);
  });
});

describe('isApiTokenFormat', () => {
  it('accepts spn_ + 43 base64url characters (47 in total)', () => {
    expect(VALID_TOKEN).toHaveLength(47);
    expect(isApiTokenFormat(VALID_TOKEN)).toBe(true);
    expect(isApiTokenFormat(`spn_${'-_'.repeat(21)}A`)).toBe(true);
  });

  it.each([
    ['46 characters', VALID_TOKEN.slice(0, 46)],
    ['48 characters', `${VALID_TOKEN}A`],
    ['padding =', `${VALID_TOKEN.slice(0, 46)}=`],
    ['+', `${VALID_TOKEN.slice(0, 46)}+`],
    ['/', `${VALID_TOKEN.slice(0, 46)}/`],
    ['uppercase prefix', `SPN_${VALID_TOKEN.slice(4)}`],
    ['inner space', `${VALID_TOKEN.slice(0, 20)} ${VALID_TOKEN.slice(21)}`],
    ['trailing space', `${VALID_TOKEN} `],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isApiTokenFormat(value)).toBe(false);
  });

  it.each([undefined, null, 47, {}])('rejects non strings (%p)', (value) => {
    expect(isApiTokenFormat(value)).toBe(false);
  });
});

describe('isActiveToken', () => {
  const now = new Date('2026-11-04T15:00:00.000Z');

  it('is active when not revoked and not expired', () => {
    expect(isActiveToken({ revokedAt: null, expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
  });

  it('is not active when revoked', () => {
    expect(isActiveToken({ revokedAt: now, expiresAt: new Date(now.getTime() + DAY_MS) }, now)).toBe(false);
  });

  it('is not active at or after expiresAt', () => {
    expect(isActiveToken({ revokedAt: null, expiresAt: now }, now)).toBe(false);
    expect(isActiveToken({ revokedAt: null, expiresAt: new Date(now.getTime() - 1) }, now)).toBe(false);
  });

  it('is not active without a token', () => {
    expect(isActiveToken(null, now)).toBe(false);
  });
});

describe('checkApiTokenName', () => {
  it('trims and accepts 1 to 60 characters', () => {
    expect(checkApiTokenName('  Claude Code - laptop  ')).toEqual({ ok: true, name: 'Claude Code - laptop' });
    expect(checkApiTokenName('a'.repeat(60))).toEqual({ ok: true, name: 'a'.repeat(60) });
  });

  it.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['61 characters', 'a'.repeat(61)],
    ['not text', 42],
    ['missing', undefined],
  ])('rejects %s by length', (_label, value) => {
    expect(checkApiTokenName(value)).toEqual({
      ok: false,
      message: 'El nombre debe tener entre 1 y 60 caracteres.',
    });
  });

  it.each([
    ['line break', 'Claude\nCode'],
    ['line break at the end', 'Claude Code\n'],
    ['tab', 'Claude\tCode'],
    ['null char', 'Claude\u0000Code'],
  ])('rejects (does not clean) a name with a %s', (_label, value) => {
    expect(checkApiTokenName(value)).toEqual({
      ok: false,
      message: 'El nombre no puede tener saltos de línea ni caracteres especiales.',
    });
  });
});

describe('checkCurrentPassword', () => {
  it('accepts any non empty text as is', () => {
    expect(checkCurrentPassword(' secreta ')).toEqual({ ok: true, password: ' secreta ' });
  });

  it.each([undefined, null, '', 123])('rejects %p', (value) => {
    expect(checkCurrentPassword(value)).toEqual({ ok: false, message: 'Escribe tu contraseña actual.' });
  });
});

describe('dates', () => {
  const createdAt = new Date('2026-11-04T15:00:00.000Z');

  it('expires 90 days after creation', () => {
    expect(apiTokenExpiresAt(createdAt).toISOString()).toBe('2027-02-02T15:00:00.000Z');
  });

  it('purges 30 days after the given date', () => {
    expect(apiTokenPurgeAt(createdAt).getTime() - createdAt.getTime()).toBe(30 * DAY_MS);
  });
});
