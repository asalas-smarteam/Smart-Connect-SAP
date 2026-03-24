import sapCredentialsController from '../controllers/sapCredentials.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.route({
    method: 'POST',
    url: '/config/sap-credentials',
    preHandler: tenantResolver,
    handler: sapCredentialsController.createSapCredentials,
  });

  app.route({
    method: 'GET',
    url: '/config/sap-credentials',
    preHandler: tenantResolver,
    handler: sapCredentialsController.listSapCredentials,
  });

  app.route({
    method: 'GET',
    url: '/config/sap-credentials/:id',
    preHandler: tenantResolver,
    handler: sapCredentialsController.getSapCredentials,
  });

  app.route({
    method: 'PATCH',
    url: '/config/sap-credentials/:id',
    preHandler: tenantResolver,
    handler: sapCredentialsController.patchSapCredentials,
  });

  app.route({
    method: 'DELETE',
    url: '/config/sap-credentials/:id',
    preHandler: tenantResolver,
    handler: sapCredentialsController.deleteSapCredentials,
  });
}
