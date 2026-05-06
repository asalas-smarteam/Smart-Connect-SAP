import { TenantContextResolutionError } from '../../shared/errors/index.js';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export class TenantContextService {
  constructor({ tenantConfigRepository } = {}) {
    if (!tenantConfigRepository) {
      throw new TenantContextResolutionError(
        'tenantConfigRepository is required to resolve tenant context'
      );
    }

    this.tenantConfigRepository = tenantConfigRepository;
  }

  async resolve({ tenantId, tenantKey, portalId } = {}) {
    const client = await this.tenantConfigRepository.findActiveTenant({
      tenantId,
      tenantKey,
      portalId,
    });

    if (!client) {
      throw new TenantContextResolutionError('Tenant context could not be resolved', {
        tenantId: tenantId || null,
        tenantKey: tenantKey || null,
        portalId: portalId || null,
      });
    }

    const resolvedTenantKey = toNonEmptyString(client.tenantKey);
    if (!resolvedTenantKey) {
      throw new TenantContextResolutionError('Resolved tenant is missing tenantKey', {
        tenantId: String(client._id),
      });
    }

    return {
      client,
      tenantId: String(client._id),
      tenantKey: resolvedTenantKey,
      tenantModels: await this.tenantConfigRepository.getTenantModels(resolvedTenantKey),
    };
  }
}

export default TenantContextService;
