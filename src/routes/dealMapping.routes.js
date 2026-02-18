import dealMappingController from '../controllers/dealMapping.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/deals/pipelines/:hubspotCredentialId',
    preHandler: tenantResolver,
    handler: dealMappingController.listPipelines,
  });

  app.route({
    method: 'GET',
    url: '/mappings/deals/stages/:hubspotCredentialId/:pipelineId',
    preHandler: tenantResolver,
    handler: dealMappingController.listStages,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deals/pipelines/:hubspotCredentialId',
    preHandler: tenantResolver,
    handler: dealMappingController.upsertPipeline,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deals/stages/:hubspotCredentialId',
    preHandler: tenantResolver,
    handler: dealMappingController.upsertStage,
  });
}
