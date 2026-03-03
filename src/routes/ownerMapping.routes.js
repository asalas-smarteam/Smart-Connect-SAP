import ownerMappingController from '../controllers/ownerMapping.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/deals/owners/:hubspotCredentialId',
    preHandler: tenantResolver,
    handler: ownerMappingController.listOwners,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deals/owners/:hubspotCredentialId',
    preHandler: tenantResolver,
    handler: ownerMappingController.upsertOwner,
  });
}
