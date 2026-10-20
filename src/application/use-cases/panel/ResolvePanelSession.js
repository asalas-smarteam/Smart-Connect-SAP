import { permissionsFor } from '#domain/panel/permissions.js';
import { fail, panelReasons } from './panelReasons.js';

// De la cookie de sesión a un usuario válido. Rol, tenant, estado y cambio de contraseña
// pendiente se leen del usuario en cada request (no del token): un cambio de rol o una
// desactivación rigen en el request siguiente.
//
// Además rechaza las sesiones cerradas con logout (sid revocado). La consulta de revocación
// corre en paralelo con la carga del usuario.
const NO_REVOKED_SESSIONS = Object.freeze({
  async isRevoked() {
    return false;
  },
});

export class ResolvePanelSession {
  constructor({ userRepository, sessionToken, revokedSessions = NO_REVOKED_SESSIONS }) {
    this.userRepository = userRepository;
    this.sessionToken = sessionToken;
    this.revokedSessions = revokedSessions;
  }

  async execute({ token } = {}) {
    const payload = token ? this.sessionToken.verify(token) : null;
    if (!payload || !payload.sid) {
      return fail(panelReasons.UNAUTHORIZED);
    }

    const [user, revoked] = await Promise.all([
      this.userRepository.findById(payload.sub),
      this.revokedSessions.isRevoked(payload.sid),
    ]);
    if (revoked || !user || user.active === false || user.tokenVersion !== payload.tv) {
      return fail(panelReasons.UNAUTHORIZED);
    }

    return {
      ok: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          accountType: user.accountType,
          role: user.role ?? null,
          tenantKey: user.tenantKey ?? null,
          permissions: permissionsFor({ accountType: user.accountType, role: user.role }),
        },
        mustChangePassword: Boolean(user.mustChangePassword),
      },
    };
  }
}

export default ResolvePanelSession;
