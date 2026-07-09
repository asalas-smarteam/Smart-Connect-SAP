import { normalizePositiveInteger, toNonEmptyString } from '#shared/utils/string.utils.js';

// La config "priceList" del tenant debe ser un mapa por moneda:
//   { "default": 4, "GTQ": 4, "USD": 5 }
// Se resuelve por la moneda solicitada y cae a "default" si la moneda no está
// o su valor es inválido. Sin moneda se usa "default" directamente.
// Los valores escalares (formato legacy "4") ya no se aceptan: cada tenant
// debe tener el mapa configurado en su collection Configurations.
export function resolvePriceListFromConfigValue(value, { currency = null } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const normalizedCurrency = toNonEmptyString(currency)?.toUpperCase() ?? null;
  const currencyEntry = normalizedCurrency
    ? Object.entries(value).find(
      ([key]) => toNonEmptyString(key)?.toUpperCase() === normalizedCurrency
    )
    : null;
  const byCurrency = currencyEntry ? normalizePositiveInteger(currencyEntry[1]) : null;

  if (byCurrency !== null) {
    return byCurrency;
  }

  return normalizePositiveInteger(value.default);
}
