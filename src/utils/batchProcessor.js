import { runWithRetry } from './retry.js';

export const DEFAULT_BATCH_SIZE = 25;
export const DEFAULT_RETRY_OPTIONS = {
  retries: 2,
  delayMs: 1000,
};

export async function processInBatches(items, options = {}) {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    handler,
    retryOptions = DEFAULT_RETRY_OPTIONS,
  } = options;

  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  if (typeof handler !== 'function') {
    throw new Error('Batch handler function is required');
  }

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);

    for (const item of batch) {
      if (retryOptions) {
        await runWithRetry((attempt) => handler(item, attempt), retryOptions);
      } else {
        await handler(item, 0);
      }
    }
  }
}
