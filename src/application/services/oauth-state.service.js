import crypto from 'crypto';

// El `state` de OAuth viaja por el navegador del que instala y vuelve al callback, que decide
// con él en qué tenant guardar los tokens. Sin firma, cualquiera que instalara la app en su
// propio portal podía reescribirlo con el tenantKey de otro cliente y quedarse con su sync.
// Por eso va firmado con HMAC y con vencimiento: el callback solo acepta lo que emitió el init.
const DEFAULT_TTL_SECONDS = 15 * 60;

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sign(body, secret) {
  return base64UrlEncode(crypto.createHmac('sha256', secret).update(body).digest());
}

function signaturesMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function buildOAuthState(payload, { secret, now = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!secret) {
    throw new Error('OAuth state secret is required');
  }

  const body = base64UrlEncode(Buffer.from(JSON.stringify({
    ...payload,
    exp: now + ttlSeconds * 1000,
  }), 'utf8'));

  return `${body}.${sign(body, secret)}`;
}

// Devuelve null ante cualquier state que no sea válido (sin firma, adulterado, vencido o sin
// secret configurado): el callback lo trata como request inválido y no toca ningún tenant.
export function parseOAuthState(state, { secret, now = Date.now() } = {}) {
  if (!secret || typeof state !== 'string') {
    return null;
  }

  const [body, signature, ...rest] = state.split('.');
  if (!body || !signature || rest.length > 0) {
    return null;
  }

  if (!signaturesMatch(signature, sign(body, secret))) {
    return null;
  }

  try {
    const { exp, ...payload } = JSON.parse(base64UrlDecode(body));
    if (typeof exp !== 'number' || now >= exp) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}
