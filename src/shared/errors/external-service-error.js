import { ApplicationError } from './application-error.js';

export class ExternalServiceError extends ApplicationError {
  constructor(serviceName, message, details = null) {
    super(message, {
      code: `${String(serviceName || 'external').toUpperCase()}_SERVICE_ERROR`,
      statusCode: 502,
      details,
    });
    this.serviceName = serviceName;
  }
}

