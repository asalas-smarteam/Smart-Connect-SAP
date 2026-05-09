import ProvisionInternalTenant from '#application/use-cases/ProvisionInternalTenant.js';
import ProvisioningPayloadValidatorAdapter from '#infrastructure/tenants/ProvisioningPayloadValidatorAdapter.js';
import TenantProvisioningAdapter from '#infrastructure/tenants/TenantProvisioningAdapter.js';

export function buildProvisionInternalTenant() {
  return new ProvisionInternalTenant({
    provisioningService: new TenantProvisioningAdapter(),
    provisioningValidator: new ProvisioningPayloadValidatorAdapter(),
  });
}

export default buildProvisionInternalTenant;
