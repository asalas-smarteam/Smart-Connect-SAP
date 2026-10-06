import {
  applyMappingTest,
  createAdminMapping,
  createMapping,
  getMappings,
} from '../controllers/mapping.controller.js';
import { adminTenantAuth } from '../middlewares/adminAuth.js';

export default async function routes(app) {
  app.post('/mapping', { preHandler: adminTenantAuth }, createMapping);
  app.post('/admin/mapping', { preHandler: adminTenantAuth }, createAdminMapping);
  app.get('/mapping', { preHandler: adminTenantAuth }, getMappings);
  app.post('/mapping/test', { preHandler: adminTenantAuth }, applyMappingTest);
}
