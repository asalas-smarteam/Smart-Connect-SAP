export class MongooseWebhookEventProgressRepository {
  async markBusinessPartnerCreated({ WebhookEvent, eventId, requestPayload, responsePayload }) {
    if (!WebhookEvent || !eventId) {
      return;
    }

    await WebhookEvent.updateOne(
      { _id: eventId },
      {
        $set: {
          'payload.payloadBPSAP': requestPayload ?? null,
          'payload.responseBPSAP': responsePayload ?? null,
        },
      }
    );
  }

  async markOrderCreated({ WebhookEvent, eventId, result }) {
    if (!WebhookEvent || !eventId) {
      return;
    }

    const updates = {
      status: 'sap_order_created',
      lastError: null,
      'payload.sapResult': {
        docEntry: result?.docEntry ?? null,
        docNum: result?.docNum ?? null,
        cardCode: result?.cardCode ?? null,
      },
      'payload.sapOrderCreatedAt': new Date().toISOString(),
    };

    if (result?.payloadSap) {
      updates['payload.payloadSAP'] = result.payloadSap;
    }

    await WebhookEvent.updateOne(
      { _id: eventId },
      {
        $set: updates,
      }
    );
  }
}

export default MongooseWebhookEventProgressRepository;
