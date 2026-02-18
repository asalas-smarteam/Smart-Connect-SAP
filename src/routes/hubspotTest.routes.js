import hubspotService from '../services/hubspotService.js';
import { tenantResolver } from '../middleware/tenantResolver.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export default async function routes(app) {
  app.post('/hubspot/test/send/:clientConfigId', { preHandler: tenantResolver }, async (req, reply) => {
    try {
      const { clientConfigId } = req.params;
      const { ClientConfig } = requireTenantModels(req);
      const config = await ClientConfig.findById(clientConfigId);

      if (!config) {
        return reply.send({ ok: false, message: 'ClientConfig not found' });
      }

      const tenantModels = requireTenantModels(req);
      const result = await hubspotService.sendToHubSpot(req.body, config, 'contact', tenantModels);

      return reply.send(result);
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  });
}
