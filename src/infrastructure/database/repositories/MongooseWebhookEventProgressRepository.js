export class MongooseWebhookEventProgressRepository {
  async markOrderCreated({ WebhookEvent, eventId, result }) {
    if (!WebhookEvent || !eventId) {
      return;
    }

    await WebhookEvent.updateOne(
      { _id: eventId },
      {
        $set: {
          status: 'sap_order_created',
          lastError: null,
          'payload.sapResult': {
            docEntry: result?.docEntry ?? null,
            docNum: result?.docNum ?? null,
            cardCode: result?.cardCode ?? null,
          },
          'payload.sapOrderCreatedAt': new Date().toISOString(),
        },
      }
    );
  }
}

export default MongooseWebhookEventProgressRepository;
