import mappingService from './mapping.service.js';
import sapWebhookService from './sapWebhookService.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_RETRY_OPTIONS,
  processInBatches,
} from '../utils/batchProcessor.js';

const webhookProcessor = {
  async processPendingEvents({ tenantModels, batchSize = DEFAULT_BATCH_SIZE, retryOptions } = {}) {
    if (!tenantModels) {
      throw new Error('Tenant models are required to process webhook events');
    }

    const { WebhookEvent } = tenantModels;
    const pendingEvents = await WebhookEvent.find({ status: 'pending' }).sort({ createdAt: 1 });

    if (!pendingEvents.length) {
      return { processed: 0 };
    }

    const resolvedRetryOptions = retryOptions || DEFAULT_RETRY_OPTIONS;
    const maxAttempts = (resolvedRetryOptions.retries ?? 0) + 1;

    await processInBatches(pendingEvents, {
      batchSize,
      retryOptions: resolvedRetryOptions,
      handler: async (event, attempt) => {
        const eventRecord = await WebhookEvent.findById(event._id).lean();

        if (!eventRecord) {
          return;
        }

        if (eventRecord.status === 'done' || eventRecord.status === 'failed') {
          return;
        }

        if (eventRecord.attempts >= maxAttempts) {
          await WebhookEvent.updateOne(
            { _id: event._id },
            { $set: { status: 'failed' } }
          );
          return;
        }

        if (attempt === 0) {
          const locked = await WebhookEvent.findOneAndUpdate(
            { _id: event._id, status: 'pending' },
            { $set: { status: 'processing' } },
            { new: true }
          );

          if (!locked) {
            return;
          }
        }

        try {
          const mappedPayload = await mappingService.applyMapping(
            eventRecord.payload.data,
            eventRecord.hubspotCredentialId,
            eventRecord.objectType,
            tenantModels
          );

          await sapWebhookService.sendToSap({
            payload: mappedPayload,
            objectType: eventRecord.objectType,
            hubspotCredentialId: eventRecord.hubspotCredentialId,
            tenantModels,
          });

          await WebhookEvent.updateOne(
            { _id: event._id },
            {
              $set: {
                status: 'done',
                processedAt: new Date(),
                errorMessage: null,
              },
            }
          );
        } catch (error) {
          await WebhookEvent.updateOne(
            { _id: event._id },
            { $inc: { attempts: 1 }, $set: { errorMessage: error.message } }
          );

          if (eventRecord.attempts + 1 >= maxAttempts) {
            await WebhookEvent.updateOne(
              { _id: event._id },
              { $set: { status: 'failed' } }
            );
          }

          throw error;
        }
      },
    });

    return { processed: pendingEvents.length };
  },
};

export default webhookProcessor;
