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
  'InventorySpecialStockType',
  'InventoryStockType',
  'MatlWrhsStkQtyInMatlBaseUnit',
].join(',');

const enc = encodeURIComponent;

function escapeODataLiteral(value) {
  return String(value).replace(/'/g, "''");
}

// Plant is always present (a query target only exists because some field
// references that Plant); StorageLocation is only added when the target is
// not a whole-Plant wildcard, rendered as an OR group when there are several.
function buildFilter(target) {
  const conditions = [`Plant eq '${escapeODataLiteral(target.plant)}'`];

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
  // since the targets are independent Plants.
  async fetchStockRows(targets) {
    const validTargets = (Array.isArray(targets) ? targets : []).filter((target) => target?.plant);

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
