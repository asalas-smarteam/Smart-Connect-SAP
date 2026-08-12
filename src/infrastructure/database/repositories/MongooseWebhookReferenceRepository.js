import { buildWebhookEventReferenceUpdates } from '#application/services/webhook-payload.service.js';

export class MongooseWebhookReferenceRepository {
  async persistReferences({
    WebhookEvent,
    eventId,
    payload,
    companyExists,
    contactExists,
    cardCode = null,
    contactEmployeeCode = null,
    // Solo tiene sentido escribir internalCode al contact del deal cuando ese
    // contact es el ContactEmployee real (modo dealContact). Ver
    // buildWebhookEventReferenceUpdates.
    dealContactIsContactEmployee = false,
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
      dealContactIsContactEmployee,
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

