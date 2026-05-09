import {
  applyMappingTest,
  createAdminMapping,
  createMapping,
  getMappings,
} from '../controllers/mapping.controller.js';
import { internalKeyAuthOnly } from '../middlewares/internalAuth.js';
import { tenantResolver } from '../middlewares/tenantResolver.js';

export default async function routes(app) {
  app.post('/mapping', { preHandler: tenantResolver }, createMapping);
  app.post(
    '/admin/mapping',
    { preHandler: [internalKeyAuthOnly, tenantResolver] },
    createAdminMapping
  );
  app.get('/mapping', { preHandler: tenantResolver }, getMappings);
  app.post('/mapping/test', { preHandler: tenantResolver }, applyMappingTest);
}
