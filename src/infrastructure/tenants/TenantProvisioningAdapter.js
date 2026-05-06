import { provisionTenant } from '../../services/tenantProvisioning.js';

export class TenantProvisioningAdapter {
  provisionTenant(payload) {
    return provisionTenant(payload);
  }
}

export default TenantProvisioningAdapter;
