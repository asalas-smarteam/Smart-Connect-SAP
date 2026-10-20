import { isValidEmail, normalizeEmail } from '#domain/panel/accounts.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { toSessionBody } from './panelUserView.js';
import { AUDIT_ACTIONS } from '#domain/panel/auditActions.js';
import { NO_AUDIT_LOG, recordAudit, buildAuditEntry, targetOf } from './panelAudit.js';

const TOO_MANY_ATTEMPTS_MESSAGE = 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.';

export class LoginPanelUser {
  constructor({
    userRepository,
    tenantDirectory,
    passwordHasher,
    sessionToken,
    loginAttempts,
    ipLoginAttempts = null,
    auditLog = NO_AUDIT_LOG,
    now = () => new Date(),
  }) {
    this.userRepository = userRepository;
    this.tenantDirectory = tenantDirectory;
    this.passwordHasher = passwordHasher;
    this.sessionToken = sessionToken;
    this.loginAttempts = loginAttempts;
    // null si el límite por IP está apagado (sin PANEL_TRUSTED_PROXIES).
    this.ipLoginAttempts = ipLoginAttempts;
    this.auditLog = auditLog;
    this.now = now;
  }

  // clientIp va a la auditoría; clientIpKey es la clave del límite (una IPv6 agrupada por /64).
  async execute({ email, password, clientIp = null, clientIpKey = clientIp } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
      return validationError('Correo y contraseña son obligatorios.');
    }

    // Límite por IP antes que el de correo y que el scrypt: un bloqueo no gasta cálculo. Cuenta
    // todos los intentos y nunca se reinicia al acertar (si no, una cuenta válida lo reiniciaría).
    if (this.ipLoginAttempts && clientIpKey) {
      const ipLimit = await this.ipLoginAttempts.consume(clientIpKey);
      if (ipLimit.blocked) {
        // Se audita solo el primer bloqueo de la ventana: los reintentos bloqueados no escriben.
        if (ipLimit.firstBlocked) await this.#audit(AUDIT_ACTIONS.LOGIN_BLOCKED, { email: normalizedEmail, details: { reason: 'ip' }, ip: clientIp });
        return fail(panelReasons.TOO_MANY_ATTEMPTS, TOO_MANY_ATTEMPTS_MESSAGE);
      }
    }

    // El intento se cuenta antes de verificar, para que una ráfaga en paralelo no pase toda
    // junta. Bloquea aunque la contraseña sea correcta: el límite es por correo, exista o no.
    const emailLimit = await this.loginAttempts.consume(normalizedEmail);
    if (emailLimit.blocked) {
      if (emailLimit.firstBlocked) await this.#audit(AUDIT_ACTIONS.LOGIN_BLOCKED, { email: normalizedEmail, details: { reason: 'email' }, ip: clientIp });
      return fail(panelReasons.TOO_MANY_ATTEMPTS, TOO_MANY_ATTEMPTS_MESSAGE);
    }

    const user = await this.userRepository.findByEmail(normalizedEmail);

    // Mismo error y mismo trabajo de scrypt para "no existe", "inactivo" y "contraseña
    // incorrecta": el login no revela qué correos tienen cuenta.
    if (!user || user.active === false) {
      await this.passwordHasher.verifyDummy(password);
      await this.#auditFailure(normalizedEmail, user, clientIp);
      return fail(panelReasons.INVALID_CREDENTIALS);
    }

    const matches = await this.passwordHasher.verify(password, user.passwordHash);
    if (!matches) {
      await this.#auditFailure(normalizedEmail, user, clientIp);
      return fail(panelReasons.INVALID_CREDENTIALS);
    }

    await this.loginAttempts.reset(normalizedEmail);
    await this.userRepository.touchLastLogin(user.id, this.now());
    await this.#audit(AUDIT_ACTIONS.LOGIN_SUCCEEDED, { user, ip: clientIp });

    const token = this.sessionToken.sign({
      sub: user.id,
      tv: user.tokenVersion,
      pwdChange: user.mustChangePassword,
    });
    const tenant = user.tenantKey ? await this.tenantDirectory.findByKey(user.tenantKey) : null;

    return {
      ok: true,
      data: {
        token,
        session: toSessionBody(user, tenant?.companyName),
      },
    };
  }

  // La causa no se distingue ("no existe", "inactivo", "contraseña incorrecta"): el registro
  // tampoco revela qué correos tienen cuenta.
  async #auditFailure(email, user, ip) {
    await this.#audit(AUDIT_ACTIONS.LOGIN_FAILED, {
      user: user ?? null,
      email,
      details: { reason: 'invalid_credentials' },
      ip,
    });
  }

  async #audit(action, { user = null, email = null, details = null, ip = null }) {
    await recordAudit(this.auditLog, buildAuditEntry({
      action,
      // Un "correo" inválido no se guarda: puede ser una contraseña pegada en el campo equivocado.
      target: user ? targetOf(user) : { userId: null, email: isValidEmail(email) ? email : null, tenantKey: null },
      details,
      ip,
      at: this.now(),
    }));
  }
}

export default LoginPanelUser;
