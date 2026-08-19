import { INTEGRATION_STATUS_KEY_LIST } from '#domain/webhooks/integration-status.constants.js';

export const WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY = 'requireMessageHS';

export const DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG = {
  requireMessageHS: false,
  requiereReturnStage: false,
  stageToReturned: null,
  integrationStatusProperty: null,
  integrationStatusValues: null,
};

function toTrimmedOrNull(value) {
  return value ? String(value).trim() || null : null;
}

const INTEGRATION_STATUS_OFF = {
  integrationStatusProperty: null,
  integrationStatusValues: null,
};

/**
 * Falla apagado, igual que `bypassSapErrors`: la publicación de estado se activa solo con el
 * nombre de la propiedad Y los tres valores presentes. Si falta cualquiera se devuelven los dos
 * campos en `null` juntos, nunca uno solo, así el consumidor no tiene que combinar condiciones.
 * Escribir la propiedad a medias dejaría al asesor mirando un estado que no significa lo que
 * dice, y el estado es justo lo que decide si puede reenviar o si tiene que escalar.
 */
function normalizeIntegrationStatus(value) {
  const property = toTrimmedOrNull(value?.integrationStatusProperty);

  if (!property) {
    return { ...INTEGRATION_STATUS_OFF };
  }

  const rawValues = value?.integrationStatusValues;

  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    return { ...INTEGRATION_STATUS_OFF };
  }

  const values = {};

  for (const key of INTEGRATION_STATUS_KEY_LIST) {
    const normalized = toTrimmedOrNull(rawValues[key]);

    if (!normalized) {
      return { ...INTEGRATION_STATUS_OFF };
    }

    values[key] = normalized;
  }

  return { integrationStatusProperty: property, integrationStatusValues: values };
}

function normalizeWebhookFailureNotificationConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG };
  }

  const requireMessageHS = value.requireMessageHS === true || value.requireMessageHS === 'true';
  const requiereReturnStage = value.requiereReturnStage === true || value.requiereReturnStage === 'true';
  const stageToReturned = toTrimmedOrNull(value.stageToReturned);

  return {
    requireMessageHS,
    requiereReturnStage,
    stageToReturned,
    ...normalizeIntegrationStatus(value),
  };
}

/**
 * Reads the tenant `requireMessageHS` configuration used on permanent webhook
 * failures to decide whether to leave an error note on the HubSpot deal, optionally
 * move it back to a given dealstage, y qué valor publicar en la propiedad de estado
 * de integración del deal.
 */
export async function getWebhookFailureNotificationConfig({ tenantContext, tenantModels } = {}) {
  const Configuration = (tenantContext?.tenantModels ?? tenantModels)?.Configuration;

  if (typeof Configuration?.findOne !== 'function') {
    return { ...DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG };
  }

  const query = Configuration.findOne({ key: WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return normalizeWebhookFailureNotificationConfig(configuration?.value);
}

export default {
  getWebhookFailureNotificationConfig,
  WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY,
  DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG,
};
