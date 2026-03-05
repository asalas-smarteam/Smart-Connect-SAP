import ownerMappingController from '../controllers/ownerMapping.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/owners',
    preHandler: tenantResolver,
    handler: ownerMappingController.listOwners,
  });

  app.route({
    method: 'POST',
    url: '/mappings/owners',
    preHandler: tenantResolver,
    handler: ownerMappingController.createOwner,
  });

  app.route({
    method: 'GET',
    url: '/mappings/owners/:id',
    preHandler: tenantResolver,
    handler: ownerMappingController.getOwner,
  });

  app.route({
    method: 'PATCH',
    url: '/mappings/owners/:id',
    preHandler: tenantResolver,
    handler: ownerMappingController.patchOwner,
  });

  app.route({
    method: 'DELETE',
    url: '/mappings/owners/:id',
    preHandler: tenantResolver,
    handler: ownerMappingController.deleteOwner,
  });
}
