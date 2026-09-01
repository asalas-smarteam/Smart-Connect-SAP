// SAP Business One: stock travels embedded in the Item's own
// ItemWarehouseInfoCollection, so this strategy never needs a remote fetch —
// it reads straight off the record already mapped by SyncSapConfigToHubspot.
// This is the historical logic that used to live directly in
// src/infrastructure/hubspot/warehouseStock.js; that module is now a thin
// wrapper re-exporting these functions so no existing import breaks.

import {
  B1_STOCK_METRICS,
  B1_WAREHOUSE_STOCK_FIELDS,
  DEFAULT_B1_AVAILABLE_FORMULA,
  DEFAULT_B1_STOCK_METRIC,
} from '../warehouse-stock-strategy.constants.js';

const DEFAULT_WAREHOUSE_FIELDS = [];

function resolveWarehouseCodeFromPropertyName(propertyName) {
  if (!propertyName) {
    return null;
  }

  const match = propertyName.match(/^([A-Za-z0-9]+)_stock$/i);
  return match?.[1] ?? '';
}

// Devuelve `metric: null` en vez de descartar la entrada acá, para que el
// llamador pueda reportar el propertyName y la bodega en el aviso antes de
// tirarla.
function resolveWarehouseField(field) {
  const propertyName = field?.value;

  if (!propertyName) {
    return null;
  }

  const rawWarehouseCode = field?.valueSAP || resolveWarehouseCodeFromPropertyName(propertyName);

  if (!rawWarehouseCode) {
    return null;
  }

  return {
    warehouseCode: String(rawWarehouseCode).toUpperCase(),
    propertyName,
    metric: normalizeB1StockMetric(field?.metric),
  };
}

const STOCK_FIELD_BY_LOWERCASE = new Map(
  B1_WAREHOUSE_STOCK_FIELDS.map((field) => [field.toLowerCase(), field])
);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Un lado de la formula (add o subtract). Devuelve { fields } canonicos y sin
// duplicados, o { reason } con el primer problema encontrado.
function normalizeFormulaSide(rawList, sideName) {
  if (rawList === undefined || rawList === null) {
    return { fields: [] };
  }

  if (!Array.isArray(rawList)) {
    return { reason: `${sideName}_not_an_array` };
  }

  const fields = [];

  for (const entry of rawList) {
    const trimmed = String(entry ?? '').trim();
    const canonical = STOCK_FIELD_BY_LOWERCASE.get(trimmed.toLowerCase());

    if (!canonical) {
      return { reason: `unknown_field:${trimmed}` };
    }

    if (!fields.includes(canonical)) {
      fields.push(canonical);
    }
  }

  return { fields };
}

// undefined/null -> default historico. Cualquier otra cosa se valida entera y,
// si falla, devuelve null tras avisar UNA vez con el primer motivo. No cae al
// default a proposito: un typo daria un numero plausible pero equivocado.
export function normalizeB1AvailableFormula(raw, { onInvalid } = {}) {
  if (raw === undefined || raw === null) {
    return DEFAULT_B1_AVAILABLE_FORMULA;
  }

  const invalid = (reason) => {
    onInvalid?.({ raw, reason });
    return null;
  };

  if (!isPlainObject(raw)) {
    return invalid('not_an_object');
  }

  const add = normalizeFormulaSide(raw.add, 'add');

  if (add.reason) {
    return invalid(add.reason);
  }

  const subtract = normalizeFormulaSide(raw.subtract, 'subtract');

  if (subtract.reason) {
    return invalid(subtract.reason);
  }

  const overlap = add.fields.find((field) => subtract.fields.includes(field));

  if (overlap) {
    return invalid(`field_in_both_lists:${overlap}`);
  }

  if (add.fields.length === 0 && subtract.fields.length === 0) {
    return invalid('empty_formula');
  }

  return { add: add.fields, subtract: subtract.fields };
}

function sumWarehouseFields(warehouse, fields) {
  return (Array.isArray(fields) ? fields : [])
    .reduce((total, field) => total + Number(warehouse?.[field] ?? 0), 0);
}

// Con un solo argumento da exactamente InStock - Committed + Ordered, que es lo
// que todo llamador y test existente espera. El segundo argumento es la
// formula ya normalizada (nunca la cruda de Mongo).
export function getWarehouseAvailableStock(warehouse, formula = DEFAULT_B1_AVAILABLE_FORMULA) {
  return sumWarehouseFields(warehouse, formula?.add) - sumWarehouseFields(warehouse, formula?.subtract);
}

// La comparacion es en minusculas para que el cliente pueda escribir la metrica
// tal como la ve en el JSON de SAP ("InStock") o en minusculas, sin que una u
// otra forma se descarte.
const METRIC_BY_LOWERCASE = new Map(
  Object.values(B1_STOCK_METRICS).map((metric) => [metric.toLowerCase(), metric])
);

export function normalizeB1StockMetric(raw) {
  const value = String(raw ?? '').trim();

  if (!value) {
    return DEFAULT_B1_STOCK_METRIC;
  }

  return METRIC_BY_LOWERCASE.get(value.toLowerCase()) ?? null;
}

