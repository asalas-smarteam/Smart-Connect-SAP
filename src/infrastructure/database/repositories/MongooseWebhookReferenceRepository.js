import { buildWebhookEventReferenceUpdates } from '../../../application/services/webhook-payload.service.js';

export class MongooseWebhookReferenceRepository {
  async persistReferences({
    WebhookEvent,
    eventId,
    payload,
    companyExists,
    contactExists,
    cardCode = null,
    contactEmployeeCode = null,
  }) {
    if (!WebhookEvent || !eventId || !payload) {
      return;
    }

    const updates = buildWebhookEventReferenceUpdates({
      payload,
      companyExists,
      contactExists,
      cardCode,
      contactEmployeeCode,
    });

    if (!Object.keys(updates).length) {
      return;
    }

    await WebhookEvent.updateOne(
      { _id: eventId },
      {
        $set: updates,
      }
    );
  }
}

export default MongooseWebhookReferenceRepository;

