// src/domain/batches/sources/s4-batch-master.strategy.js
//
// S/4HANA: el lote de stock vive en A_MatlStkInAcctMod (que lo tiene como campo
// clave) y su fecha de caducidad en el maestro API_BATCH_SRV/Batch. No hay
// navegacion entre ambos -- se verifico el $metadata de API_MATERIAL_STOCK_SRV y
// A_MatlStkInAcctMod solo declara to_MaterialSerialNumber y to_MaterialStock --
// asi que son dos lecturas y un join en memoria por Material+Batch.
//
// El join NO lleva centro: se verificaron los 74,277 lotes del maestro y
// BatchIdentifyingPlant es "" en todos, o sea que el lote es unico a nivel
// material en este sistema.
import { parseS4WarehouseCode } from '#domain/warehouses/strategies/s4-plant-storage-location.strategy.js';
import {
  BATCH_STATUS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_BATCH_STOCK_TYPES,
} from '../batch-expiry.constants.js';
import { classifyBatch, sortBatches, roundQuantity } from '../batch-expiry.service.js';

// Gateway serializa Edm.DateTime como "/Date(1766707200000)/", PERO el
// transporte ya lo convirtio a ISO-8601 antes de que la fila llegue aca
// (odataV2Normalizer.normalizeODataV2Scalar corre dentro de fetchAll), asi que
// en produccion la forma cruda NUNCA se ve: la real es "2030-11-01T00:00:00.000Z".
// Se aceptan las dos porque cualquiera de las dos capas puede cambiar, y porque
// aceptar solo la cruda es exactamente lo que dejo todas las fechas en null en
// la primera corrida contra el S/4 de QA.
export function parseODataDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value ?? '').trim();

  if (!raw) {
    return null;
  }

  const match = /\/Date\((-?\d+)/.exec(raw);

  if (match) {
    const date = new Date(Number(match[1]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Se exige forma ISO en vez de dejar adivinar a new Date(): new Date('1160.000')
  // no es invalida, es el ano 1160, asi que un campo mal ruteado (una cantidad,
  // por ejemplo) se leeria como un lote vencido hace nueve siglos en vez de
  // quedar como "sin fecha".
  if (!/^\d{4}-\d{2}-\d{2}([T\s]|$)/.test(raw)) {
    return null;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeBatchExpiryConfig(rawValue) {
  const value = rawValue && typeof rawValue === 'object' ? rawValue : {};

  const warehouses = (Array.isArray(value.warehouses) ? value.warehouses : [])
    .map((entry) => parseS4WarehouseCode(entry))
    .filter(Boolean);

  const stockTypes = [...new Set(
    (Array.isArray(value.stockTypes) ? value.stockTypes : [])
      .map((code) => String(code ?? '').trim())
      .filter(Boolean)
  )];

  const horizonDays = Number.isFinite(Number(value.horizonDays)) && Number(value.horizonDays) >= 0
    ? Number(value.horizonDays)
    : DEFAULT_HORIZON_DAYS;

  return {
    warehouses,
    stockTypes: stockTypes.length > 0 ? stockTypes : [...DEFAULT_BATCH_STOCK_TYPES],
    includeExpired: value.includeExpired === true,
    horizonDays,
  };
}

// Bodegas vacias = todas. Es lo que permite que la config de lotes sea
// autonoma de fieldsWareHouseHS: un tenant puede querer fechas de vencimiento
// sin haber configurado ni una propiedad de stock por bodega.
function isWarehouseInScope(warehouses, { plant, storageLocation }) {
  if (warehouses.length === 0) {
    return true;
  }

  return warehouses.some((scope) => scope.plant === plant
    && (scope.storageLocation === null || scope.storageLocation === storageLocation));
}

// Agrupa por centro para que el resolver haga exactamente un fetchAll por Plant,
// nunca uno por material. Mismo criterio que buildS4StockQueryTargets.
//
// Sin bodegas configuradas devuelve UN target explicito de todos los centros
// ({ allPlants: true }), no []. Es la mitad de "bodegas vacias = todas" que le
// toca al fetch: devolver [] hacia que el resolver no hiciera ni una llamada,
// el indice saliera vacio y la proyeccion escribiera las siete propiedades en
// blanco sobre los 8,080 productos -- justo lo contrario de lo que promete la
// config recomendada. El marcador es explicito a proposito: "target sin plant"
// sigue significando configuracion malformada, no "todos los centros".
export function buildBatchQueryTargets(config) {
  const byPlant = new Map();

  for (const scope of config?.warehouses ?? []) {
    if (!byPlant.has(scope.plant)) {
      byPlant.set(scope.plant, { wildcard: false, locations: new Set() });
    }

    const target = byPlant.get(scope.plant);

    if (scope.storageLocation === null) {
      target.wildcard = true;
    } else {
      target.locations.add(scope.storageLocation);
    }
  }

  if (byPlant.size === 0) {
    return [{ plant: null, storageLocations: null, allPlants: true }];
  }

  return [...byPlant.entries()].map(([plant, target]) => ({
    plant,
    storageLocations: target.wildcard ? null : [...target.locations],
  }));
}

export function buildBatchIndex({ stockRows, batchRows }, { config, now }) {
  const dateByKey = new Map();

  for (const row of Array.isArray(batchRows) ? batchRows : []) {
    const material = String(row?.Material ?? '').trim();
    const batch = String(row?.Batch ?? '').trim();

    if (material && batch) {
      dateByKey.set(`${material}|${batch}`, {
        expirationDate: parseODataDate(row?.ShelfLifeExpirationDate),
        manufactureDate: parseODataDate(row?.ManufactureDate),
      });
    }
  }

  const byMaterial = new Map();

  for (const row of Array.isArray(stockRows) ? stockRows : []) {
    const material = String(row?.Material ?? '').trim();
    const batch = String(row?.Batch ?? '').trim();

    if (!material || !batch) {
      continue;
    }

    // Stock especial: consignacion, subcontratacion, stock de cliente. No es
    // inventario propio y sumarlo inflaria lo que el vendedor cree tener.
    if (String(row?.InventorySpecialStockType ?? '').trim()) {
      continue;
    }

    if (!config.stockTypes.includes(String(row?.InventoryStockType ?? '').trim())) {
      continue;
    }

    const plant = String(row?.Plant ?? '').trim().toUpperCase();
    const storageLocation = String(row?.StorageLocation ?? '').trim();

    if (!plant || !isWarehouseInScope(config.warehouses, { plant, storageLocation })) {
      continue;
    }

    const quantity = Number(row?.MatlWrhsStkQtyInMatlBaseUnit ?? 0) || 0;

    if (quantity <= 0) {
      continue;
    }

    if (!byMaterial.has(material)) {
      byMaterial.set(material, new Map());
    }

    const batchesOfMaterial = byMaterial.get(material);

    if (!batchesOfMaterial.has(batch)) {
      const dates = dateByKey.get(`${material}|${batch}`) ?? {
        expirationDate: null, manufactureDate: null,
      };
      batchesOfMaterial.set(batch, {
        batch,
        expirationDate: dates.expirationDate,
        manufactureDate: dates.manufactureDate,
        quantity: 0,
        locations: [],
      });
    }

    const entry = batchesOfMaterial.get(batch);
    entry.quantity += quantity;

    // Un lote puede estar en varios almacenes con la misma fecha (es unico a
    // nivel material). Se consolida en una entrada y las bodegas se listan.
    const location = entry.locations.find(
      (item) => item.plant === plant && item.storageLocation === storageLocation
    );

    if (location) {
      location.quantity += quantity;
    } else {
      entry.locations.push({ plant, storageLocation, quantity });
    }
  }

  const index = new Map();

  for (const [material, batchesOfMaterial] of byMaterial) {
    const batches = [...batchesOfMaterial.values()].map((entry) => ({
      ...entry,
      quantity: roundQuantity(entry.quantity),
      locations: entry.locations.map((location) => ({
        ...location,
        quantity: roundQuantity(location.quantity),
      })),
      ...classifyBatch({
        expirationDate: entry.expirationDate,
        now,
        horizonDays: config.horizonDays,
      }),
    }));

    index.set(material, sortBatches(batches));
  }

  return index;
}

export class S4BatchMasterStrategy {
  normalizeConfig(rawValue) {
    return normalizeBatchExpiryConfig(rawValue);
  }

  requiresRemoteFetch() {
    return true;
  }

  buildQueryTargets(config) {
    return buildBatchQueryTargets(config);
  }

  buildIndex({ stockRows, batchRows }, { config, now } = {}) {
    return buildBatchIndex({ stockRows, batchRows }, { config, now: now ?? new Date() });
  }

  resolveBatches({ record, index }) {
    const material = String(record?.rawSapData?.Product ?? '').trim();
    return (index instanceof Map ? index.get(material) : null) ?? [];
  }
}

export { BATCH_STATUS };
export default S4BatchMasterStrategy;
