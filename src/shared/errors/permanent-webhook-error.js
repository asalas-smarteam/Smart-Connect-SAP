export class PermanentWebhookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentWebhookError';
    this.permanent = true;
  }
}

