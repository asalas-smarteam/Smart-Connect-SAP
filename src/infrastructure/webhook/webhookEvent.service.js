const CREATE_DEAL_EVENT_TYPE = 'createDeal';

// Event types that should be deduplicated per deal (one document per deal).
const DEDUPLICATED_EVENT_TYPES = new Set([
  CREATE_DEAL_EVENT_TYPE,
  'createQuotation',
  'convertQuotationToOrder',
]);

function normalizeDealId(payload) {
  return payload?.deal?.hs_object_id?.toString().trim();
}

export async function findDuplicateEvent({ WebhookEvent, eventType, payload }) {
  const dealId = normalizeDealId(payload);

  if (!dealId) {
    return null;
  }

  return WebhookEvent.findOne({
    eventType,
    'payload.deal.hs_object_id': dealId,
  }).select({ _id: 1 }).lean();
}

export async function findDuplicateCreateDealEvent({ WebhookEvent, payload }) {
  return findDuplicateEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });
}

export async function queueWebhookEvent({
  WebhookEvent,
  eventType,
  payload,
  deduplicate = DEDUPLICATED_EVENT_TYPES.has(eventType),
}) {
  if (deduplicate) {
    const duplicate = await findDuplicateEvent({ WebhookEvent, eventType, payload });

    if (duplicate) {
      return {
        duplicated: true,
        eventId: duplicate._id,
      };
    }
  }

  let createdEvent;

  try {
    createdEvent = await WebhookEvent.create({
      eventType,
      payload,
      status: 'waiting',
      retries: 0,
      maxRetries: 3,
      lastError: null,
    });
  } catch (error) {
    if (deduplicate && error?.code === 11000) {
      const existingEvent = await findDuplicateEvent({ WebhookEvent, eventType, payload });
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
