// Publica en el deal de HubSpot el estado terminal del evento. Es el hermano de
// `notifyWebhookFailure` (webhookFailureNotifier.service.js) y comparte su regla dura: corre
// DESPUÉS del bookkeeping, así que no puede tirar nunca hacia arriba -- un hipo de HubSpot acá
// no puede desandar un markFailed/markCompleted que ya se guardó en Mongo.
//
// El valor concreto sale de la configuración del tenant, no de una constante: un tenant puede
// tener su propia propiedad de estado y sus propios valores. Si la configuración está
// incompleta, `getWebhookFailureNotificationConfig` devuelve la función apagada y acá no se
// escribe nada.
export function buildPublishIntegrationStatus({
  hubspotClient,
  hubspotWebhookAdapter,
  getWebhookFailureNotificationConfig,
  resolveEventPayload,
  logger,
}) {
  return async function publishIntegrationStatus({ event, status, tenantModels, portalId }) {
    try {
      const config = await getWebhookFailureNotificationConfig({ tenantModels });
      const property = config.integrationStatusProperty;
      const value = config.integrationStatusValues?.[status];

      // Apagado por configuración, o un `status` que el tenant no configuró. En los dos casos
      // no hay nada honesto que escribir, y no escribir nada es inocuo: la propiedad es
      // informativa y el que decide si se puede reenviar es el estado del WebhookEvent.
      if (!property || !value) {
        return;
      }

      const { deal } = resolveEventPayload(event);
      const dealId = deal?.hs_object_id;

      if (!dealId) {
        logger.warn({
          msg: 'Integration status skipped: no dealId in event payload',
          eventId: String(event?._id),
          status,
        });
        return;
      }

      const resolved = await hubspotWebhookAdapter.resolveAccessTokenForPortal({
        tenantModels,
        portalId,
      });

      if (!resolved?.token) {
        logger.warn({
          msg: 'Integration status skipped: no HubSpot credentials for tenant',
          eventId: String(event?._id),
          status,
        });
        return;
      }

      await hubspotClient.updateDeal(resolved.token, dealId, {
        properties: { [property]: value },
      });
    } catch (error) {
      logger.error({
        msg: 'Failed to publish integration status to HubSpot',
        eventId: String(event?._id),
        status,
        error: error.message,
      });
    }
  };
}

export default { buildPublishIntegrationStatus };
