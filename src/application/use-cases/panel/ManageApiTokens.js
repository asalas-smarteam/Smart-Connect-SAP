import {
  API_TOKEN_REVOKE_REASONS,
  MAX_ACTIVE_API_TOKENS,
  apiTokenExpiresAt,
  checkApiTokenName,
  checkCurrentPassword,
} from '#domain/panel/apiTokens.js';
import { AUDIT_ACTIONS } from '#domain/panel/auditActions.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { NO_AUDIT_LOG, recordAudit, actorOf, buildAuditEntry, targetOf } from './panelAudit.js';

const TOO_MANY_ATTEMPTS_MESSAGE = 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.';
// Ventana del contador panel:pwdcheck: (5 contraseñas incorrectas cada 15 min por usuario).
const PASSWORD_CHECK_RETRY_AFTER_SECONDS = 15 * 60;
const INVALID_CURRENT_PASSWORD_MESSAGE = 'La contraseña actual no es correcta.';
const TOKEN_LIMIT_MESSAGE = `Ya tienes ${MAX_ACTIVE_API_TOKENS} tokens activos. Revoca uno para crear otro.`;

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Ítem de la lista de Mi cuenta (contrato 12, M2): nunca el token ni su hash.
export function toApiTokenItem(record) {
  return {
    id: String(record.id),
    name: record.name,
    prefix: record.prefix,
    createdAt: toIso(record.createdAt),
    expiresAt: toIso(record.expiresAt),
    lastUsedAt: toIso(record.lastUsedAt),
  };
}

// Tokens personales de las cuentas de Smarteam (contrato 12, M2 y M7). El controller ya exige
// sesión de cookie, cuenta smarteam y staff.tickets; aquí solo se trabaja con los tokens del
// usuario de la sesión.
export class ManageApiTokens {
  constructor({
    apiTokenRepository,
    apiTokenCodec,
    userRepository,
    passwordHasher,
    passwordAttempts,
    auditLog = NO_AUDIT_LOG,
    now = () => new Date(),
  }) {
    this.apiTokenRepository = apiTokenRepository;
    this.apiTokenCodec = apiTokenCodec;
    this.userRepository = userRepository;
    this.passwordHasher = passwordHasher;
    // LoginAttemptsPort con clave = id del usuario (keyPrefix 'panel:pwdcheck:').
    this.passwordAttempts = passwordAttempts;
    this.auditLog = auditLog;
    this.now = now;
  }

  // Solo los activos del usuario (ni revocados ni vencidos), el más nuevo primero.
  async list({ user } = {}) {
    const records = await this.apiTokenRepository.listActiveByUser(String(user.id), this.now());
    return { ok: true, data: { items: records.map(toApiTokenItem) } };
  }

  // Orden de M2: nombre y contraseña presentes → bloqueo por intentos → contraseña → límite de
  // 5 tokens. Así token_limit no sirve para probar contraseñas.
  async create({ user, fields = {}, ip = null } = {}) {
    const source = fields && typeof fields === 'object' ? fields : {};
    const name = checkApiTokenName(source.name);
    if (!name.ok) {
      return validationError(name.message);
    }
    const password = checkCurrentPassword(source.currentPassword);
    if (!password.ok) {
      return validationError(password.message);
    }

    const userId = String(user.id);
    // Se cuenta antes de verificar; mientras está bloqueado no se verifica la contraseña.
    const limit = await this.passwordAttempts.consume(userId);
    if (limit.blocked) {
      return fail(panelReasons.TOO_MANY_ATTEMPTS, TOO_MANY_ATTEMPTS_MESSAGE, {
        retryAfterSeconds: PASSWORD_CHECK_RETRY_AFTER_SECONDS,
      });
    }

    const owner = await this.userRepository.findById(userId);
    if (!owner || owner.active === false) {
      return fail(panelReasons.UNAUTHORIZED);
    }

    // Mismo código, status y mensaje que POST /auth/change-password (contrato C2).
    const matches = await this.passwordHasher.verify(password.password, owner.passwordHash);
    if (!matches) {
      return fail(panelReasons.INVALID_CURRENT_PASSWORD, INVALID_CURRENT_PASSWORD_MESSAGE);
    }
    await this.passwordAttempts.reset(userId);

    const at = this.now();
    const active = await this.apiTokenRepository.countActiveByUser(userId, at);
    if (active >= MAX_ACTIVE_API_TOKENS) {
      return fail(panelReasons.TOKEN_LIMIT, TOKEN_LIMIT_MESSAGE);
    }

    // Solo se guardan el hash y el prefix; el token en claro sale únicamente en esta respuesta.
    const { token, hash, prefix } = this.apiTokenCodec.generate();
    const record = await this.apiTokenRepository.create({
      userId,
      name: name.name,
      tokenHash: hash,
      prefix,
      createdAt: at,
      expiresAt: apiTokenExpiresAt(at),
    });

    await this.#audit(AUDIT_ACTIONS.API_TOKEN_CREATED, {
      actor: owner,
      target: owner,
      details: {
        tokenId: String(record.id),
        prefix: record.prefix,
        name: record.name,
        expiresAt: toIso(record.expiresAt),
      },
      ip,
      at,
    });

    return { ok: true, statusCode: 201, data: { token, item: toApiTokenItem(record) } };
  }

  // id inválido, inexistente, de otro usuario o ya revocado → not_found (no se confirma nada).
  async revoke({ user, id, ip = null } = {}) {
    const at = this.now();
    const revoked = await this.apiTokenRepository.revoke({
      userId: String(user.id),
      id: typeof id === 'string' ? id : null,
      reason: API_TOKEN_REVOKE_REASONS.USER,
      at,
    });
    if (!revoked) {
      return fail(panelReasons.NOT_FOUND);
    }

    await this.#audit(AUDIT_ACTIONS.API_TOKEN_REVOKED, {
      actor: user,
      target: user,
      details: { tokenId: String(revoked.id), prefix: revoked.prefix, reason: revoked.revokedReason ?? API_TOKEN_REVOKE_REASONS.USER },
      ip,
      at,
    });

    return { ok: true, statusCode: 204 };
  }

  // Revocación masiva al desactivar o restablecer la contraseña (M7). actor = quien revoca (el
  // admin), target = el dueño: si no viene, se carga del repositorio. Una entrada de auditoría
  // por token. Devuelve los registros que esta llamada revocó. Los errores del repositorio se
  // propagan (decisión 4 del plan).
  async revokeAllForUser({ userId, reason, actor = null, target = null, ip = null } = {}) {
    const ownerId = String(userId);
    const at = this.now();
    const revoked = await this.apiTokenRepository.revokeAllForUser({ userId: ownerId, reason, at });
    if (revoked.length === 0) {
      return revoked;
    }

    const owner = target ?? (await this.userRepository.findById(ownerId)) ?? { id: ownerId };
    for (const record of revoked) {
      await this.#audit(AUDIT_ACTIONS.API_TOKEN_REVOKED, {
        actor,
        target: owner,
        details: { tokenId: String(record.id), prefix: record.prefix, reason },
        ip,
        at,
      });
    }
    return revoked;
  }

  async #audit(action, { actor, target, details, ip, at }) {
    await recordAudit(this.auditLog, buildAuditEntry({
      action,
      actor: actorOf(actor),
      target: targetOf(target),
      details,
      ip,
      at,
    }));
  }
}

export default ManageApiTokens;
