import { isBasicEmailFormat } from '#shared/utils/email.utils.js';

export const EMAIL_BYPASS_OBJECT_TYPES = new Set(['contact', 'company']);

export async function resolveBypassEmail({
  objectType,
  tenantModels,
  bypassEmailConfigRepository,
  logger = console,
}) {
  if (!EMAIL_BYPASS_OBJECT_TYPES.has(objectType) || !bypassEmailConfigRepository) {
    return false;
  }

  try {
    return await bypassEmailConfigRepository.isBypassEmailEnabled({ tenantModels });
  } catch (error) {
    logger?.warn?.({
      msg: 'Unable to read bypassEmail tenant configuration',
      error,
    });
    return false;
  }
}

export const MISSING_EMAIL_BYPASSED_MESSAGE =
  'Missing business partner email bypassed before HubSpot sync';
export const INVALID_EMAIL_BYPASSED_MESSAGE =
  'Invalid business partner email removed before HubSpot sync';

export function applyBypassEmail({
  objectType,
  item,
  bypassEmail,
  logger = console,
  sapId = item?.properties?.idsap ?? null,
  onWarning = null,
}) {
  if (!bypassEmail || !EMAIL_BYPASS_OBJECT_TYPES.has(objectType)) {
    return false;
  }

  if (!item || typeof item !== 'object') {
    return false;
  }

  item.properties = item.properties ?? {};
  const email = String(item.properties.email ?? '').trim();

  if (!email) {
    item.properties.email = '';
    logger?.warn?.({
      msg: MISSING_EMAIL_BYPASSED_MESSAGE,
      objectType,
      sapId,
    });
    onWarning?.({
      code: 'missingEmailBypassed',
      objectType,
      sapId,
      message: MISSING_EMAIL_BYPASSED_MESSAGE,
    });
    return true;
  }

  if (isBasicEmailFormat(email)) {
    return false;
  }

  item.properties.email = '';
  logger?.warn?.({
    msg: INVALID_EMAIL_BYPASSED_MESSAGE,
    objectType,
    sapId,
    email,
  });
  onWarning?.({
    code: 'invalidEmailBypassed',
    objectType,
    sapId,
    message: INVALID_EMAIL_BYPASSED_MESSAGE,
    email,
  });
  return true;
}

export default {
  applyBypassEmail,
  resolveBypassEmail,
};
