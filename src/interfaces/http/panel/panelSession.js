import { sendInvalidToken, sendPanelError } from './panelErrors.js';
import { rateLimitKeyForIp, resolveClientIp } from './clientIp.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const SESSION_COOKIE_NAME = 'panel_session';

function cookieOptions({ cookiePath, cookieSecure }) {
  return {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: cookiePath,
  };
}

export function setSessionCookie(reply, token, { cookiePath, cookieSecure, sessionTtlSeconds }) {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    ...cookieOptions({ cookiePath, cookieSecure }),
    maxAge: sessionTtlSeconds,
  });
}

export function clearSessionCookie(reply, { cookiePath, cookieSecure }) {
  reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions({ cookiePath, cookieSecure }));
}

// Cómo se autenticó el request (contrato 12): lo usa el registro de trabajo para la auditoría y
// la idempotencia. Con cookie no hay token.
const SESSION_AUTH = Object.freeze({ via: 'session', tokenId: null, prefix: null });

// `<esquema> <token>` separados por espacios, tras recortar.
const AUTHORIZATION_PATTERN = /^(\S+)\s+(\S+)$/;
const BEARER_SCHEME = 'bearer';

// Límites de M7. El de la IP cuenta tokens inválidos (ventana de 15 min); el del token, pedidos
// con un token válido (ventana de 1 min).
const INVALID_TOKEN_IP_RETRY_AFTER_SECONDS = 15 * 60;
const INVALID_TOKEN_IP_MESSAGE = 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.';
const TOKEN_LIMIT_RETRY_AFTER_SECONDS = 60;
const TOKEN_LIMIT_MESSAGE = 'Demasiados pedidos con este token. Espera un minuto.';

function sendTooManyAttempts(reply, retryAfterSeconds, message) {
  reply.header('Retry-After', String(retryAfterSeconds));
  return sendPanelError(reply, 429, 'too_many_attempts', message);
}

// Token del header Authorization, o null si no es `Bearer <algo>` (el esquema sin distinguir
// mayúsculas, RFC 7235). El formato del token lo comprueba ResolveApiToken sin ir a la base.
function bearerTokenFrom(authorization) {
  if (typeof authorization !== 'string') {
    return null;
  }
  const match = AUTHORIZATION_PATTERN.exec(authorization.trim());
  if (!match || match[1].toLowerCase() !== BEARER_SCHEME) {
    return null;
  }
  return match[2];
}

