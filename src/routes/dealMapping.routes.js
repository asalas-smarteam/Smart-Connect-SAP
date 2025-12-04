import dealMappingController from '../controllers/dealMapping.controller.js';

export default async function routes(app) {
  app.route({
    method: 'GET',
    url: '/mappings/deals/pipelines/:hubspotCredentialId',
    handler: dealMappingController.listPipelines,
  });

  app.route({
    method: 'GET',
    url: '/mappings/deals/stages/:hubspotCredentialId/:pipelineId',
    handler: dealMappingController.listStages,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deals/pipelines/:hubspotCredentialId',
    handler: dealMappingController.upsertPipeline,
  });

  app.route({
    method: 'POST',
    url: '/mappings/deals/stages/:hubspotCredentialId',
    handler: dealMappingController.upsertStage,
  });
}
