import crypto from 'crypto';

const HEADER = Object.freeze({ alg: 'HS256', typ: 'JWT' });
const ENCODED_HEADER = Buffer.from(JSON.stringify(HEADER)).toString('base64url');
// Id de sesión: 16 bytes aleatorios en base64url (22 caracteres). El logout revoca este id.
const SESSION_ID_BYTES = 16;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function decodeJson(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// JWT HS256 de la sesión del panel. Usa su propio secreto (PANEL_JWT_SECRET), distinto del
// JWT_SECRET que acepta tenantResolver, y a diferencia de aquel verifica el header: un token
// con alg "none" u otro algoritmo no pasa.
export class HmacSessionToken {
  constructor({ secret, ttlSeconds = 28800, now = () => Date.now() } = {}) {
    if (!secret) {
      throw new Error('HmacSessionToken requires a secret');
    }

    this.secret = secret;
    this.ttlSeconds = ttlSeconds;
    this.now = now;
  }

  sign({ sub, tv, pwdChange }) {
    const iat = Math.floor(this.now() / 1000);
    const payload = {
      sub: String(sub),
      sid: crypto.randomBytes(SESSION_ID_BYTES).toString('base64url'),
      tv: Number(tv),
      pwdChange: Boolean(pwdChange),
      iat,
      exp: iat + this.ttlSeconds,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = `${ENCODED_HEADER}.${encodedPayload}`;
    return `${data}.${sign(data, this.secret)}`;
  }

  verify(token) {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const header = decodeJson(encodedHeader);
    if (
      !header
      || header.alg !== HEADER.alg
      || header.typ !== HEADER.typ
      || Object.keys(header).length !== 2
    ) {
      return null;
    }

    if (!safeEqual(signature, sign(`${encodedHeader}.${encodedPayload}`, this.secret))) {
      return null;
    }

    const payload = decodeJson(encodedPayload);
    if (
      !payload
      || typeof payload.sub !== 'string'
      || typeof payload.sid !== 'string'
      || !SESSION_ID_PATTERN.test(payload.sid)
      || !Number.isInteger(payload.tv)
      || !Number.isFinite(payload.exp)
    ) {
      return null;
    }

    if (Math.floor(this.now() / 1000) >= payload.exp) {
      return null;
    }

    return payload;
  }
}

export default HmacSessionToken;
