// Motivos de rechazo de los casos de uso del panel. El controller los traduce al formato de
// error de /panel/api ({ error, message }) en src/interfaces/http/panel/panelErrors.js.
export const panelReasons = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CURRENT_PASSWORD: 'INVALID_CURRENT_PASSWORD',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  NOT_FOUND: 'NOT_FOUND',
  // Soporte (contrato D9).
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  TOO_MANY_IMAGES: 'TOO_MANY_IMAGES',
  INVALID_IMAGE: 'INVALID_IMAGE',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  PAGE_WINDOW_EXCEEDED: 'PAGE_WINDOW_EXCEEDED',
  // Eventos y syncs: la consulta pasó su tiempo máximo (se responde 400 con mensaje).
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',
});

export function fail(reason, message) {
  return message ? { ok: false, reason, message } : { ok: false, reason };
}

export function validationError(message) {
  return fail(panelReasons.VALIDATION_ERROR, message);
}

export default panelReasons;
