import ProvisionInternalTenant, {
  provisioningReasons,
} from '../../../application/use-cases/ProvisionInternalTenant.js';
import ProvisioningPayloadValidatorAdapter from '../../../infrastructure/tenants/ProvisioningPayloadValidatorAdapter.js';
import TenantProvisioningAdapter from '../../../infrastructure/tenants/TenantProvisioningAdapter.js';

function buildProvisionInternalTenant() {
  return new ProvisionInternalTenant({
    provisioningService: new TenantProvisioningAdapter(),
    provisioningValidator: new ProvisioningPayloadValidatorAdapter(),
  });
}

export const provisionInternalTenant = async (req, reply) => {
  try {
    const result = await buildProvisionInternalTenant().execute(req.body);

    if (!result.ok) {
      const status = result.reason === provisioningReasons.BAD_REQUEST ? 400 : 500;
      return reply.code(status).send({ error: result.error });
    }

    return reply.send(result.data);
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
};
