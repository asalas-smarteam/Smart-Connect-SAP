import { toNonEmptyString } from '#shared/utils/string.utils.js';

// Reproduce campo por campo el payload que SapWebhookOrderAdapter armaba en
// línea antes de que el armado se extrajera a strategies. NO agregues campos
// aquí: cualquier cambio de conducta va en full-mapped-bp-payload.strategy.js.
// El test tests/unit/domain/businessPartnerPayloadStrategies.test.js es la
// guardia de regresión de todos los tenants existentes.
export class LegacyWhitelistBusinessPartnerPayloadStrategy {
  buildCreatePayload({ mappedBusinessPartner, resolved }) {
    const payload = {
      CardName: resolved.cardName,
      CardType: 'C',
      CompanyPrivate: resolved.isCompanyBusinessPartner ? 'C' : 'I',
      EmailAddress: resolved.mappedEmail || '',
      Phone1: toNonEmptyString(mappedBusinessPartner?.Phone1) || undefined,
      PriceListNum: resolved.priceListNum,
      FederalTaxID: toNonEmptyString(resolved.federalTaxId) || undefined,
      Frozen: 'tNO',
      Valid: 'tYES',
    };

    // Mismo orden de decisión que el código original: CardCode si hay, y solo
    // si no hay se recurre a la Series por defecto del tenant.
    if (resolved.cardCode) {
      payload.CardCode = resolved.cardCode;
    } else if (resolved.defaultSeries) {
      payload.Series = resolved.defaultSeries;
    }

    if (resolved.payTermsGrpCode !== null && typeof resolved.payTermsGrpCode !== 'undefined') {
      payload.PayTermsGrpCode = resolved.payTermsGrpCode;
    }

    // El original construía el objeto con `Phone1: ... || undefined`, y un
    // undefined explícito no viaja en el JSON del POST. Se borra la llave para
    // que el payload sea comparable con toEqual en los tests.
    for (const [field, value] of Object.entries(payload)) {
      if (typeof value === 'undefined') {
        delete payload[field];
      }
    }

    return payload;
  }

  includesContactEmployeesInCreate() {
    return false;
  }
}

export default LegacyWhitelistBusinessPartnerPayloadStrategy;
