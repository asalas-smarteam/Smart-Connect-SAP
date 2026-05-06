const CREATE_DEAL_EVENT_TYPE = 'createDeal';

function normalizeDealId(payload) {
  return payload?.deal?.hs_object_id?.toString().trim();
}

export async function findDuplicateCreateDealEvent({ WebhookEvent, payload }) {
  const dealId = normalizeDealId(payload);

  if (!dealId) {
    return null;
  }

  return WebhookEvent.findOne({
    eventType: CREATE_DEAL_EVENT_TYPE,
    'payload.deal.hs_object_id': dealId,
  }).select({ _id: 1 }).lean();
}

export async function queueCreateDealEvent({ WebhookEvent, payload }) {
  const duplicate = await findDuplicateCreateDealEvent({ WebhookEvent, payload });

  if (duplicate) {
    return {
      duplicated: true,
      eventId: duplicate._id,
    };
  }

  let createdEvent;

  try {
    createdEvent = await WebhookEvent.create({
      eventType: CREATE_DEAL_EVENT_TYPE,
      payload,
      status: 'waiting',
      retries: 0,
      maxRetries: 3,
      lastError: null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      const existingEvent = await findDuplicateCreateDealEvent({ WebhookEvent, payload });
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

export { CREATE_DEAL_EVENT_TYPE };
