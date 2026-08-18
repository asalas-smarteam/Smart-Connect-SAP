// Best-effort side effect run after a webhook event permanently fails: it must
// never throw back into the caller, or a HubSpot hiccup here would corrupt the
// retry bookkeeping (`markFailed`) that already happened.
export function buildNotifyWebhookFailure({
  hubspotClient,
  hubspotWebhookAdapter,
  getWebhookFailureNotificationConfig,
  resolveEventPayload,
  logger,
}) {
  // `revertStage: false` lo usa el aviso de fallo PARCIAL (el documento sí se creó
  // en SAP, pero algún ContactEmployee fue rechazado): ahí la nota es válida pero
  // devolver el deal a una etapa anterior mentiría sobre el estado del documento.
  // Default true para no cambiar el camino de fallo definitivo, que sí debe moverla.
  return async function notifyWebhookFailure({
    event,
    lastError,
    tenantModels,
    portalId,
    revertStage = true,
  }) {
    try {
      const config = await getWebhookFailureNotificationConfig({ tenantModels });

      if (!config.requireMessageHS) {
        return;
      }

      const { deal } = resolveEventPayload(event);
      const dealId = deal?.hs_object_id;

      if (!dealId) {
        logger.warn({
          msg: 'Webhook failure note skipped: no dealId in event payload',
          eventId: String(event?._id),
        });
        return;
      }

      const resolved = await hubspotWebhookAdapter.resolveAccessTokenForPortal({
        tenantModels,
        portalId,
      });

      if (!resolved?.token) {
        logger.warn({
          msg: 'Webhook failure note skipped: no HubSpot credentials for tenant',
          eventId: String(event?._id),
        });
        return;
      }

      const note = await hubspotClient.createNote(resolved.token, { body: lastError });
      await hubspotClient.associateObjectsDefault(resolved.token, 'note', note.id, 'deal', dealId);

      if (revertStage && config.requiereReturnStage && config.stageToReturned) {
        await hubspotClient.updateDeal(resolved.token, dealId, {
          properties: { dealstage: config.stageToReturned },
        });
      }
    } catch (error) {
      logger.error({
        msg: 'Failed to notify webhook failure to HubSpot',
        eventId: String(event?._id),
        error: error.message,
      });
    }
  };
}

export default { buildNotifyWebhookFailure };
