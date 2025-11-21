import { echoTest } from '../controllers/echo.controller.js';

export default async function routes(app) {
    app.post('/', echoTest);
}
