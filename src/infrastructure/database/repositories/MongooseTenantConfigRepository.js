import { SaaSClient } from '../master/database.js';
import { getTenantModels } from '../tenant/tenantDatabase.js';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export class MongooseTenantConfigRepository {
  constructor({ clientModel = SaaSClient, tenantModelResolver = getTenantModels } = {}) {
    this.clientModel = clientModel;
    this.tenantModelResolver = tenantModelResolver;
  }

  async findActiveTenant({ tenantId, tenantKey, portalId } = {}) {
    const query = this.buildActiveTenantQuery({ tenantId, tenantKey, portalId });
    return this.clientModel.findOne(query).lean();
  }

  async getTenantModels(tenantKey) {
    const resolvedTenantKey = toNonEmptyString(tenantKey);
    if (!resolvedTenantKey) {
      throw new Error('tenantKey is required to resolve tenant models');
    }

    return this.tenantModelResolver(resolvedTenantKey);
  }

  buildActiveTenantQuery({ tenantId, tenantKey, portalId } = {}) {
    if (tenantId) {
      return { _id: tenantId, active: true };
    }

    if (tenantKey) {
      return { tenantKey, active: true };
    }

    if (portalId) {
      return { 'hubspot.portalId': String(portalId), active: true };
    }

    throw new Error('tenantId, tenantKey or portalId is required');
  }
}

export default MongooseTenantConfigRepository;

