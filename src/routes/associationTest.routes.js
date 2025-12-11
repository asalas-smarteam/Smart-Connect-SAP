import hubspotAuthService from '../services/hubspotAuthService.js';
import associationService from '../services/associationService.js';

export default async function routes(app) {
  app.post('/test/associate/deal', async (req, reply) => {
    try {
      const {
        dealId,
        contacts = [],
        companies = [],
        products = [],
        hubspotCredentialId,
      } = req.body || {};

      const token = await hubspotAuthService.getAccessToken(hubspotCredentialId);

      if (!token) {
        return reply.status(400).send({ ok: false, message: 'Failed to retrieve access token' });
      }

      await associationService.associateDealWithContacts(
        token,
        hubspotCredentialId,
        dealId,
        contacts
      );
      await associationService.associateDealWithCompanies(
        token,
        hubspotCredentialId,
        dealId,
        companies
      );
      await associationService.associateDealWithProducts(
        token,
        hubspotCredentialId,
        dealId,
        products
      );

      return reply.send({ ok: true });
    } catch (error) {
      console.error('Failed to associate deal in test route', error);
      return reply.send({ ok: false, message: error.message });
    }
  });
}
