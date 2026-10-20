import {
  ACCOUNT_TYPES,
  isClientRole,
  isValidEmail,
  normalizeEmail,
} from '#domain/panel/accounts.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { parsePagination } from './pagination.js';
import { toPublicUser } from './panelUserView.js';
import { AUDIT_ACTIONS, AUDIT_SOURCES } from '#domain/panel/auditActions.js';
import { NO_AUDIT_LOG, recordAudit, actorOf, buildAuditEntry, targetOf } from './panelAudit.js';

const NAME_MAX_LENGTH = 100;
const EDITABLE_FIELDS = ['name', 'role', 'active'];
const FORBIDDEN_PATCH_FIELDS = ['tenantKey', 'accountType'];

const MESSAGES = Object.freeze({
  invalidEmail: 'El correo no es válido.',
  invalidName: `El nombre es obligatorio y puede tener hasta ${NAME_MAX_LENGTH} caracteres.`,
  invalidAccountType: 'El tipo de cuenta no es válido.',
  missingTenant: 'La empresa es obligatoria para una cuenta de cliente.',
  unknownTenant: 'La empresa no existe.',
  invalidRole: 'El rol debe ser admin o usuario.',
  smarteamShape: 'Las cuentas de Smarteam no llevan empresa ni rol.',
  smarteamRole: 'Las cuentas de Smarteam no tienen rol.',
  immutableFields: 'No se puede cambiar la empresa ni el tipo de cuenta; crea otro usuario.',
  emptyPatch: 'No hay cambios para aplicar.',
  invalidActive: 'El estado debe ser verdadero o falso.',
  selfDeactivate: 'No puedes desactivar tu propia cuenta.',
  selfReset: 'No puedes restablecer tu propia contraseña desde aquí.',
  emailTaken: 'Ya existe un usuario con ese correo.',
});

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizeName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const name = value.trim();
  return name.length >= 1 && name.length <= NAME_MAX_LENGTH ? name : null;
}

function normalizeTenantKey(value) {
  const tenantKey = String(value ?? '').trim().toLowerCase();
  return tenantKey || null;
}

function isSelf(actor, id) {
  return Boolean(actor?.id) && String(actor.id) === String(id);
}

// Alta, edición y restablecimiento de usuarios del panel. Solo Smarteam llega aquí (permiso
// staff.users); el actor es quien hace el cambio.
export class ManagePanelUsers {
  constructor({
    userRepository,
    tenantDirectory,
    passwordHasher,
    temporaryPasswordGenerator,
    auditLog = NO_AUDIT_LOG,
    now = () => new Date(),
  }) {
    this.userRepository = userRepository;
    this.tenantDirectory = tenantDirectory;
    this.passwordHasher = passwordHasher;
    this.temporaryPasswordGenerator = temporaryPasswordGenerator;
    this.auditLog = auditLog;
    this.now = now;
  }

  async list({ tenantKey, page, pageSize } = {}) {
    const pagination = parsePagination({ page, pageSize });
    if (!pagination.ok) {
      return pagination;
    }

    const { items, total } = await this.userRepository.list({
      tenantKey: normalizeTenantKey(tenantKey),
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    // Una sola consulta de empresas por página, no una por fila.
    const companies = await this.#companyNames(items.map((user) => user.tenantKey));

    return {
      ok: true,
      data: {
        items: items.map((user) => toPublicUser(user, companies.get(user.tenantKey))),
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
      },
    };
  }

  // actor: { id, email, accountType } de la sesión, o null desde el script (source 'script').
  async create({
    actor = null,
    ip = null,
    source = AUDIT_SOURCES.PANEL,
    email,
    name,
    accountType,
    tenantKey,
    role,
  } = {}) {
    if (!isValidEmail(email)) {
      return validationError(MESSAGES.invalidEmail);
    }

    const normalizedName = normalizeName(name);
    if (!normalizedName) {
      return validationError(MESSAGES.invalidName);
    }

    let tenant = null;
    if (accountType === ACCOUNT_TYPES.CLIENTE) {
      const normalizedTenantKey = normalizeTenantKey(tenantKey);
      if (!normalizedTenantKey) {
        return validationError(MESSAGES.missingTenant);
      }
      if (!isClientRole(role)) {
        return validationError(MESSAGES.invalidRole);
      }

      tenant = await this.tenantDirectory.findByKey(normalizedTenantKey);
      if (!tenant) {
        return validationError(MESSAGES.unknownTenant);
      }
    } else if (accountType === ACCOUNT_TYPES.SMARTEAM) {
      if (isPresent(tenantKey) || isPresent(role)) {
        return validationError(MESSAGES.smarteamShape);
      }
    } else {
      return validationError(MESSAGES.invalidAccountType);
    }

    const temporaryPassword = this.temporaryPasswordGenerator.generate();
    const passwordHash = await this.passwordHasher.hash(temporaryPassword);

    let created;
    try {
      created = await this.userRepository.create({
        email: normalizeEmail(email),
        name: normalizedName,
        accountType,
        tenantKey: tenant ? tenant.tenantKey : null,
        role: tenant ? role : null,
        passwordHash,
        mustChangePassword: true,
        active: true,
        createdBy: actor?.id ?? null,
      });
    } catch (error) {
      if (error?.code === 'PANEL_EMAIL_TAKEN') {
        return fail(panelReasons.EMAIL_TAKEN, MESSAGES.emailTaken);
      }
      throw error;
    }

    await this.#audit(AUDIT_ACTIONS.USER_CREATED, {
      actor,
      target: created,
      details: { accountType: created.accountType, role: created.role ?? null },
      ip,
      source,
    });

    // La temporal se devuelve una sola vez y no se guarda en claro.
    return {
      ok: true,
      statusCode: 201,
      data: {
        user: toPublicUser(created, tenant?.companyName),
        temporaryPassword,
      },
    };
  }

