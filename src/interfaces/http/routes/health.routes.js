import buildHealthController from '#composition/health.composition.js';

export default async function healthRoutes(app) {
  app.get('/health', buildHealthController());
}
