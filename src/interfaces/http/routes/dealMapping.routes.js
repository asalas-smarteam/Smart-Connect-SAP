import dealMappingController from '../controllers/dealMapping.controller.js';
import { adminTenantAuth } from '../middlewares/adminAuth.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/deal-pipelines',
    preHandler: adminTenantAuth,
    handler: dealMappingController.listPipelines,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deal-pipelines',
    preHandler: adminTenantAuth,
    handler: dealMappingController.createPipeline,
  });

  app.route({
    method: 'PATCH',
    url: '/mappings/deal-pipelines/:id',
    preHandler: adminTenantAuth,
    handler: dealMappingController.patchPipeline,
  });

  app.route({
    method: 'DELETE',
    url: '/mappings/deal-pipelines/:id',
    preHandler: adminTenantAuth,
    handler: dealMappingController.deletePipeline,
  });

  app.route({
    method: 'GET',
    url: '/mappings/deal-stages',
    preHandler: adminTenantAuth,
    handler: dealMappingController.listStages,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deal-stages',
    preHandler: adminTenantAuth,
    handler: dealMappingController.createStage,
  });

  app.route({
    method: 'PATCH',
    url: '/mappings/deal-stages/:id',
    preHandler: adminTenantAuth,
    handler: dealMappingController.patchStage,
  });

  app.route({
    method: 'DELETE',
    url: '/mappings/deal-stages/:id',
    preHandler: adminTenantAuth,
    handler: dealMappingController.deleteStage,
  });
}
