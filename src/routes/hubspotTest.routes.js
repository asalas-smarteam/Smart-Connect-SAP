import ClientConfig from '../db/models/ClientConfig.js';
import hubspotService from '../services/hubspotService.js';

export default async function routes(app) {
  app.post('/hubspot/test/send/:clientConfigId', async (req, reply) => {
    try {
      const { clientConfigId } = req.params;
      const config = await ClientConfig.findById(clientConfigId);

      if (!config) {
        return reply.send({ ok: false, message: 'ClientConfig not found' });
      }

      const result = await hubspotService.sendToHubSpot(req.body, config, 'contact');

      return reply.send(result);
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  });
}
