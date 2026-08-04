import mongoose from 'mongoose';

const { Schema } = mongoose;

export const webhookEventSchema = new Schema(
  {
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: [
        'waiting',
        'inprocess',
        'sap_order_created',
        'sap_created_hubspot_error',
        'completed',
        'errored',
        // Terminal and inert: this collection also stores sync data-quality
        // reports, which are records rather than work. `claimWaiting` selects on
        // `{ status: 'waiting' }` with no eventType filter, so a report queued as
        // `waiting` -- or as any status the state machine can revive -- would be
        // picked up and processed as a deal webhook. `report` is claimed by
        // nothing, which is the point.
        'report',
      ],
      default: 'waiting',
      index: true,
    },
    retries: {
      type: Number,
      default: 0,
    },
    maxRetries: {
      type: Number,
      default: 3,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'WebhookEvents',
  }
);

// NOTE: This partial unique index only covers `createDeal`. MongoDB does not allow
// multiple indexes with the same key pattern differing only by partialFilterExpression,
// so the quotation event types (createQuotation / updateQuotation / convertQuotationToOrder)
// rely on application-level dedup (queueWebhookEvent) plus the unique index on
// SapDocumentLinks (hubspotCredentialId + dealId + documentType) for race-safe idempotency.
webhookEventSchema.index(
  {
    eventType: 1,
    'payload.deal.hs_object_id': 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      eventType: 'createDeal',
      'payload.deal.hs_object_id': { $exists: true },
    },
  }
);

export function createWebhookEventModel(connection) {
  return connection.models.WebhookEvent
    || connection.model('WebhookEvent', webhookEventSchema);
}
