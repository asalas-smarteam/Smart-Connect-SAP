// Resolves S/4 material stock for a set of query targets (one entry per
// Plant, from WarehouseStockStrategy.buildQueryTargets). Mirrors
// S4ContactResolver: batched fetches instead of one call per product -- with
// 8080 products and 10k+ stock rows, a per-material lookup would mean either
// an unworkable OR-filter or thousands of requests.
export const MATERIAL_STOCK_PATH = '/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod';

export const MATERIAL_STOCK_SELECT = [
  'Material',
  'Plant',
  'StorageLocation',
  // Campo clave de A_MatlStkInAcctMod. La estrategia de stock por bodega suma
  // sobre el (y por eso no lo pedia); la de lotes lo necesita para el join
  // contra el maestro de API_BATCH_SRV.
  'Batch',
  'InventorySpecialStockType',
  'InventoryStockType',
  'MatlWrhsStkQtyInMatlBaseUnit',
].join(',');

const enc = encodeURIComponent;

function escapeODataLiteral(value) {
  return String(value).replace(/'/g, "''");
}

// An EXPLICIT all-plants target: `{ allPlants: true }`. It is the only way to
// ask for every centre, and it is a deliberate marker rather than an inference
// -- a target that merely lacks a plant stays a malformed configuration and is
// still ignored (see fetchStockRows). Measured live against S/4 QA on
// 2026-08-13: the unfiltered query returns 10,125 rows in about one second.
export function isAllPlantsTarget(target) {
  return target?.allPlants === true;
}

// Plant is present on every warehouse-stock target (a query target only exists
// because some field references that Plant) and absent only on the explicit
// all-plants marker; StorageLocation is only added when the target is not a
// whole-Plant wildcard, rendered as an OR group when there are several.
function buildFilter(target) {
  const conditions = isAllPlantsTarget(target)
    ? []
    : [`Plant eq '${escapeODataLiteral(target.plant)}'`];

  if (Array.isArray(target.storageLocations) && target.storageLocations.length > 0) {
    const members = target.storageLocations.map(
      (code) => `StorageLocation eq '${escapeODataLiteral(code)}'`
    );
    conditions.push(members.length === 1 ? members[0] : `(${members.join(' or ')})`);
  }

  conditions.push('MatlWrhsStkQtyInMatlBaseUnit gt 0');

  return conditions.join(' and ');
}

export class S4StockResolver {
  constructor({ transport }) {
    if (!transport) {
      throw new Error('transport is required for S4StockResolver');
    }
    this.transport = transport;
  }

  // targets: [{ plant, storageLocations: string[] | null }] -> flat row[].
  // One fetchAll per target (each already auto-paginates), run concurrently
  // since the targets are independent Plants. A target with neither a plant nor
  // the explicit all-plants marker is a malformed configuration and is dropped.
  async fetchStockRows(targets) {
    const validTargets = (Array.isArray(targets) ? targets : [])
      .filter((target) => target?.plant || isAllPlantsTarget(target));

    if (validTargets.length === 0) {
      return [];
    }

    const rowsByTarget = await Promise.all(
      validTargets.map((target) => this.transport.fetchAll({
        path: MATERIAL_STOCK_PATH,
        query: {
          $select: MATERIAL_STOCK_SELECT,
          $filter: enc(buildFilter(target)),
        },
      }))
    );

    return rowsByTarget.flat().filter(Boolean);
  }
}

export default S4StockResolver;
