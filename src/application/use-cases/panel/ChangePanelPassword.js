import { validateNewPassword } from '#domain/panel/passwordPolicy.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { AUDIT_ACTIONS } from '#domain/panel/auditActions.js';
import { NO_AUDIT_LOG, recordAudit, actorOf, buildAuditEntry, targetOf } from './panelAudit.js';

export class ChangePanelPassword {
  constructor({ userRepository, passwordHasher, sessionToken, auditLog = NO_AUDIT_LOG, now = () => new Date() }) {
    this.userRepository = userRepository;
    this.passwordHasher = passwordHasher;
    this.sessionToken = sessionToken;
    this.auditLog = auditLog;
    this.now = now;
  }

  async execute({ userId, currentPassword, newPassword, ip = null } = {}) {
    const user = await this.userRepository.findById(userId);
    if (!user || user.active === false) {
      return fail(panelReasons.UNAUTHORIZED);
    }

    // 400 y no 401 (contrato C2): el front trata todo 401 como sesión vencida.
    const matches = await this.passwordHasher.verify(currentPassword, user.passwordHash);
    if (!matches) {
      return fail(panelReasons.INVALID_CURRENT_PASSWORD, 'La contraseña actual no es correcta.');
    }

    const policyError = validateNewPassword({ newPassword, currentPassword });
    if (policyError) {
      return validationError(policyError);
    }

    const passwordHash = await this.passwordHasher.hash(newPassword);
    // Solo si la versión no cambió desde que se leyó el usuario: si Smarteam restableció la
    // contraseña en el medio, este cambio no la pisa.
    const updated = await this.userRepository.incrementTokenVersion(
      user.id,
      { passwordHash, mustChangePassword: false },
      { expectedVersion: user.tokenVersion }
    );

    if (!updated) {
      return fail(panelReasons.UNAUTHORIZED);
    }

    await recordAudit(this.auditLog, buildAuditEntry({
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      actor: actorOf(updated),
      target: targetOf(updated),
      ip,
      at: this.now(),
    }));

    // Subir tokenVersion corta las demás sesiones; esta sigue con un token nuevo (contrato C3).
    const token = this.sessionToken.sign({
      sub: updated.id,
      tv: updated.tokenVersion,
      pwdChange: false,
    });

    return { ok: true, data: { token } };
  }
}

export default ChangePanelPassword;
