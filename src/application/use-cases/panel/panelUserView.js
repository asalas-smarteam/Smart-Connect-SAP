import { ACCOUNT_TYPES } from '#domain/panel/accounts.js';
import { permissionsFor } from '#domain/panel/permissions.js';

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clientFields(user, companyName) {
  if (user.accountType !== ACCOUNT_TYPES.CLIENTE) {
    return { tenantKey: null, companyName: null, role: null };
  }

  return {
    tenantKey: user.tenantKey ?? null,
    companyName: companyName ?? null,
    role: user.role ?? null,
  };
}

// Forma pública de un usuario (contrato C6). Nunca incluye passwordHash ni tokenVersion.
export function toPublicUser(user, companyName = null) {
  const { tenantKey, companyName: company, role } = clientFields(user, companyName);

  return {
    id: String(user.id),
    email: user.email,
    name: user.name,
    accountType: user.accountType,
    tenantKey,
    companyName: company,
    role,
    active: user.active !== false,
    mustChangePassword: Boolean(user.mustChangePassword),
    lastLoginAt: toIsoDate(user.lastLoginAt),
    createdAt: toIsoDate(user.createdAt),
  };
}

// Cuerpo de GET /auth/me y de la respuesta del login (contrato C4).
export function toSessionBody(user, companyName = null) {
  const { tenantKey, companyName: company, role } = clientFields(user, companyName);

  return {
    name: user.name,
    email: user.email,
    accountType: user.accountType,
    role,
    tenantKey,
    companyName: company,
    permissions: permissionsFor({ accountType: user.accountType, role: user.role }),
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}
