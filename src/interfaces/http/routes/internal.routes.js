import { provisionInternalTenant } from '../controllers/internal.controller.js';
import { internalRequestValidator } from '../middlewares/internalAuth.js';

export default async function routes(app) {
  app.post('/internal/tenant', { preHandler: internalRequestValidator }, provisionInternalTenant);
}