  async update({ actor = null, ip = null, id, patch } = {}) {
    const changes = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

    if (FORBIDDEN_PATCH_FIELDS.some((field) => hasOwn(changes, field))) {
      return validationError(MESSAGES.immutableFields);
    }

    if (!EDITABLE_FIELDS.some((field) => hasOwn(changes, field))) {
      return validationError(MESSAGES.emptyPatch);
    }

    const user = await this.userRepository.findById(id);
    if (!user) {
      return fail(panelReasons.NOT_FOUND);
    }

    const set = {};

    if (hasOwn(changes, 'name')) {
      const normalizedName = normalizeName(changes.name);
      if (!normalizedName) {
        return validationError(MESSAGES.invalidName);
      }
      set.name = normalizedName;
    }

    if (hasOwn(changes, 'role')) {
      if (user.accountType !== ACCOUNT_TYPES.CLIENTE) {
        return validationError(MESSAGES.smarteamRole);
      }
      if (!isClientRole(changes.role)) {
        return validationError(MESSAGES.invalidRole);
      }
      set.role = changes.role;
    }

    if (hasOwn(changes, 'active')) {
      if (typeof changes.active !== 'boolean') {
        return validationError(MESSAGES.invalidActive);
      }
      if (changes.active === false && isSelf(actor, user.id)) {
        return validationError(MESSAGES.selfDeactivate);
      }
      set.active = changes.active;
    }

    // Desactivar sube tokenVersion: corta la sesión abierta y evita que una reactivación
    // posterior reviva sesiones viejas. Cambiar el rol no la sube: rige igual en el request
    // siguiente porque el rol se lee del usuario.
    const deactivating = set.active === false && user.active !== false;
    const updated = deactivating
      ? await this.userRepository.incrementTokenVersion(user.id, set)
      : await this.userRepository.update(user.id, set);

    if (!updated) {
      return fail(panelReasons.NOT_FOUND);
    }

    await this.#auditUpdate({ actor, ip, before: user, after: updated });

    const companies = await this.#companyNames([updated.tenantKey]);
    return { ok: true, data: { user: toPublicUser(updated, companies.get(updated.tenantKey)) } };
  }

  async resetPassword({ actor = null, ip = null, id } = {}) {
    if (isSelf(actor, id)) {
      return validationError(MESSAGES.selfReset);
    }

    const user = await this.userRepository.findById(id);
    if (!user) {
      return fail(panelReasons.NOT_FOUND);
    }

    const temporaryPassword = this.temporaryPasswordGenerator.generate();
    const passwordHash = await this.passwordHasher.hash(temporaryPassword);
    const updated = await this.userRepository.incrementTokenVersion(user.id, {
      passwordHash,
      mustChangePassword: true,
    });

    if (!updated) {
      return fail(panelReasons.NOT_FOUND);
    }

    await this.#audit(AUDIT_ACTIONS.USER_PASSWORD_RESET, { actor, target: updated, ip });

    return { ok: true, data: { temporaryPassword } };
  }

  // Un cambio de nombre o de rol es user.updated con { from, to } solo de lo que cambió de
  // verdad; un cambio de estado es user.deactivated o user.reactivated.
  async #auditUpdate({ actor, ip, before, after }) {
    const changes = {};
    ['name', 'role'].forEach((field) => {
      if ((before[field] ?? null) !== (after[field] ?? null)) {
        changes[field] = { from: before[field] ?? null, to: after[field] ?? null };
      }
    });

    if (Object.keys(changes).length > 0) {
      await this.#audit(AUDIT_ACTIONS.USER_UPDATED, { actor, target: after, details: { changes }, ip });
    }

    const wasActive = before.active !== false;
    const isActive = after.active !== false;
    if (wasActive !== isActive) {
      await this.#audit(isActive ? AUDIT_ACTIONS.USER_REACTIVATED : AUDIT_ACTIONS.USER_DEACTIVATED, {
        actor,
        target: after,
        ip,
      });
    }
  }

  async #audit(action, { actor, target, details = null, ip = null, source = AUDIT_SOURCES.PANEL }) {
    await recordAudit(this.auditLog, buildAuditEntry({
      action,
      actor: actorOf(actor),
      target: targetOf(target),
      details,
      ip,
      source,
      at: this.now(),
    }));
  }

  async #companyNames(tenantKeys) {
    const keys = [...new Set(tenantKeys.filter(Boolean))];
    if (keys.length === 0) {
      return new Map();
    }

    const tenants = await this.tenantDirectory.findManyByKeys(keys);
    return new Map(tenants.map((tenant) => [tenant.tenantKey, tenant.companyName]));
  }
}

export default ManagePanelUsers;