// El default del switch es `available` a proposito: un field armado a mano sin
// metric (la forma historica, { warehouseCode, propertyName }) tiene que seguir
// dando el mismo numero que antes. Una metric invalida nunca llega hasta aca --
// normalizeB1WarehouseFields ya descarto esa entrada.
export function getWarehouseMetricValue(warehouse, metric = DEFAULT_B1_STOCK_METRIC) {
  switch (metric) {
    case B1_STOCK_METRICS.IN_STOCK:
      return Number(warehouse?.InStock ?? 0);
    case B1_STOCK_METRICS.COMMITTED:
      return Number(warehouse?.Committed ?? 0);
    case B1_STOCK_METRICS.ORDERED:
      return Number(warehouse?.Ordered ?? 0);
    default:
      return getWarehouseAvailableStock(warehouse);
  }
}

export function normalizeB1WarehouseFields(value, { onInvalidMetric } = {}) {
  if (!Array.isArray(value)) {
    return DEFAULT_WAREHOUSE_FIELDS;
  }

  const seen = new Set();
  const normalizedFields = [];

  value.forEach((field) => {
    const warehouseField = resolveWarehouseField(field);

    if (!warehouseField) {
      return;
    }

    const { warehouseCode, propertyName, metric } = warehouseField;

    if (!metric) {
      onInvalidMetric?.({ propertyName, warehouseCode, metric: field?.metric });
      return;
    }

    // La metrica entra en la clave: la misma bodega puede aportar tres
    // propiedades distintas. Para una config sin metric el valor es siempre la
    // constante 'available', asi que la clave es equivalente a la de antes y el
    // comportamiento no se mueve.
    const dedupeKey = `${warehouseCode}:${metric}:${propertyName.toLowerCase()}`;

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    normalizedFields.push({ warehouseCode, propertyName, metric });
  });

  return normalizedFields;
}

// excludedWarehouses was dead in B1 (nothing read it). Here it means: a field
// pointed at an excluded warehouse still gets its property emitted, but
// always as 0 -- the exclusion wins over whatever stock SAP reports.
export function normalizeB1ExcludedWarehouses(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((entry) => String(entry ?? '').trim().toUpperCase())
      .filter(Boolean)
  )];
}

// Bug fix vs. the original inline version: both sides of the WarehouseCode
// comparison are now uppercased (the SAP side used to be compared raw, so a
// lowercase WarehouseCode from SAP silently never matched), and the missing
// optional-chaining on field.warehouseCode no longer throws when a caller
// passes a field without one.
export function buildB1WarehouseStockProperties(
  warehouseItems,
  warehouseFields = DEFAULT_WAREHOUSE_FIELDS,
  exclusions = []
) {
  const excludedSet = new Set(exclusions);
  const warehousesByCode = new Map(
    (Array.isArray(warehouseItems) ? warehouseItems : [])
      .map((warehouse) => [String(warehouse?.WarehouseCode ?? '').toUpperCase(), warehouse])
      .filter(([warehouseCode]) => warehouseCode)
  );

  return (Array.isArray(warehouseFields) ? warehouseFields : []).reduce((acc, field) => {
    const propertyName = field?.propertyName;
    const warehouseCode = field?.warehouseCode ? String(field.warehouseCode).toUpperCase() : null;

    if (!propertyName || !warehouseCode) {
      return acc;
    }

    if (excludedSet.has(warehouseCode)) {
      acc[propertyName] = 0;
      return acc;
    }

    acc[propertyName] = getWarehouseMetricValue(
      warehousesByCode.get(warehouseCode),
      field.metric
    );
    return acc;
  }, {});
}

export function getAvailableStockForB1Warehouse(warehouseItems, warehouseCode) {
  if (!warehouseCode) {
    return 0;
  }

  const normalized = String(warehouseCode).toUpperCase();
  const warehouse = (Array.isArray(warehouseItems) ? warehouseItems : []).find(
    (item) => String(item?.WarehouseCode ?? '').toUpperCase() === normalized
  );

  return getWarehouseAvailableStock(warehouse);
}

export class B1ItemWarehouseStrategy {
  normalizeFields(rawValue, options) {
    return normalizeB1WarehouseFields(rawValue, options);
  }

  normalizeExclusions(rawValue) {
    return normalizeB1ExcludedWarehouses(rawValue);
  }

  requiresRemoteFetch() {
    return false;
  }

  // Nothing to fetch remotely: stock is already embedded in rawSapData.
  buildQueryTargets() {
    return [];
  }

  // Unused when requiresRemoteFetch() is false; kept so the strategy still
  // satisfies WarehouseStockStrategyPort.
  buildIndex() {
    return new Map();
  }

  buildProperties({ record, fields, exclusions = [] }) {
    return buildB1WarehouseStockProperties(
      record?.rawSapData?.ItemWarehouseInfoCollection,
      fields,
      exclusions
    );
  }
}

export default B1ItemWarehouseStrategy;
