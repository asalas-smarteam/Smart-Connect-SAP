import { toNonEmptyString } from '../../shared/utils/string.utils.js';

export function resolveEventPayload(event) {
  const payload = event?.payload || {};
  return {
    payload,
    deal: payload?.deal || payload?.data?.deal || null,
    company: payload?.company || payload?.data?.company || null,
    contact: payload?.contact || payload?.data?.contact || null,
    lineItems: Array.isArray(payload?.line_items)
      ? payload.line_items
      : (Array.isArray(payload?.data?.line_items) ? payload.data.line_items : []),
  };
}

export function resolveHubspotSapId(record) {
  return toNonEmptyString(record?.idsap || record?.idSap);
}

export function resolvePayloadEntityTarget(payload, entityKey) {
  if (payload?.[entityKey] && typeof payload[entityKey] === 'object') {
    return {
      container: payload,
      key: entityKey,
      path: `payload.${entityKey}`,
    };
  }

  if (payload?.data?.[entityKey] && typeof payload.data[entityKey] === 'object') {
    return {
      container: payload.data,
      key: entityKey,
      path: `payload.data.${entityKey}`,
    };
  }

  return {
    container: payload,
    key: entityKey,
    path: `payload.${entityKey}`,
  };
}

export function buildWebhookEventReferenceUpdates({
  payload,
  companyExists,
  contactExists,
  cardCode,
  contactEmployeeCode,
}) {
  const nextUpdates = {};
  const normalizedCardCode = toNonEmptyString(cardCode);
  const normalizedContactEmployeeCode = toNonEmptyString(contactEmployeeCode);

  if (normalizedCardCode) {
    if (companyExists) {
      const companyTarget = resolvePayloadEntityTarget(payload, 'company');
      companyTarget.container[companyTarget.key] = {
        ...(companyTarget.container[companyTarget.key] || {}),
        idsap: normalizedCardCode,
      };
      nextUpdates[`${companyTarget.path}.idsap`] = normalizedCardCode;
    } else if (contactExists) {
      const contactTarget = resolvePayloadEntityTarget(payload, 'contact');
      contactTarget.container[contactTarget.key] = {
        ...(contactTarget.container[contactTarget.key] || {}),
        idsap: normalizedCardCode,
      };
      nextUpdates[`${contactTarget.path}.idsap`] = normalizedCardCode;
    }
  }

  if (companyExists && contactExists && normalizedContactEmployeeCode) {
    const contactTarget = resolvePayloadEntityTarget(payload, 'contact');
    contactTarget.container[contactTarget.key] = {
      ...(contactTarget.container[contactTarget.key] || {}),
      internalCode: normalizedContactEmployeeCode,
    };
    nextUpdates[`${contactTarget.path}.internalCode`] = normalizedContactEmployeeCode;
  }

  return nextUpdates;
}

