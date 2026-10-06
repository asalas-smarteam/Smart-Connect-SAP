import sapCredentialsController from '../controllers/sapCredentials.controller.js';
import { adminTenantAuth } from '../middlewares/adminAuth.js';

export default async function routes(app) {
  app.route({
    method: 'POST',
    url: '/config/sap-credentials',
    preHandler: adminTenantAuth,
    handler: sapCredentialsController.createSapCredentials,
  });

  app.route({
    method: 'GET',
    url: '/config/sap-credentials',
    preHandler: adminTenantAuth,
    handler: sapCredentialsController.listSapCredentials,
  });

  app.route({
    method: 'GET',
    url: '/config/sap-credentials/:id',
    preHandler: adminTenantAuth,
    handler: sapCredentialsController.getSapCredentials,
  });

  app.route({
    method: 'PATCH',
    url: '/config/sap-credentials/:id',
    preHandler: adminTenantAuth,
    handler: sapCredentialsController.patchSapCredentials,
  });

  app.route({
    method: 'DELETE',
    url: '/config/sap-credentials/:id',
    preHandler: adminTenantAuth,
    handler: sapCredentialsController.deleteSapCredentials,
  });
}
