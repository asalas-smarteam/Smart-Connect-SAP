const CREATE_DEAL_EVENT_TYPE = 'createDeal';

// El ÚNICO estado que habilita un reenvío. Es el único que garantiza que no hay documento en
// SAP: `errored` se escribe cuando se agotaron los retries o el error fue permanente, siempre
// antes de crear el documento. Cuando SAP sí creó y falló algo posterior, el estado es
// `sap_created_hubspot_error`, que bloquea -- reprocesarlo crearía un segundo documento.
export const RESENDABLE_STATUS = 'errored';

// Tipos con un solo evento ABIERTO por deal. Única fuente de verdad de la lista: el
// repositorio y la migración la importan de acá.
//
// `updateQuotation` NO está, a propósito: una cotización se actualiza muchas veces y cada
// envío es legítimo, así que ahí el reenvío ya funciona desde siempre. Agregarlo bloquearía la
// segunda actualización de una cotización que ya sincronizó bien, porque su evento anterior
// quedó `completed`. No es un olvido y no hay que "completar" la lista por prolijidad.
export const DEDUPLICATED_EVENT_TYPES = new Set([
  CREATE_DEAL_EVENT_TYPE,
  'createQuotation',
  'convertQuotationToOrder',
  'inventoryTransferRequest',
  'purchaseQuotation',
]);

function normalizeDealId(payload) {
  return payload?.deal?.hs_object_id?.toString().trim();
}

// Devuelve el evento que impide encolar uno nuevo para este (eventType, dealId), o null si no
// hay ninguno. La condición se escribe por EXCLUSIÓN (`$ne: RESENDABLE_STATUS`) y no como
// lista blanca de estados que bloquean: si mañana se agrega un estado al enum de WebhookEvent
// y nadie se acuerda de este archivo, el default es bloquear, que es el lado seguro del error.
export async function findBlockingEvent({ WebhookEvent, eventType, payload }) {
  const dealId = normalizeDealId(payload);

  if (!dealId) {
    return null;
  }

  return WebhookEvent.findOne({
    eventType,
    'payload.deal.hs_object_id': dealId,
    status: { $ne: RESENDABLE_STATUS },
  }).select({ _id: 1 }).lean();
}

export async function queueWebhookEvent({
  WebhookEvent,
  eventType,
  payload,
  deduplicate = DEDUPLICATED_EVENT_TYPES.has(eventType),
}) {
  if (deduplicate) {
    const blocking = await findBlockingEvent({ WebhookEvent, eventType, payload });

    if (blocking) {
      return {
        duplicated: true,
        eventId: blocking._id,
      };
    }
  }

  const document = {
    eventType,
    payload,
    status: 'waiting',
    retries: 0,
    maxRetries: 3,
    lastError: null,
  };

  // Solo los tipos deduplicados ocupan cupo en el índice único parcial. Para el resto el
  // campo queda AUSENTE, no en `false`: un documento sin el campo no entra al índice, que es
  // justo lo que necesita updateQuotation para poder repetirse.
  if (deduplicate) {
    document.dedupActive = true;
  }

  let createdEvent;

  try {
    createdEvent = await WebhookEvent.create(document);
  } catch (error) {
    // Dos reenvíos simultáneos: los dos pasaron el findBlockingEvent y el índice único dejó
    // entrar a uno solo. El que perdió se comporta como duplicado, igual que si hubiera
    // llegado un segundo después.
    if (deduplicate && error?.code === 11000) {
      const existingEvent = await findBlockingEvent({ WebhookEvent, eventType, payload });
      return {
        duplicated: true,
        eventId: existingEvent?._id,
      };
    }
    throw error;
  }

  return {
    duplicated: false,
    eventId: createdEvent._id,
  };
}

export async function queueCreateDealEvent({ WebhookEvent, payload }) {
  return queueWebhookEvent({
    WebhookEvent,
    eventType: CREATE_DEAL_EVENT_TYPE,
    payload,
    deduplicate: true,
  });
}

export { CREATE_DEAL_EVENT_TYPE };
