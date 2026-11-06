// Tokens personales del panel para cuentas de Smarteam (contrato 12, M2 y M7).
// Funciones puras: sin base de datos, sin crypto y sin reloj propio (la fecha llega de afuera).
// El token en claro nunca pasa por aquí salvo para comprobar su formato.

export const API_TOKEN_PREFIX = 'spn_';
export const API_TOKEN_TTL_DAYS = 90;
export const MAX_ACTIVE_API_TOKENS = 5;
export const API_TOKEN_NAME_MAX = 60;
// 'spn_' + 43 caracteres base64url (32 bytes sin relleno). Distingue mayúsculas: 'SPN_' no sirve.
export const API_TOKEN_PATTERN = /^spn_[A-Za-z0-9_-]{43}$/;
// 'spn_' + 4: solo para reconocer el token en la lista. No es único ni sirve para buscar.
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 8;
// El documento se borra (índice TTL en purgeAt) 30 días después de vencer o de revocarse.
export const API_TOKEN_PURGE_DAYS = 30;

export const API_TOKEN_REVOKE_REASONS = Object.freeze({
  USER: 'user',
  USER_DEACTIVATED: 'user_deactivated',
  PASSWORD_RESET: 'password_reset',
});

export const API_TOKEN_REVOKE_REASON_VALUES = Object.freeze(Object.values(API_TOKEN_REVOKE_REASONS));

const DAY_MS = 24 * 60 * 60 * 1000;
// Caracteres de control (saltos de línea, tabulaciones, \u0000…): se rechazan, no se limpian.
const CONTROL_CHARS = /\p{Cc}/u;

const NAME_LENGTH_MESSAGE = `El nombre debe tener entre 1 y ${API_TOKEN_NAME_MAX} caracteres.`;
const NAME_CONTROL_MESSAGE = 'El nombre no puede tener saltos de línea ni caracteres especiales.';
const CURRENT_PASSWORD_MESSAGE = 'Escribe tu contraseña actual.';

function toMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// Se comprueba antes de hashear o de ir a la base: lo que no cumple es 401 sin consulta.
export function isApiTokenFormat(value) {
  return typeof value === 'string' && API_TOKEN_PATTERN.test(value);
}

// Activo = no revocado y sin vencer.
export function isActiveToken(token, now) {
  if (!token || token.revokedAt != null || token.expiresAt == null) {
    return false;
  }
  const expiresAt = toMs(token.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > toMs(now);
}

// Los caracteres de control se buscan en el texto crudo, antes de recortar: un salto de línea
// al borde también se rechaza. Los espacios normales sí se recortan.
export function checkApiTokenName(value) {
  if (typeof value !== 'string') {
    return { ok: false, message: NAME_LENGTH_MESSAGE };
  }
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, message: NAME_CONTROL_MESSAGE };
  }
  const name = value.trim();
  if (name.length < 1 || name.length > API_TOKEN_NAME_MAX) {
    return { ok: false, message: NAME_LENGTH_MESSAGE };
  }
  return { ok: true, name };
}

// Crear un token vuelve a pedir la contraseña. No se recorta: la contraseña va tal cual.
export function checkCurrentPassword(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, message: CURRENT_PASSWORD_MESSAGE };
  }
  return { ok: true, password: value };
}

export function apiTokenExpiresAt(createdAt) {
  return new Date(toMs(createdAt) + API_TOKEN_TTL_DAYS * DAY_MS);
}

// purgeAt = expiresAt + 30 d al crear; revokedAt + 30 d al revocar.
export function apiTokenPurgeAt(date) {
  return new Date(toMs(date) + API_TOKEN_PURGE_DAYS * DAY_MS);
}
