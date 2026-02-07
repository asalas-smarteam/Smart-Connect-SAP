function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithRetry(fn, options = {}) {
  const {
    retries = 2,
    delayMs = 1000,
    onError,
  } = options;

  let attempt = 0;

  while (true) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (onError) {
        await onError(error, attempt);
      }

      if (attempt >= retries) {
        throw error;
      }

      attempt += 1;

      if (delayMs > 0) {
        await delay(delayMs);
      }
    }
  }
}
