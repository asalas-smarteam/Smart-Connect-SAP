import {
  applyMappingTest,
  createMapping,
  getMappings,
} from '../controllers/mapping.controller.js';

export default async function routes(app) {
  app.post('/mapping', createMapping);
  app.get('/mapping', getMappings);
  app.post('/mapping/test', applyMappingTest);
}
