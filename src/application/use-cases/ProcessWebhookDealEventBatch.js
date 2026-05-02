function emptySummary() {
  return {
    processed: 0,
    completed: 0,
    retried: 0,
    errored: 0,
    skipped: 0,
    errorDetails: [],
  };
}

function resolveLastErrorMessage(error) {
  return error?.response?.data?.error?.message || error.message;
}

export class ProcessWebhookDealEventBatch {
  constructor({
    webhookEventRepository,
    processWebhookDealEvent,
    logger,
    maxRetries,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
  }) {
    this.webhookEventRepository = webhookEventRepository;
    this.processWebhookDealEvent = processWebhookDealEvent;
    this.logger = logger;
    this.maxRetries = Math.max(1, Number(maxRetries || 1));
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
  }

  async execute({ tenantModels, tenantId, tenantKey, portalId } = {}) {
    if (!tenantModels) {
      throw new Error('Tenant models are required to process webhook events');
    }

    const events = await this.webhookEventRepository.claimWaiting();

    if (!events?.length) {
      return emptySummary();
    }

    this.logger.info({
      msg: 'Webhook batch processing started',
      tenantId: tenantId || null,
      tenantKey: tenantKey || null,
      portalId: portalId || null,
      batchSize: events.length,
    });

    const summary = {
      ...emptySummary(),
      processed: events.length,
    };

    for (const event of events) {
      try {
        const result = await this.processWebhookDealEvent({
          event,
          tenantModels,
          tenantId,
          tenantKey,
          portalId,
        });

        await this.webhookEventRepository.markCompleted(event, result);
        summary.completed += 1;

        this.logger.info({
          msg: 'Webhook event processed',
          tenantId: tenantId || null,
          tenantKey: tenantKey || null,
          eventId: String(event._id),
          status: 'completed',
          docEntry: result.docEntry,
          docNum: result.docNum,
        });
      } catch (error) {
        await this.handleProcessingError({
          error,
          event,
          tenantId,
          tenantKey,
          summary,
        });
      }
    }

    return summary;
  }

  async handleProcessingError({ error, event, tenantId, tenantKey, summary }) {
    const currentRetries = Number(event?.retries || 0);
    const configuredMaxRetries = Math.max(
      1,
      Number(event?.maxRetries || 0) || this.maxRetries
    );
    const isPermanent = Boolean(error?.permanent);
    const nextRetries = isPermanent ? configuredMaxRetries : currentRetries + 1;
    const shouldRetry = !isPermanent && nextRetries < configuredMaxRetries;
    const nextStatus = shouldRetry ? 'waiting' : 'errored';

    await this.webhookEventRepository.markFailed(event, {
      status: nextStatus,
      retries: nextRetries,
      lastError: resolveLastErrorMessage(error),
    });

    if (shouldRetry) {
      summary.retried += 1;
    } else {
      summary.errored += 1;
      this.appendErrorDetails(summary, event, error);
    }

    this.logger.error({
      msg: 'Webhook event processing failed',
      tenantId: tenantId || null,
      tenantKey: tenantKey || null,
      eventId: String(event._id),
      retries: nextRetries,
      maxRetries: configuredMaxRetries,
      nextStatus,
      error: error.message,
    });
  }

  appendErrorDetails(summary, event, error) {
    if (Array.isArray(error?.syncLogWebhookErrors) && error.syncLogWebhookErrors.length > 0) {
      summary.errorDetails.push(...error.syncLogWebhookErrors);
      return;
    }

    summary.errorDetails.push(
      this.buildWebhookSyncErrorEntry({
        payloadHubspot: event?.payload || null,
        payloadSap: null,
        responseHubspot: null,
        responseSap: this.buildErrorResponseSnapshot(error),
      })
    );
  }
}

export default ProcessWebhookDealEventBatch;
