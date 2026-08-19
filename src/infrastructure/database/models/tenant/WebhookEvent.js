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
    // Gobierna el índice único parcial de abajo: `true` significa "este documento ocupa hoy
    // el cupo de dedup de su (eventType, dealId)". Vale `true` en todo estado que no sea
    // `errored`, que es el único reenviable. Se deja AUSENTE a propósito en los tipos que no
    // participan del dedup (updateQuotation) y en los reportes de sync: un documento sin el
    // campo no entra al índice, que es exactamente lo que se quiere para ellos. Sin default,
    // para que "ausente" siga siendo un estado posible y distinto de `false`.
    dedupActive: {
      type: Boolean,
    },
    sapAudit: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'WebhookEvents',
  }
);

// Garantía dura de que no puede haber dos eventos ABIERTOS para el mismo (eventType, dealId):
// a lo sumo uno con `dedupActive: true`. Los `errored` quedan fuera del índice y se acumulan
// libremente, que es lo que habilita el reenvío y a la vez conserva el intento anterior como
// log. Cubre los cuatro tipos deduplicados, no solo `createDeal` como el índice que reemplaza.
//
// `dedupActive` va DENTRO de la llave además del filtro parcial, y no es redundante: MongoDB
// no acepta dos índices con el mismo patrón de llave que difieran solo en el
// `partialFilterExpression`, así que con la llave vieja este índice y el anterior no podrían
// coexistir y la migración tendría que tumbar el viejo antes de crear el nuevo, abriendo una
// ventana sin ninguna protección sobre `createDeal`. Semánticamente no cambia nada: el filtro
// ya fija `dedupActive: true` en todo lo indexado, así que la unicidad sobre la terna es la
// misma que sobre el par.
//
// El `$exists` del deal tampoco es decorativo: los reportes de calidad de datos viven en esta
// colección y no tienen deal, así que sin él colisionarían entre sí en (eventType, null).
webhookEventSchema.index(
  {
    eventType: 1,
    'payload.deal.hs_object_id': 1,
    dedupActive: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      dedupActive: true,
      'payload.deal.hs_object_id': { $exists: true },
    },
  }
);

export function createWebhookEventModel(connection) {
  return connection.models.WebhookEvent
    || connection.model('WebhookEvent', webhookEventSchema);
}