// Hook onRequest de todo /panel/api, en este orden:
//   0. IP del cliente en req.panelClientIp (X-Forwarded-For solo a través de proxies de confianza).
//   1. Token personal: solo en rutas con config.panelTokenAuth y header Authorization (contrato
//      12, M3). Manda el token aunque sea inválido: no se mira la cookie ni se exige
//      X-Panel-Request (un Bearer lo pone el cliente a mano, no hay CSRF posible). Con la IP
//      bloqueada por tokens inválidos (M7) se responde 429 antes de resolver el token.
//   2. CSRF: toda mutación exige X-Panel-Request: 1 (además de SameSite=Strict).
//   3. Sesión: salvo las rutas con config.panelPublic (login y logout).
//   4. Cambio de contraseña pendiente: solo pasan las rutas con config.allowPendingPasswordChange.
// En el resto de las rutas el header Authorization se ignora por completo.
export function createPanelRequestGuard({
  resolveSession,
  cookie,
  proxyMatcher = null,
  resolveApiToken = null,
  tokenAttempts = null,
  invalidTokenIpAttempts = null,
}) {
  // Sin IP utilizable (clave null o vacía) no se usa el límite por IP, como en el login: si no,
  // todos esos clientes compartirían un mismo contador.
  function ipLimitKey(req) {
    return invalidTokenIpAttempts && req.panelClientIpKey ? req.panelClientIpKey : null;
  }

  async function rejectInvalidToken(req, reply) {
    const ipKey = ipLimitKey(req);
    if (ipKey) {
      const limit = await invalidTokenIpAttempts.consume(ipKey);
      if (limit.blocked) {
        return sendTooManyAttempts(reply, INVALID_TOKEN_IP_RETRY_AFTER_SECONDS, INVALID_TOKEN_IP_MESSAGE);
      }
    }
    return sendInvalidToken(reply);
  }

  async function authenticateWithToken(req, reply, config) {
    // IP ya bloqueada por tokens inválidos: 429 antes de resolver el token, sin ir a la base y
    // sin sumar al contador. isBlocked es opcional (un limitador sin él solo cuenta al fallar).
    const ipKey = ipLimitKey(req);
    if (ipKey && typeof invalidTokenIpAttempts.isBlocked === 'function'
      && await invalidTokenIpAttempts.isBlocked(ipKey)) {
      return sendTooManyAttempts(reply, INVALID_TOKEN_IP_RETRY_AFTER_SECONDS, INVALID_TOKEN_IP_MESSAGE);
    }

    const token = bearerTokenFrom(req.headers.authorization);
    // Sin esquema Bearer no se llama al caso de uso: nada llega a la base.
    const result = token === null ? null : await resolveApiToken.execute({ token });
    if (!result?.ok) {
      return rejectInvalidToken(req, reply);
    }

    const { user, mustChangePassword, tokenId, prefix } = result.data;
    if (tokenAttempts) {
      const limit = await tokenAttempts.consume(tokenId);
      if (limit.blocked) {
        return sendTooManyAttempts(reply, TOKEN_LIMIT_RETRY_AFTER_SECONDS, TOKEN_LIMIT_MESSAGE);
      }
    }

    req.panelUser = user;
    req.panelMustChangePassword = mustChangePassword;
    req.panelAuth = { via: 'token', tokenId, prefix: prefix ?? null };

    if (req.panelMustChangePassword && !config.allowPendingPasswordChange) {
      return sendPanelError(reply, 403, 'password_change_required');
    }
    return undefined;
  }

  return async function panelRequestGuard(req, reply) {
    req.panelClientIp = resolveClientIp({
      socketAddress: req.socket?.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
      matcher: proxyMatcher,
    });
    req.panelClientIpKey = rateLimitKeyForIp(req.panelClientIp);

    // Se lee antes del CSRF: las rutas con token no lo exigen cuando viene Authorization.
    const config = req.routeOptions?.config ?? {};
    if (config.panelTokenAuth === true && resolveApiToken && req.headers.authorization !== undefined) {
      return authenticateWithToken(req, reply, config);
    }

    if (MUTATING_METHODS.has(req.method) && req.headers['x-panel-request'] !== '1') {
      return sendPanelError(reply, 403, 'missing_panel_header');
    }

    if (config.panelPublic) {
      return undefined;
    }

    const token = req.cookies?.[SESSION_COOKIE_NAME];
    const result = await resolveSession.execute({ token });
    if (!result.ok) {
      if (token) {
        clearSessionCookie(reply, cookie);
      }
      return sendPanelError(reply, 401, 'unauthorized');
    }

    req.panelUser = result.data.user;
    req.panelMustChangePassword = result.data.mustChangePassword;
    req.panelAuth = SESSION_AUTH;

    if (req.panelMustChangePassword && !config.allowPendingPasswordChange) {
      return sendPanelError(reply, 403, 'password_change_required');
    }

    return undefined;
  };
}

// Las rutas se protegen por permiso, no por nombre de rol.
export function requirePermission(permission) {
  return requireAnyPermission([permission]);
}

export function requireAnyPermission(permissions) {
  return async function panelPermissionGuard(req, reply) {
    const granted = req.panelUser?.permissions ?? [];
    if (!permissions.some((permission) => granted.includes(permission))) {
      return sendPanelError(reply, 403, 'forbidden');
    }
    return undefined;
  };
}

// Rutas de cliente (eventos y syncs de su empresa): la cuenta debe tener tenant. Una cuenta de
// Smarteam no tiene y recibe 403: para ver una empresa usa /staff/tenants/:tenantKey/....
export async function requireClientAccount(req, reply) {
  const user = req.panelUser;
  if (!user || user.accountType !== 'cliente' || !user.tenantKey) {
    return sendPanelError(reply, 403, 'forbidden');
  }
  return undefined;
}

// Rutas /staff/...: solo cuentas de Smarteam, aunque una cuenta cliente tenga el permiso.
export async function requireStaffAccount(req, reply) {
  if (req.panelUser?.accountType !== 'smarteam') {
    return sendPanelError(reply, 403, 'forbidden');
  }
  return undefined;
}
