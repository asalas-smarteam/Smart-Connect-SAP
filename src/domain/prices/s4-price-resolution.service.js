import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// Tablas de condición de ZPR0, verificadas en vivo contra el S/4 de Multiquímica el
// 2026-08-18: la 502 lleva PriceListType en la clave (precio por lista de precios); la 501 y
// la 504 no lo llevan (precio por defecto del producto, por organización de ventas y canal).
export const PRICE_LIST_CONDITION_TABLES = Object.freeze(['502']);
export const PRODUCT_DEFAULT_CONDITION_TABLES = Object.freeze(['501', '504']);

export const S4_PRICE_SOURCES = Object.freeze({
  CUSTOMER_PRICE_LIST: 'customerPriceList',
  DEFAULT_PRICE_LIST: 'defaultPriceList',
  PRODUCT_DEFAULT: 'productDefault',
});

// Un registro borrado puede seguir vigente por fechas: el 0000177449 de material 80000017 lo
// está. Y una tarifa en cero es "sin precio", igual que la trata la reconciliación del flujo
// B1, no un producto gratis.
function isUsable(candidate) {
  return candidate?.conditionIsDeleted !== true
    && normalizeNumber(candidate?.conditionRateValue, 0) > 0;
}

function inTables(candidate, tables) {
  return tables.includes(String(candidate?.conditionTable ?? '').trim());
}

function pickByPriceList(candidates, priceListType) {
  const wanted = toNonEmptyString(priceListType);

  if (!wanted) {
    return null;
  }

  return candidates.find(
    (candidate) => inTables(candidate, PRICE_LIST_CONDITION_TABLES)
      && toNonEmptyString(candidate.priceListType) === wanted
  ) ?? null;
}

// Un material puede tener default de producto en la 501 Y en la 504 con tarifas distintas. Con
// un solo `find` sobre el arreglo ganaba el que Gateway devolviera primero, así que el precio
// escrito en el CRM no era reproducible. La prioridad es explícita y es el orden de declaración
// de PRODUCT_DEFAULT_CONDITION_TABLES: primero la 501, después la 504. Se recorre tabla por
// tabla (no candidato por candidato) justamente para que el orden que manda sea el de las tablas
// y no el de la respuesta.
function pickProductDefault(candidates) {
  for (const table of PRODUCT_DEFAULT_CONDITION_TABLES) {
    const match = candidates.find(
      (candidate) => inTables(candidate, [table])
        && !toNonEmptyString(candidate.priceListType)
    );

    if (match) {
      return match;
    }
  }

  return null;
}

// La tarifa viene "por N unidades" (hay registros de 2700 USD por 1000 KG), así que el precio
// unitario es siempre rate/quantity. Un ConditionQuantity ausente o no positivo se toma como 1
// para no dividir por cero.
function toUnitPrice(candidate) {
  const quantity = normalizeNumber(candidate.conditionQuantity, 1);
  const divisor = quantity > 0 ? quantity : 1;

  return normalizeNumber(candidate.conditionRateValue, 0) / divisor;
}

// Devuelve el precio unitario SIN redondear: quien escribe en HubSpot redondea a 2 decimales.
export function resolveS4PriceForMaterial({
  candidates = [],
  customerPriceListType = null,
  defaultPriceListType = null,
} = {}) {
  const usable = (Array.isArray(candidates) ? candidates : []).filter(isUsable);
  const attempts = [
    [pickByPriceList(usable, customerPriceListType), S4_PRICE_SOURCES.CUSTOMER_PRICE_LIST],
    [pickByPriceList(usable, defaultPriceListType), S4_PRICE_SOURCES.DEFAULT_PRICE_LIST],
    [pickProductDefault(usable), S4_PRICE_SOURCES.PRODUCT_DEFAULT],
  ];

  for (const [candidate, source] of attempts) {
    if (candidate) {
      return {
        price: toUnitPrice(candidate),
        currency: toNonEmptyString(candidate.conditionCurrency),
        priceListType: toNonEmptyString(candidate.priceListType),
        conditionRecord: toNonEmptyString(candidate.conditionRecord),
        // Se devuelve la unidad de la condición SIN convertir nada: el precio unitario se calcula
        // suponiendo que esta unidad es la unidad base del producto. La suposición no se puede
        // verificar acá, así que al menos viaja al audit para poder reconstruir después de dónde
        // salió un precio raro.
        conditionQuantityUnit: toNonEmptyString(candidate.conditionQuantityUnit),
        source,
      };
    }
  }

  return null;
}

export default resolveS4PriceForMaterial;
