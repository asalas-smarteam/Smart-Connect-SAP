// Deja la nota del resultado de la valorización en el negocio de HubSpot.
//
// Reutiliza el MISMO par `createNote` + `associateObjectsDefault` y la MISMA llave de
// configuración (`requireMessageHS`) que `notifyWebhookFailure`. Lo que no reutiliza es la
// resolución del token: `notifyWebhookFailure` sale de un WebhookEvent y tiene que buscar las
// credenciales por portalId, mientras que este flujo ya trae el token y el dealId en la mano
// (los usó para escribir las líneas), así que pedirlos otra vez sería una llamada extra y una
// segunda forma de fallar.
//
// Regla dura, igual que sus dos hermanos (webhookFailureNotifier, dealIntegrationStatus): NUNCA
// lanza. Corre después de que el resultado ya se decidió; un hipo de HubSpot acá no puede
// convertir una corrida exitosa en un error, ni tapar el error real de una fallida.
export function buildNotifyLineItemPriceOutcome({
  hubspotClient,
  getWebhookFailureNotificationConfig,
  logger = { warn: () => {}, error: () => {} },
}) {
  return async function notifyLineItemPriceOutcome({
    tenantModels,
    tenantKey = null,
    token,
    dealId,
    body,
  }) {
    try {
      // Sin cuerpo no hay nada que contar (el builder devuelve null cuando todo salió bien).
      // Sin token o sin dealId la nota es imposible: pasa cuando el fallo ocurrió ANTES de
      // resolver las credenciales, y ahí el error ya quedó en el SyncLog y en el WebhookEvent.
      if (!body || !token || !dealId) {
        return;
      }

      const config = await getWebhookFailureNotificationConfig({ tenantModels });

      if (!config.requireMessageHS) {
        return;
      }

      const note = await hubspotClient.createNote(token, { body });
      await hubspotClient.associateObjectsDefault(token, 'note', note.id, 'deal', dealId);
    } catch (error) {
      logger.error?.({
        msg: 'Failed to write the line item price note to the HubSpot deal',
        tenantKey,
        dealId,
        error: error.message,
      });
    }
  };
}

export default { buildNotifyLineItemPriceOutcome };
