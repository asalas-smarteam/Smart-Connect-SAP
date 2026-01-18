import hubspotAuthService from '../services/hubspotAuthService.js';
import associationService from '../services/associationService.js';
import { tenantResolver } from '../middleware/tenantResolver.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export default async function routes(app) {
  app.post('/test/associate/deal', { preHandler: tenantResolver }, async (req, reply) => {
    try {
      const {
        dealId,
        contacts = [],
        companies = [],
        products = [],
        hubspotCredentialId,
      } = req.body || {};
      const tenantModels = requireTenantModels(req);

      const token = await hubspotAuthService.getAccessToken(hubspotCredentialId, tenantModels);

      if (!token) {
        return reply.status(400).send({ ok: false, message: 'Failed to retrieve access token' });
      }

      await associationService.associateDealWithContacts(
        token,
        hubspotCredentialId,
        dealId,
        contacts,
        tenantModels
      );
      await associationService.associateDealWithCompanies(
        token,
        hubspotCredentialId,
        dealId,
        companies,
        tenantModels
      );
      await associationService.associateDealWithProducts(
        token,
        hubspotCredentialId,
        dealId,
        products,
        tenantModels
      );

      return reply.send({ ok: true });
    } catch (error) {
      console.error('Failed to associate deal in test route', error);
      return reply.send({ ok: false, message: error.message });
    }
  });
}
