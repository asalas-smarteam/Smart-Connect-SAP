import { jest } from '@jest/globals';
import ScryptPasswordHasher from '../../../src/infrastructure/auth/ScryptPasswordHasher.js';
import HmacSessionToken from '../../../src/infrastructure/auth/HmacSessionToken.js';
import RedisLoginAttempts from '../../../src/infrastructure/auth/RedisLoginAttempts.js';
import RandomTemporaryPassword, {
  TEMPORARY_PASSWORD_ALPHABET,
} from '../../../src/infrastructure/auth/RandomTemporaryPassword.js';

const SECRET = 'panel-test-secret';

function b64(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function forge(header, payload, secret = SECRET) {
  const crypto = globalThis.__panelCrypto;
  const data = `${b64(header)}.${b64(payload)}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

beforeAll(async () => {
  globalThis.__panelCrypto = (await import('crypto')).default;
});

describe('ScryptPasswordHasher', () => {
  const hasher = new ScryptPasswordHasher();

  it('hashes without leaking the password and verifies it', async () => {
    const stored = await hasher.hash('una-clave-larga');

    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    expect(stored).not.toContain('una-clave-larga');
    await expect(hasher.verify('una-clave-larga', stored)).resolves.toBe(true);
    await expect(hasher.verify('otra-clave-larga', stored)).resolves.toBe(false);
  });

  it('uses a random salt per hash', async () => {
    const [first, second] = await Promise.all([hasher.hash('misma-clave'), hasher.hash('misma-clave')]);

    expect(first).not.toBe(second);
  });

  it.each([
    ['an empty value', ''],
    ['another algorithm', 'bcrypt$10$abc'],
    ['tampered parameters', 'scrypt$2$8$1$AAAA$BBBB'],
    ['null', null],
  ])('returns false for %s', async (_label, stored) => {
    await expect(hasher.verify('una-clave-larga', stored)).resolves.toBe(false);
  });

  it('does the dummy comparison and never matches', async () => {
    await expect(hasher.verifyDummy('cualquier-cosa')).resolves.toBe(false);
    await expect(hasher.verifyDummy(undefined)).resolves.toBe(false);
  });
});

describe('HmacSessionToken', () => {
  const NOW = Date.parse('2026-10-13T12:00:00.000Z');

  function tokenService(now = NOW) {
    return new HmacSessionToken({ secret: SECRET, now: () => now });
  }

  it('requires a secret', () => {
    expect(() => new HmacSessionToken({ secret: '' })).toThrow('requires a secret');
  });

  it('signs and verifies a session payload that lasts 8 hours', () => {
    const service = tokenService();
    const token = service.sign({ sub: 'u1', tv: 3, pwdChange: true });
    const payload = service.verify(token);

    expect(payload).toEqual({
      sub: 'u1',
      sid: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      tv: 3,
      pwdChange: true,
      iat: NOW / 1000,
      exp: NOW / 1000 + 28800,
    });
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('gives every session its own sid', () => {
    const service = tokenService();
    const first = service.verify(service.sign({ sub: 'u1', tv: 0 }));
    const second = service.verify(service.sign({ sub: 'u1', tv: 0 }));

    expect(first.sid).not.toBe(second.sid);
  });

  it.each([
    ['without sid', { sub: 'u1', tv: 0 }],
    ['with a malformed sid', { sub: 'u1', tv: 0, sid: 'corto' }],
  ])('rejects a correctly signed token %s', (_label, base) => {
    const token = forge({ alg: 'HS256', typ: 'JWT' }, { ...base, exp: NOW / 1000 + 100 });

    expect(tokenService().verify(token)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = tokenService().sign({ sub: 'u1', tv: 0, pwdChange: false });

    expect(tokenService(NOW + 28800 * 1000).verify(token)).toBeNull();
    expect(tokenService(NOW + 28799 * 1000).verify(token)).not.toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const token = new HmacSessionToken({ secret: 'otro', now: () => NOW }).sign({ sub: 'u1', tv: 0 });

    expect(tokenService().verify(token)).toBeNull();
  });

  it('rejects an altered payload', () => {
    const token = tokenService().sign({ sub: 'u1', tv: 0, pwdChange: false });
    const [header, , signature] = token.split('.');
    const altered = `${header}.${b64({ sub: 'u2', tv: 0, exp: NOW / 1000 + 100 })}.${signature}`;

    expect(tokenService().verify(altered)).toBeNull();
  });

  it.each([
    ['alg none', { alg: 'none', typ: 'JWT' }],
    ['HS512', { alg: 'HS512', typ: 'JWT' }],
    ['no typ', { alg: 'HS256' }],
    ['extra header fields', { alg: 'HS256', typ: 'JWT', kid: 'x' }],
  ])('rejects a token with %s even if correctly signed', (_label, header) => {
    const token = forge(header, { sub: 'u1', tv: 0, exp: NOW / 1000 + 100 });

    expect(tokenService().verify(token)).toBeNull();
  });

  it.each([
    ['without tv', { sub: 'u1', exp: NOW / 1000 + 100 }],
    ['without sub', { tv: 0, exp: NOW / 1000 + 100 }],
    ['without exp', { sub: 'u1', tv: 0 }],
  ])('rejects a payload %s', (_label, payload) => {
    expect(tokenService().verify(forge({ alg: 'HS256', typ: 'JWT' }, payload))).toBeNull();
  });

  it.each([undefined, '', 'a.b', 'a.b.c.d', 'no-es-un-token'])('rejects malformed input %p', (token) => {
    expect(tokenService().verify(token)).toBeNull();
  });
});

describe('RedisLoginAttempts', () => {
  // Emula el script atómico INCR + EXPIRE de Redis.
  function fakeRedis() {
    const store = new Map();
    const ttl = new Map();
    return {
      store,
      ttl,
      eval: jest.fn(async (script, { keys: [key], arguments: [window] }) => {
        const value = (store.get(key) ?? 0) + 1;
        store.set(key, value);
        if (!ttl.has(key)) {
          ttl.set(key, Number(window));
        }
        return value;
      }),
      del: jest.fn(async (key) => {
        ttl.delete(key);
        return store.delete(key);
      }),
    };
  }

  function quietLogger() {
    return { warn: jest.fn() };
  }

  async function consumeTimes(attempts, email, times) {
    const results = [];
    for (let index = 0; index < times; index += 1) {
      results.push(await attempts.consume(email));
    }
    return results;
  }

  it('blocks from the sixth attempt and keys by a hash of the normalized email', async () => {
    const redis = fakeRedis();
    const attempts = new RedisLoginAttempts({ getClient: async () => redis, logger: quietLogger() });

    const results = await consumeTimes(attempts, 'Ana@Acme.test', 5);
    const sixth = await attempts.consume(' ANA@acme.TEST ');

    expect(results.every((result) => result.blocked === false)).toBe(true);
    expect(sixth).toEqual({ blocked: true, firstBlocked: true });
    await expect(attempts.consume('ana@acme.test')).resolves.toEqual({ blocked: true, firstBlocked: false });
    const [key] = [...redis.store.keys()];
    expect(key).toMatch(/^panel:login:fail:[0-9a-f]{64}$/);
    expect(key).not.toContain('ana');
    expect(redis.ttl.get(key)).toBe(900);
  });

  it('uses its own key prefix and limit when reused per IP', async () => {
    const redis = fakeRedis();
    const attempts = new RedisLoginAttempts({
      getClient: async () => redis,
      logger: quietLogger(),
      keyPrefix: 'panel:login:ip:',
      maxAttempts: 30,
    });

    const results = await consumeTimes(attempts, '203.0.113.7', 31);

    expect(results.filter((result) => result.blocked)).toHaveLength(1);
    const [key] = [...redis.store.keys()];
    expect(key).toMatch(/^panel:login:ip:[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.7');
  });

  it('counts parallel attempts atomically: a burst cannot slip past the limit', async () => {
    const redis = fakeRedis();
    const attempts = new RedisLoginAttempts({ getClient: async () => redis, logger: quietLogger() });

    const results = await Promise.all(Array.from({ length: 50 }, () => attempts.consume('ana@acme.test')));

    expect(results.filter((result) => !result.blocked)).toHaveLength(5);
  });

  it('sends INCR and EXPIRE in a single script that also repairs a key without TTL', async () => {
    const redis = fakeRedis();
    const attempts = new RedisLoginAttempts({ getClient: async () => redis, logger: quietLogger() });

    await attempts.consume('ana@acme.test');

    const [script, options] = redis.eval.mock.calls[0];
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("redis.call('TTL', KEYS[1]) < 0");
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ARGV[1])");
    expect(options.arguments).toEqual(['900']);
  });

  it('unblocks on reset', async () => {
    const redis = fakeRedis();
    const attempts = new RedisLoginAttempts({ getClient: async () => redis, logger: quietLogger() });

    await consumeTimes(attempts, 'ana@acme.test', 6);
    await attempts.reset('ana@acme.test');

    await expect(attempts.consume('ana@acme.test')).resolves.toEqual(expect.objectContaining({ blocked: false }));
  });

  it('falls back to an in-memory counter when Redis throws', async () => {
    const logger = quietLogger();
    const attempts = new RedisLoginAttempts({
      getClient: async () => { throw new Error('ECONNREFUSED'); },
      logger,
    });

    await consumeTimes(attempts, 'ana@acme.test', 5);

    await expect(attempts.consume('ana@acme.test')).resolves.toEqual(expect.objectContaining({ blocked: true }));
    await expect(attempts.consume('otra@acme.test')).resolves.toEqual(expect.objectContaining({ blocked: false }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('ana@acme.test');
  });

  it('does not hang when Redis never answers', async () => {
    const attempts = new RedisLoginAttempts({
      getClient: () => new Promise(() => {}),
      logger: quietLogger(),
      timeoutMs: 50,
    });

    const started = Date.now();
    await expect(attempts.consume('ana@acme.test')).resolves.toEqual(expect.objectContaining({ blocked: false }));
    await attempts.reset('ana@acme.test');

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('times out a command that hangs on a connected client', async () => {
    const redis = { eval: () => new Promise(() => {}), del: jest.fn() };
    const attempts = new RedisLoginAttempts({ getClient: async () => redis, logger: quietLogger(), timeoutMs: 50 });

    await expect(attempts.consume('ana@acme.test')).resolves.toEqual(expect.objectContaining({ blocked: false }));
  });

  it('retries Redis after the cool-down and forgets expired memory entries', async () => {
    let now = 0;
    let redisDown = true;
    const redis = fakeRedis();
    const attempts = new RedisLoginAttempts({
      getClient: async () => {
        if (redisDown) {
          throw new Error('down');
        }
        return redis;
      },
      logger: quietLogger(),
      now: () => now,
    });

    await consumeTimes(attempts, 'ana@acme.test', 5);
    await expect(attempts.consume('ana@acme.test')).resolves.toEqual(expect.objectContaining({ blocked: true }));

    now += 15 * 60 * 1000;
    await expect(attempts.consume('ana@acme.test')).resolves.toEqual(expect.objectContaining({ blocked: false }));

    redisDown = false;
    await attempts.consume('ana@acme.test');
    expect(redis.eval).not.toHaveBeenCalled();

    now += 30 * 1000;
    await attempts.consume('ana@acme.test');
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
});

describe('RandomTemporaryPassword', () => {
  it('generates 14 characters from an alphabet without ambiguous characters', () => {
    const generator = new RandomTemporaryPassword();
    const passwords = Array.from({ length: 50 }, () => generator.generate());

    passwords.forEach((password) => {
      expect(password).toHaveLength(14);
      [...password].forEach((character) => expect(TEMPORARY_PASSWORD_ALPHABET).toContain(character));
    });
    expect(TEMPORARY_PASSWORD_ALPHABET).not.toMatch(/[0O1lI]/);
    expect(new Set(passwords).size).toBe(passwords.length);
  });
});
