import dealMappingController from '../controllers/dealMapping.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/deal-pipelines',
    preHandler: tenantResolver,
    handler: dealMappingController.listPipelines,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deal-pipelines',
    preHandler: tenantResolver,
    handler: dealMappingController.createPipeline,
  });

  app.route({
    method: 'PATCH',
    url: '/mappings/deal-pipelines/:id',
    preHandler: tenantResolver,
    handler: dealMappingController.patchPipeline,
  });

  app.route({
    method: 'DELETE',
    url: '/mappings/deal-pipelines/:id',
    preHandler: tenantResolver,
    handler: dealMappingController.deletePipeline,
  });

  app.route({
    method: 'GET',
    url: '/mappings/deal-stages',
    preHandler: tenantResolver,
    handler: dealMappingController.listStages,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deal-stages',
    preHandler: tenantResolver,
    handler: dealMappingController.createStage,
  });

  app.route({
    method: 'PATCH',
    url: '/mappings/deal-stages/:id',
    preHandler: tenantResolver,
    handler: dealMappingController.patchStage,
  });

  app.route({
    method: 'DELETE',
    url: '/mappings/deal-stages/:id',
    preHandler: tenantResolver,
    handler: dealMappingController.deleteStage,
  });
}
