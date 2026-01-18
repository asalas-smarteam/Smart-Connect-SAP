import { provisionTenant } from '../services/tenantProvisioning.js';

export const provisionInternalTenant = async (req, reply) => {
  try {
    const {
      nombreEmpresa,
      planId,
      billingEmail = null,
      hubspot = null,
    } = req.body || {};

    if (!planId) {
      return reply.code(400).send({ error: 'planId is required' });
    }

    const { client, subscription, tenantKey } = await provisionTenant({
      companyName: nombreEmpresa,
      planId,
      billingEmail,
      hubspot,
    });

    return reply.send({
      tenantId: client._id,
      tenantKey,
      nombreColeccion: tenantKey,
      estadoSuscripcion: subscription.status,
    });
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
};
