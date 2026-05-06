export class ApplicationError extends Error {
  constructor(message, { code, statusCode = 500, details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || this.constructor.name;
    this.statusCode = statusCode;
    this.details = details;
  }
}

