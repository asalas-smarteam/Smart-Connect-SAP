import {
  applyMappingTest,
  createMapping,
  getMappings,
} from '../controllers/mapping.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.post('/mapping', { preHandler: tenantResolver }, createMapping);
  app.get('/mapping', { preHandler: tenantResolver }, getMappings);
  app.post('/mapping/test', { preHandler: tenantResolver }, applyMappingTest);
}
