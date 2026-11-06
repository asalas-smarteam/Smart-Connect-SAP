import { JSON_ONLY_MESSAGE, sendPanelError } from '../panel/panelErrors.js';
import { sendResult } from './panelTickets.controller.js';

const JSON_CONTENT_TYPE = 'application/json';

function isJsonRequest(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return contentType === JSON_CONTENT_TYPE;
}

function staffUser(req) {
  const { id, name, email, accountType } = req.panelUser;
  return { id, name, email, accountType };
}

// Registro de trabajo desde la skill de Claude (contrato 12, M4 y M5). Acepta token personal o
// cookie: req.panelAuth dice cuál (lo deja el guard).
export function createPanelWorkLogController({ useCases }) {
  return {
    async findByCode(req, reply) {
      return sendResult(reply, await useCases.staffWorkLog.findByCode({ code: req.params.code }));
    },

    // Solo JSON. El cuerpo va tal cual: el caso de uso valida y normaliza. Idempotency-Key se
    // pasa como venga (si fuera un arreglo, el dominio lo rechaza).
    async publish(req, reply) {
      if (!isJsonRequest(req)) {
        return sendPanelError(reply, 400, 'validation_error', JSON_ONLY_MESSAGE);
      }
      return sendResult(reply, await useCases.staffWorkLog.publish({
        user: staffUser(req),
        auth: req.panelAuth,
        code: req.params.code,
        body: req.body,
        idempotencyKey: req.headers['idempotency-key'],
        ip: req.panelClientIp ?? null,
      }));
    },
  };
}

export default createPanelWorkLogController;
