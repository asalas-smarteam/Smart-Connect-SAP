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
    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: 'completed',
          lastError: null,
          'payload.sapResult': {
            docEntry: result.docEntry,
            docNum: result.docNum,
            cardCode: result.cardCode,
          },
          'payload.processedAt': new Date().toISOString(),
        },
      }
    );
  }

  async markFailed(event, failure) {
    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: failure.status,
          retries: failure.retries,
          lastError: failure.lastError,
        },
      }
    );
  }
}

export default MongooseWebhookEventRepository;
