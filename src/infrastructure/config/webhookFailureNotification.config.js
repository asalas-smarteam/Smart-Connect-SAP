export const WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY = 'requireMessageHS';

export const DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG = {
  requireMessageHS: false,
  requiereReturnStage: false,
  stageToReturned: null,
};

function normalizeWebhookFailureNotificationConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG };
  }

  const requireMessageHS = value.requireMessageHS === true || value.requireMessageHS === 'true';
  const requiereReturnStage = value.requiereReturnStage === true || value.requiereReturnStage === 'true';
  const stageToReturned = value.stageToReturned ? String(value.stageToReturned).trim() || null : null;

  return { requireMessageHS, requiereReturnStage, stageToReturned };
}

/**
 * Reads the tenant `requireMessageHS` configuration used on permanent webhook
 * failures to decide whether to leave an error note on the HubSpot deal and,
 * optionally, move it back to a given dealstage.
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
