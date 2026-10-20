// Acciones del registro de auditoría del panel (colección PanelAuditLogs en la master).
export const AUDIT_ACTIONS = Object.freeze({
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  USER_PASSWORD_RESET: 'user.password_reset',
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  LOGIN_FAILED: 'auth.login_failed',
  LOGIN_BLOCKED: 'auth.login_blocked',
  PASSWORD_CHANGED: 'auth.password_changed',
  LOGOUT: 'auth.logout',
});

export const AUDIT_SOURCES = Object.freeze({
  PANEL: 'panel',
  SCRIPT: 'script',
});

// Los eventos de acceso (auth.*) se borran solos a los 180 días; los de usuarios se conservan.
export const AUTH_EVENT_RETENTION_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export function auditExpiresAt(action, at) {
  if (!String(action).startsWith('auth.')) {
    return null;
  }

  return new Date(at.getTime() + AUTH_EVENT_RETENTION_DAYS * DAY_MS);
}

// Claves de `details` permitidas por acción. Todo lo demás se descarta: así una contraseña,
// una temporal o un token no tienen por dónde entrar al registro.
export const AUDIT_DETAIL_KEYS = Object.freeze({
  [AUDIT_ACTIONS.USER_CREATED]: Object.freeze(['accountType', 'role']),
  [AUDIT_ACTIONS.USER_UPDATED]: Object.freeze(['changes']),
  [AUDIT_ACTIONS.LOGIN_FAILED]: Object.freeze(['reason']),
  [AUDIT_ACTIONS.LOGIN_BLOCKED]: Object.freeze(['reason']),
});
