import { resolveActiveTenant } from '../../utils/tenantSubscriptions.js';

export class ActiveTenantSubscriptionResolver {
  async resolve({ tenantId, tenantKey, portalId } = {}) {
    return resolveActiveTenant({ tenantId, tenantKey, portalId });
  }
}

export default ActiveTenantSubscriptionResolver;
