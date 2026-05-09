import { ApplicationError } from './application-error.js';

export class TenantConfigNotFoundError extends ApplicationError {
  constructor(tenantId) {
    super(`Tenant configuration was not found for tenant ${tenantId}`, {
      code: 'TENANT_CONFIG_NOT_FOUND',
      statusCode: 404,
      details: { tenantId },
    });
  }
}

export class TenantContextResolutionError extends ApplicationError {
  constructor(message = 'Tenant context could not be resolved', details = null) {
    super(message, {
      code: 'TENANT_CONTEXT_RESOLUTION_FAILED',
      statusCode: 400,
      details,
    });
  }
}

