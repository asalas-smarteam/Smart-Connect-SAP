export function createWebhookController({ queueHubspotCreateDealWebhook, logger }) {
  return async function receiveHubspotWebhook(req, reply) {
    try {
      const result = await queueHubspotCreateDealWebhook.execute({
        payload: req.body ?? {},
        tenantId: req.headers?.['x-tenant-id'] || req.body?.tenantId,
      });

      return reply.code(200).send({
        success: true,
        message: result.message,
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      const message = statusCode >= 500 ? 'Internal error' : error.message;

      logger.error({
        msg: 'Failed to queue HubSpot createDeal webhook',
        error: error.message,
      });

      return reply.code(statusCode).send({
        success: false,
        message,
      });
    }
  };
}

export default createWebhookController;
