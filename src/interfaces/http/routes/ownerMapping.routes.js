import ownerMappingController from '../controllers/ownerMapping.controller.js';
import { adminTenantAuth } from '../middlewares/adminAuth.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/owners',
    preHandler: adminTenantAuth,
    handler: ownerMappingController.listOwners,
  });

  app.route({
    method: 'POST',
    url: '/mappings/owners',
    preHandler: adminTenantAuth,
    handler: ownerMappingController.createOwner,
  });

  app.route({
    method: 'GET',
    url: '/mappings/owners/:id',
    preHandler: adminTenantAuth,
    handler: ownerMappingController.getOwner,
  });

  app.route({
    method: 'PATCH',
    url: '/mappings/owners/:id',
    preHandler: adminTenantAuth,
    handler: ownerMappingController.patchOwner,
  });

  app.route({
    method: 'DELETE',
    url: '/mappings/owners/:id',
    preHandler: adminTenantAuth,
    handler: ownerMappingController.deleteOwner,
  });
}
