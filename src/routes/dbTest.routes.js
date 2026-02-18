import { testExternalDb } from '../controllers/dbTest.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.get('/config/test-db/:id', { preHandler: tenantResolver }, testExternalDb);
}
