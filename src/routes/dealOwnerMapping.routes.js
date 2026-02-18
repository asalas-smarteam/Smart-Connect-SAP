import dealOwnerMappingController from '../controllers/dealOwnerMapping.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/deals/owners/:hubspotCredentialId',
    preHandler: tenantResolver,
    handler: dealOwnerMappingController.listOwners,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deals/owners/:hubspotCredentialId',
    preHandler: tenantResolver,
    handler: dealOwnerMappingController.upsertOwner,
  });
}
