import { AUDIT_ACTIONS } from '#domain/panel/auditActions.js';
import { NO_AUDIT_LOG, buildAuditEntry, recordAudit } from './panelAudit.js';

// Cierra solo esta sesión: revoca su sid hasta que el token habría vencido. Las demás sesiones
// del usuario siguen abiertas (para cortarlas todas está tokenVersion: cambio o restablecimiento
// de contraseña y desactivación). Nunca falla: el controller borra la cookie y responde 204.
export class LogoutPanelSession {
  constructor({ sessionToken, revokedSessions, auditLog = NO_AUDIT_LOG, now = () => new Date() }) {
    this.sessionToken = sessionToken;
    this.revokedSessions = revokedSessions;
    this.auditLog = auditLog;
    this.now = now;
  }

  async execute({ token, ip = null } = {}) {
    const payload = token ? this.sessionToken.verify(token) : null;
    if (!payload?.sid) {
      return { ok: true, data: { revoked: false } };
    }

    let newlyRevoked;
    try {
      newlyRevoked = await this.revokedSessions.revoke({
        sid: payload.sid,
        userId: payload.sub,
        expiresAt: new Date(payload.exp * 1000),
      });
    } catch (error) {
      return { ok: true, data: { revoked: false, failed: true, error: error?.message ?? null } };
    }

    // Un logout repetido con el mismo token no escribe de nuevo en la auditoría.
    if (!newlyRevoked) {
      return { ok: true, data: { revoked: true } };
    }

    await recordAudit(this.auditLog, buildAuditEntry({
      action: AUDIT_ACTIONS.LOGOUT,
      actor: { userId: payload.sub, email: null, accountType: null },
      target: { userId: payload.sub, email: null, tenantKey: null },
      ip,
      at: this.now(),
    }));

    return { ok: true, data: { revoked: true } };
  }
}

export default LogoutPanelSession;
