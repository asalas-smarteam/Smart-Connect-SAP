// Tipos de cuenta y roles del panel de soporte. Smarteam es un tipo de cuenta aparte; dentro de
// cada empresa cliente hay dos roles. Ver docs/superpowers/specs/2026-10-12-panel-soporte-design.md.
export const ACCOUNT_TYPES = Object.freeze({
  SMARTEAM: 'smarteam',
  CLIENTE: 'cliente',
});

export const CLIENT_ROLES = Object.freeze(['admin', 'usuario']);

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

export function isClientRole(role) {
  return CLIENT_ROLES.includes(role);
}
