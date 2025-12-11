import dealOwnerMappingController from '../controllers/dealOwnerMapping.controller.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/deals/owners/:hubspotCredentialId',
    handler: dealOwnerMappingController.listOwners,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deals/owners/:hubspotCredentialId',
    handler: dealOwnerMappingController.upsertOwner,
  });
}
