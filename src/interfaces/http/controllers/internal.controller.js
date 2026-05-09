import { provisioningReasons } from '#application/use-cases/ProvisionInternalTenant.js';
import buildProvisionInternalTenant from '#composition/internal-tenant.composition.js';

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
