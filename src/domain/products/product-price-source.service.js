import { selectPriceListRow } from '#domain/prices/price-currency.service.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';
import {
  DEFAULT_PRODUCT_PRICE_FIELD,
  DEFAULT_PRODUCT_PRICE_SOURCE,
  DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE,
  PRODUCT_PRICE_SOURCES,
  PRODUCT_SYNC_ON_MISSING_PRICE,
} from './product-sync-strategy.constants.js';

// Normaliza requirePrice.source. Ausente, vacio o con un valor desconocido =>
// 'mapped', que es la ruta historica. Esto es lo que garantiza que el tenant
// productivo (sin la llave `source`) no cambie de comportamiento.
export function normalizeProductPriceSource(requirePrice, { logger = null } = {}) {
  const source = requirePrice?.source;
  const rawFrom = toNonEmptyString(source?.from);
  const from = Object.values(PRODUCT_PRICE_SOURCES).includes(rawFrom)
    ? rawFrom
    : DEFAULT_PRODUCT_PRICE_SOURCE;

  if (rawFrom && from !== rawFrom) {
    logger?.warn?.({
      msg: 'requirePrice.source.from no soportado; se usa el default',
      from: rawFrom,
      fallback: DEFAULT_PRODUCT_PRICE_SOURCE,
      supported: Object.values(PRODUCT_PRICE_SOURCES),
    });
  }

  // Solo SET_ZERO esta implementado. SKIP_PRODUCT y THROW_ERROR se aceptan en la
  // config para que su forma quede estable, pero caen a SET_ZERO con aviso:
  // saltarse un producto exigiria filtrar records antes del envio, y abortar la
  // corrida exigiria decidir el efecto sobre el SyncLog.
  const rawOnMissing = toNonEmptyString(source?.onMissingPrice);
  const onMissingPrice = rawOnMissing === PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO
    ? PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO
    : DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE;

  if (rawOnMissing && rawOnMissing !== onMissingPrice) {
    logger?.warn?.({
      msg: 'requirePrice.source.onMissingPrice todavia no esta implementado; se usa SET_ZERO',
      onMissingPrice: rawOnMissing,
      fallback: DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE,
    });
  }

  return {
    from,
    priceField: toNonEmptyString(source?.priceField) || DEFAULT_PRODUCT_PRICE_FIELD,
    onMissingPrice,
  };
}

// Devuelve { row, price } o null. null significa "no hay precio para esta
// lista", que el llamador traduce a SET_ZERO.
//
// Un Price de 0 cuenta como SIN precio, no como precio cero: en B1 una lista de
// precios sin tarifa cargada para el articulo trae 0.0 con Currency null (ver
// las listas 3..10 del payload del tenant). Devolver 0 como si fuera un precio
// valido escribiria un cero "confirmado" en HubSpot y taparia el caso a revisar.
export function resolveProductPriceFromItemPrices({
  itemPrices,
  priceList,
  priceField = DEFAULT_PRODUCT_PRICE_FIELD,
}) {
  const row = selectPriceListRow(itemPrices, priceList);

  if (!row) {
    return null;
  }

  const price = normalizeNumber(row[priceField], null);

  if (price === null || price <= 0) {
    return null;
  }

  return { row, price };
}

export default { normalizeProductPriceSource, resolveProductPriceFromItemPrices };
