// Colecciones anidadas: nunca pueden salir de un FieldMapping (el mapper copia
// valores escalares), así que se borran de la base y se asignan solo desde los
// arrays que arma el llamador.
const NESTED_COLLECTION_FIELDS = ['BPAddresses', 'ContactEmployees'];

// SAP B1 exige CardType. 'C' (cCustomer) es lo que usaba el código anterior.
const FALLBACK_CARD_TYPE = 'C';

function hasValue(value) {
  return value !== null && typeof value !== 'undefined' && value !== '';
}

function omitBlank(source) {
  const result = {};

  for (const [field, value] of Object.entries(source || {})) {
    if (hasValue(value)) {
      result[field] = value;
    }
  }

  return result;
}

export class FullMappedBusinessPartnerPayloadStrategy {
  buildCreatePayload({
    mappedBusinessPartner,
    addresses,
    contactEmployees,
    propertiesFlags,
    defaults,
    resolved,
  }) {
    // Precedencia: defaults de config -> valores mapeados de HubSpot ->
    // banderas PropertiesN (que no pueden venir de un mapping).
    const payload = {
      ...omitBlank(defaults?.BusinessPartner),
      ...omitBlank(mappedBusinessPartner),
      ...omitBlank(propertiesFlags),
    };

    for (const field of NESTED_COLLECTION_FIELDS) {
      delete payload[field];
    }

    // CardName es el único obligatorio de SAP y el adapter ya lo validó.
    payload.CardName = resolved.cardName;

    if (!hasValue(payload.CardType)) {
      payload.CardType = FALLBACK_CARD_TYPE;
    }

    if (resolved.cardCode) {
      payload.CardCode = resolved.cardCode;
      delete payload.Series;
    } else if (!hasValue(payload.Series) && hasValue(resolved.defaultSeries)) {
      payload.Series = resolved.defaultSeries;
    }

    // hasValue y no truthiness: PriceListNum 0 y PayTermsGrpCode 0 son valores
    // válidos en SAP B1.
    if (!hasValue(payload.PriceListNum) && hasValue(resolved.priceListNum)) {
      payload.PriceListNum = resolved.priceListNum;
    }

    if (!hasValue(payload.PayTermsGrpCode) && hasValue(resolved.payTermsGrpCode)) {
      payload.PayTermsGrpCode = resolved.payTermsGrpCode;
    }

    if (Array.isArray(addresses) && addresses.length > 0) {
      payload.BPAddresses = addresses;
    }

    if (Array.isArray(contactEmployees) && contactEmployees.length > 0) {
      payload.ContactEmployees = contactEmployees;
    }

    return payload;
  }

  includesContactEmployeesInCreate() {
    return true;
  }
}

export default FullMappedBusinessPartnerPayloadStrategy;
