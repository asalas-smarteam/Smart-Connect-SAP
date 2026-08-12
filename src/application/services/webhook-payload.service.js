import { toNonEmptyString } from '#shared/utils/string.utils.js';

// El workflow de HubSpot puede mandar una colección como array o, por descuido
// de configuración, como objeto suelto. Envolverlo evita una clase entera de
// errores silenciosos.
function toObjectArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object');
  }

  return value && typeof value === 'object' ? [value] : [];
}

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
    // Contactos que se convierten en ContactEmployees de SAP. Solo se usa
    // cuando el tenant configura contactEmployeeSource: 'payloadArray'.
    contactEmployees: toObjectArray(payload?.contactEmployees ?? payload?.data?.contactEmployees),
    // Direcciones que se convierten en BPAddresses de SAP. La llave es
    // singular porque así la manda el workflow de HubSpot.
    bpAddress: toObjectArray(payload?.bpAddress ?? payload?.data?.bpAddress),
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

// Vía legacy de write-back: el único InternalCode que puede escribirse al contact
// del deal es el suyo, y ese solo existe cuando ese contact ES el ContactEmployee
// real (modo dealContact). Con contactEmployeeSource: 'payloadArray' los CE salen
// de payload.contactEmployees y el contact del deal no es ninguno de ellos:
// escribirle internalCodes[0] le pondría el código SAP de otra persona. En ese
// modo el write-back correcto ya lo hace updateContactEmployeeCodes, contacto por
// contacto, así que devolver undefined aquí no pierde ningún dato.
export function resolveDealContactEmployeeCode({
  dealContactIsContactEmployee,
  internalCodes,
}) {
  if (!dealContactIsContactEmployee) {
    return undefined;
  }

  return internalCodes?.[0]?.internalCode;
}

export function buildWebhookEventReferenceUpdates({
  payload,
  companyExists,
  contactExists,
  cardCode,
  contactEmployeeCode,
  // Mismo motivo que en resolveDealContactEmployeeCode, aplicado al snapshot que
  // se guarda en WebhookEvent: sin esta bandera el snapshot queda con el
  // internalCode de otro contacto colgado del contact del deal. Default false =
  // falla cerrado: un llamador que la olvide pierde una escritura opcional, no
  // corrompe el snapshot.
  dealContactIsContactEmployee = false,
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

  if (
    companyExists
    && contactExists
    && dealContactIsContactEmployee
    && normalizedContactEmployeeCode
  ) {
    const contactTarget = resolvePayloadEntityTarget(payload, 'contact');
    contactTarget.container[contactTarget.key] = {
      ...(contactTarget.container[contactTarget.key] || {}),
      internalCode: normalizedContactEmployeeCode,
    };
    nextUpdates[`${contactTarget.path}.internalCode`] = normalizedContactEmployeeCode;
  }

  return nextUpdates;
}

