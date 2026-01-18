import env from '../config/env.js';

const { INTERNAL_KEY } = env;

function respond(reply, next, statusCode, payload) {
  if (reply?.code) {
    reply.code(statusCode).send(payload);
    return true;
  }
  if (typeof next === 'function') {
    const error = new Error(payload?.error || 'Unauthorized');
    error.statusCode = statusCode;
    next(error);
    return true;
  }
  return false;
}

export function internalRequestValidator(req, reply, next) {
  const internalKey = req.headers?.['x-internal-key'];

  if (!INTERNAL_KEY || internalKey !== INTERNAL_KEY) {
    return respond(reply, next, 403, { error: 'Invalid internal key' });
  }

  const { nombreEmpresa } = req.body || {};
  if (!nombreEmpresa || typeof nombreEmpresa !== 'string' || !nombreEmpresa.trim()) {
    return respond(reply, next, 400, { error: 'nombreEmpresa is required' });
  }

  if (typeof next === 'function') {
    return next();
  }
  return undefined;
}
