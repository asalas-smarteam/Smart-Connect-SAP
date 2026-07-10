import { normalizeNumber, normalizePositiveInteger, toNonEmptyString } from '#shared/utils/string.utils.js';

export function selectPriceListRow(itemPrices, priceList) {
  const normalizedPriceList = normalizePositiveInteger(priceList);

  if (!normalizedPriceList || !Array.isArray(itemPrices)) {
    return null;
  }

  return itemPrices.find((row) => Number(row?.PriceList) === normalizedPriceList) ?? null;
}

// Una fila de ItemPrices trae hasta tres pares precio/moneda: Price/Currency es
// la moneda base de la lista (ej. QTZ) y AdditionalPrice1/AdditionalCurrency1,
// AdditionalPrice2/AdditionalCurrency2 son las monedas adicionales (ej. USD).
// El precio válido es el primer par cuya moneda coincide y cuyo precio es > 0;
// null significa que el artículo no tiene precio cargado en esa moneda.
export function getPriceForCurrency(itemPriceRow, targetCurrency) {
  const normalizedCurrency = toNonEmptyString(targetCurrency)?.toUpperCase();

  if (!itemPriceRow || !normalizedCurrency) {
    return null;
  }

  const pairs = [
    { currency: itemPriceRow.Currency, price: itemPriceRow.Price },
    { currency: itemPriceRow.AdditionalCurrency1, price: itemPriceRow.AdditionalPrice1 },
    { currency: itemPriceRow.AdditionalCurrency2, price: itemPriceRow.AdditionalPrice2 },
  ];

  const match = pairs.find(
    (pair) => toNonEmptyString(pair.currency)?.toUpperCase() === normalizedCurrency
      && normalizeNumber(pair.price, 0) > 0
  );

  return match ? normalizeNumber(match.price) : null;
}
