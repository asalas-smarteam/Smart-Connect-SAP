import { resolveErrorMessageText } from '#application/services/error-message.service.js';

// Defense in depth: ProcessWebhookDealEventBatch already normalizes lastError
// before calling markFailed, but this keeps any future caller from repeating
// the bug that caused it (a raw SAP error object handed to a String schema
// field triggers a Mongoose CastError).
function toSafeLastError(lastError) {
  if (lastError === null) {
    return null;
  }

  if (typeof lastError === 'string') {
    return lastError;
  }

  return resolveErrorMessageText(lastError);
}

export class MongooseWebhookEventRepository {
  constructor({ WebhookEvent, batchSize, logger = { error: () => {} } }) {
    if (!WebhookEvent) {
      throw new Error('WebhookEvent model is required');
    }

    this.WebhookEvent = WebhookEvent;
    this.batchSize = Math.max(1, Number(batchSize || 1));
    this.logger = logger;
  }

  // La auditoría es soporte y nunca puede impedir que se guarde el estado del evento. Mongo
  // rechaza el `$set` COMPLETO cuando una sola clave no le sirve, y eso ya se cobró dos
  // eventos: "The dollar ($) prefixed field '$select' in 'sapAudit.sapCalls.0.params.$select'
  // is not valid for storage" hizo fallar el markCompleted de una orden ya creada en SAP, que
  // quedó colgada en 'sap_order_created'. Las claves del audit ya se sanean al construirlo
  // (sanitizeAuditKeys en sync/syncLog.service.js); esto es el segundo cinturón para
  // cualquier forma que se escape: se reintenta sin `sapAudit`, así status/retries/lastError
  // siempre quedan. Si el reintento también falla, el error se propaga: no es del audit y le
  // toca al batch manejarlo.
  async applyUpdates(eventId, updates) {
    try {
      await this.WebhookEvent.updateOne({ _id: eventId }, { $set: updates });
    } catch (error) {
      if (!('sapAudit' in updates)) {
        throw error;
      }

      const { sapAudit: _discarded, ...withoutAudit } = updates;
      this.logger?.error?.({
        msg: 'Webhook event sapAudit could not be persisted, saving the event state without it',
        eventId: String(eventId),
        error: resolveErrorMessageText(error),
      });

      await this.WebhookEvent.updateOne({ _id: eventId }, { $set: withoutAudit });
    }
  }

  async claimWaiting() {
    const claimed = [];

    while (claimed.length < this.batchSize) {
      const event = await this.WebhookEvent.findOneAndUpdate(
        { status: 'waiting' },
        { $set: { status: 'inprocess' } },
        { sort: { createdAt: 1, _id: 1 }, new: true }
      ).lean();

      if (!event) {
        break;
      }

      claimed.push(event);
    }

    return claimed;
  }

  // payload.payloadSAP (the old single-document snapshot) is superseded by sapAudit, which
  // captures request + response for BusinessPartner, ContactEmployee and the document
  // together -- see buildWebhookSapAudit in infrastructure/sync/syncLog.service.js.
  async markCompleted(event, result) {
    const updates = {
      status: 'completed',
      lastError: null,
      'payload.sapResult': {
        docEntry: result.docEntry,
        docNum: result.docNum,
        cardCode: result.cardCode,
      },
      'payload.processedAt': new Date().toISOString(),
    };

    if (result.sapAudit) {
      updates.sapAudit = result.sapAudit;
    }

    await this.applyUpdates(event._id, updates);
  }

  async markFailed(event, failure) {
    const updates = {
      status: failure.status,
      retries: failure.retries,
      lastError: toSafeLastError(failure.lastError),
    };

    if (failure.sapResult) {
      updates['payload.sapResult'] = {
        docEntry: failure.sapResult.docEntry ?? null,
        docNum: failure.sapResult.docNum ?? null,
        cardCode: failure.sapResult.cardCode ?? null,
      };
    }

    if (failure.sapAudit) {
      updates.sapAudit = failure.sapAudit;
    }

    await this.applyUpdates(event._id, updates);
  }
}

export default MongooseWebhookEventRepository;
