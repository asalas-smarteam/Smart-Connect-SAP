import {
  AUDIT_DETAIL_KEYS,
  AUDIT_SOURCES,
  auditExpiresAt,
} from '#domain/panel/auditActions.js';

// Auditoría desactivada (para los casos de uso construidos sin ella, por ejemplo en tests).
export const NO_AUDIT_LOG = Object.freeze({
  async record() {},
});

function pickDetails(action, details) {
  const allowed = AUDIT_DETAIL_KEYS[action] ?? [];
  if (!details || allowed.length === 0) {
    return null;
  }

  const picked = Object.fromEntries(
    allowed.filter((key) => details[key] !== undefined).map((key) => [key, details[key]])
  );
  return Object.keys(picked).length > 0 ? picked : null;
}

// Quién hace la acción: un usuario de sesión ({ id, email, accountType }) o un usuario del
// repositorio. Nunca se copian otros campos (el hash de la contraseña vive en el mismo objeto).
// El puerto promete que record no lanza; igual se protege aquí: la auditoría nunca hace fallar
// la acción del usuario.
export async function recordAudit(auditLog, entry) {
  try {
    await auditLog.record(entry);
  } catch (error) {
    // El adaptador real ya loguea sus fallos; aquí solo se evita que suba.
  }
}

export function actorOf(user) {
  if (!user?.id) {
    return null;
  }

  return {
    userId: String(user.id),
    email: user.email ?? null,
    accountType: user.accountType ?? null,
  };
}

export function targetOf(user) {
  if (!user) {
    return null;
  }

  return {
    userId: user.id ? String(user.id) : null,
    email: user.email ?? null,
    tenantKey: user.tenantKey ?? null,
  };
}

export function buildAuditEntry({
  action,
  actor = null,
  target = null,
  details = null,
  ip = null,
  source = AUDIT_SOURCES.PANEL,
  at,
}) {
  return {
    at,
    action,
    source: source === AUDIT_SOURCES.SCRIPT ? AUDIT_SOURCES.SCRIPT : AUDIT_SOURCES.PANEL,
    actor,
    target,
    details: pickDetails(action, details),
    ip: ip ?? null,
    expiresAt: auditExpiresAt(action, at),
  };
}
