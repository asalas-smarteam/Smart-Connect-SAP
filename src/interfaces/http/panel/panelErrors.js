import { panelReasons } from '#application/use-cases/panel/panelReasons.js';

// Formato de error de /panel/api: { error, message? }. Nunca { ok: false }.
const REASON_TO_HTTP = Object.freeze({
  [panelReasons.VALIDATION_ERROR]: { status: 400, error: 'validation_error' },
  [panelReasons.INVALID_CREDENTIALS]: { status: 401, error: 'invalid_credentials' },
  [panelReasons.TOO_MANY_ATTEMPTS]: { status: 429, error: 'too_many_attempts' },
  [panelReasons.UNAUTHORIZED]: { status: 401, error: 'unauthorized' },
  [panelReasons.INVALID_CURRENT_PASSWORD]: { status: 400, error: 'invalid_current_password' },
  [panelReasons.EMAIL_TAKEN]: { status: 409, error: 'email_taken' },
  [panelReasons.NOT_FOUND]: { status: 404, error: 'not_found' },
  [panelReasons.INVALID_TRANSITION]: { status: 409, error: 'invalid_transition' },
  [panelReasons.TOO_MANY_IMAGES]: { status: 400, error: 'too_many_images' },
  [panelReasons.INVALID_IMAGE]: { status: 400, error: 'invalid_image' },
  [panelReasons.IMAGE_TOO_LARGE]: { status: 413, error: 'image_too_large' },
  [panelReasons.PAGE_WINDOW_EXCEEDED]: { status: 400, error: 'page_window_exceeded' },
  // El front muestra el message de validation_error tal cual: pide acotar la consulta.
  [panelReasons.QUERY_TIMEOUT]: { status: 400, error: 'validation_error' },
});

// Errores de @fastify/multipart (los lanza el parser mientras llega el formulario).
const MULTIPART_ERRORS = Object.freeze({
  FST_FILES_LIMIT: { status: 400, error: 'too_many_images', message: 'Máximo 5 imágenes por mensaje.' },
  FST_REQ_FILE_TOO_LARGE: { status: 413, error: 'image_too_large', message: 'Cada imagen puede pesar hasta 5 MB.' },
  FST_PARTS_LIMIT: { status: 400, error: 'validation_error', message: 'Formulario inválido.' },
  FST_FIELDS_LIMIT: { status: 400, error: 'validation_error', message: 'Formulario inválido.' },
  FST_PROTO_VIOLATION: { status: 400, error: 'validation_error', message: 'Formulario inválido.' },
  FST_INVALID_MULTIPART_CONTENT_TYPE: { status: 400, error: 'validation_error', message: 'Formulario inválido.' },
});

const HASHER_BUSY_RETRY_AFTER_SECONDS = 5;
const HASHER_BUSY_MESSAGE = 'Hay demasiados intentos en este momento. Intenta de nuevo en unos segundos.';

export function sendPanelError(reply, status, error, message) {
  return reply.code(status).send(message ? { error, message } : { error });
}

// Traduce el { ok: false, reason, message } de un caso de uso a la respuesta HTTP.
export function sendFailure(reply, result) {
  const mapping = REASON_TO_HTTP[result.reason];
  if (!mapping) {
    throw new Error(`Unknown panel failure reason: ${result.reason}`);
  }

  return sendPanelError(reply, mapping.status, mapping.error, result.message);
}

// Errores que no salen de un caso de uso: los de Fastify (validación, parser, tamaño) y los
// inesperados. Se loguean sin headers ni body: ahí viajan la cookie y las contraseñas.
export function registerPanelErrorHandlers(app, { logger }) {
  app.setErrorHandler((error, req, reply) => {
    if (error?.code === 'PANEL_HASHER_BUSY') {
      reply.header('Retry-After', String(HASHER_BUSY_RETRY_AFTER_SECONDS));
      return sendPanelError(reply, 429, 'too_many_attempts', HASHER_BUSY_MESSAGE);
    }

    if (error?.code === 'PANEL_INVALID_FORM') {
      return sendPanelError(reply, 400, 'validation_error', error.message);
    }

    const multipartError = MULTIPART_ERRORS[error?.code];
    if (multipartError) {
      return sendPanelError(reply, multipartError.status, multipartError.error, multipartError.message);
    }

    const status = Number(error?.statusCode);

    if (status === 413) {
      return sendPanelError(reply, 413, 'validation_error', 'La solicitud es demasiado grande.');
    }

    if (status >= 400 && status < 500) {
      return sendPanelError(reply, status, 'validation_error', 'La solicitud no es válida.');
    }

    logger.error({
      msg: 'Panel API unexpected error',
      method: req.method,
      route: req.routeOptions?.url ?? null,
      error: error?.message,
      stack: error?.stack,
    });
    return sendPanelError(reply, 500, 'internal_error');
  });

  app.setNotFoundHandler((req, reply) => sendPanelError(reply, 404, 'not_found'));
}
