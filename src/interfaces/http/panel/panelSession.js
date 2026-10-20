import { sendPanelError } from './panelErrors.js';
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

// Hook onRequest de todo /panel/api, en este orden:
//   0. IP del cliente en req.panelClientIp (X-Forwarded-For solo a través de proxies de confianza).
//   1. CSRF: toda mutación exige X-Panel-Request: 1 (además de SameSite=Strict).
//   2. Sesión: salvo las rutas con config.panelPublic (login y logout).
//   3. Cambio de contraseña pendiente: solo pasan las rutas con config.allowPendingPasswordChange.
export function createPanelRequestGuard({ resolveSession, cookie, proxyMatcher = null }) {
  return async function panelRequestGuard(req, reply) {
    req.panelClientIp = resolveClientIp({
      socketAddress: req.socket?.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
      matcher: proxyMatcher,
    });
    req.panelClientIpKey = rateLimitKeyForIp(req.panelClientIp);

    if (MUTATING_METHODS.has(req.method) && req.headers['x-panel-request'] !== '1') {
      return sendPanelError(reply, 403, 'missing_panel_header');
    }

    const config = req.routeOptions?.config ?? {};
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
