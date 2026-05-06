import { provisionTenant } from './tenantProvisioning.js';

export class TenantProvisioningAdapter {
  provisionTenant(payload) {
    return provisionTenant(payload);
  }
}

export default TenantProvisioningAdapter;
