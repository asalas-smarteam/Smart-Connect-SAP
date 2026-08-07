const MAX_ERROR_MESSAGE_LENGTH = 2000;

function truncate(text) {
  return text.length > MAX_ERROR_MESSAGE_LENGTH ? text.slice(0, MAX_ERROR_MESSAGE_LENGTH) : text;
}

// A message "source" is either already a string, or SAP's `{ lang, value }`
// shape -- pull the usable string out of either, otherwise null.
function extractMessageText(candidate) {
  if (typeof candidate === 'string' && candidate) {
    return candidate;
  }

  if (candidate && typeof candidate === 'object' && typeof candidate.value === 'string' && candidate.value) {
    return candidate.value;
  }

  return null;
}

/**
 * SAP B1 Service Layer reports failures as a nested object
 * (`{ error: { message: { lang, value } } }`) instead of a plain string. Code
 * that read that shape naively (`error?.response?.data?.error?.message`) handed
 * the raw `{ lang, value }` object to `WebhookEvent.lastError`, a `String`
 * schema field -- Mongoose threw a CastError that escaped the per-event
 * try/catch and aborted the whole webhook batch. This function always returns
 * a string, no matter how malformed, nested, or circular the error is, so no
 * caller can repeat that mistake.
 */
export function resolveErrorMessageText(error) {
  if (error === null || error === undefined) {
    return 'Unknown error';
  }

  const data = error?.response?.data;
  const fromNestedMessage = extractMessageText(data?.error?.message);

  if (fromNestedMessage) {
    return truncate(fromNestedMessage);
  }

  const fromDataMessage = extractMessageText(data?.message);

  if (fromDataMessage) {
    return truncate(fromDataMessage);
  }

  if (typeof error.message === 'string' && error.message) {
    return truncate(error.message);
  }

  // Handles a caller passing SAP's bare `{ lang, value }` message object
  // directly as the error (exactly the shape the pre-fix bug stored as
  // `lastError`), with no `.response.data...` wrapper around it.
  const fromBareValue = extractMessageText(error);

  if (fromBareValue) {
    return truncate(fromBareValue);
  }

  try {
    const stringified = JSON.stringify(error);
    if (typeof stringified === 'string' && stringified) {
      return truncate(stringified);
    }
  } catch {
    // Circular structure or non-serializable value: fall through to String().
  }

  try {
    return truncate(String(error));
  } catch {
    return 'Unknown error';
  }
}

export default { resolveErrorMessageText };
