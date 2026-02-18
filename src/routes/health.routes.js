import { health } from '../controllers/health.controller.js';

export default async function routes(app) {
  app.get('/health', health);
}
