export class MongooseWebhookEventRepository {
  constructor({ WebhookEvent, batchSize }) {
    if (!WebhookEvent) {
      throw new Error('WebhookEvent model is required');
    }

    this.WebhookEvent = WebhookEvent;
    this.batchSize = Math.max(1, Number(batchSize || 1));
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

    if (result.payloadSap) {
      updates['payload.payloadSAP'] = result.payloadSap;
    }

    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: updates,
      }
    );
  }

  async markFailed(event, failure) {
    const updates = {
      status: failure.status,
      retries: failure.retries,
      lastError: failure.lastError,
    };

    if (failure.sapResult) {
      updates['payload.sapResult'] = {
        docEntry: failure.sapResult.docEntry ?? null,
        docNum: failure.sapResult.docNum ?? null,
        cardCode: failure.sapResult.cardCode ?? null,
      };
    }

    if (failure.payloadSap) {
      updates['payload.payloadSAP'] = failure.payloadSap;
    }

    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: updates,
      }
    );
  }
}

export default MongooseWebhookEventRepository;
