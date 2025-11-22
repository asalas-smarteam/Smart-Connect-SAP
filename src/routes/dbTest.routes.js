import { testExternalDb } from '../controllers/dbTest.controller.js';

export default async function routes(app) {
  app.get('/config/test-db/:id', testExternalDb);
}
