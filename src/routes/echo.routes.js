import { echoTest } from '../controllers/echo.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
    app.post('/', { preHandler: tenantResolver }, echoTest);
}
