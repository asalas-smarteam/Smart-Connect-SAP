export const PASSWORD_MIN_LENGTH = 10;
// Tope para no pasarle cuerpos enormes a scrypt.
export const PASSWORD_MAX_LENGTH = 200;

// Devuelve null si la contraseña nueva es válida, o el mensaje para el usuario si no.
export function validateNewPassword({ newPassword, currentPassword } = {}) {
  const password = typeof newPassword === 'string' ? newPassword : '';

  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Debe tener como máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
  }

  if (password === currentPassword) {
    return 'La contraseña nueva debe ser distinta de la actual.';
  }

  return null;
}
