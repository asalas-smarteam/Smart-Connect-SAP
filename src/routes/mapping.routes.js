import {
  applyMappingTest,
  createAdminMapping,
  createMapping,
  getMappings,
} from '../controllers/mapping.controller.js';
import { internalKeyAuthOnly } from '../middleware/internalAuth.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

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
