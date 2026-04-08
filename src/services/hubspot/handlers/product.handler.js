import * as hubspotClient from '../../hubspotClient.js';
import { getWarehouseStockTotals } from '../../../utils/warehouseStock.js';

export async function preprocess({ item }) {
  const totals = getWarehouseStockTotals(
    item?.rawSapData?.ItemWarehouseInfoCollection
  );

  item.properties.ordered = totals.ordered;
  item.properties.committed = totals.committed;
  item.properties.instock = totals.instock;
  item.properties.available = totals.instock - totals.committed;
  item.properties.hs_price_usd = 0.0;
}

export async function find({ token, item }) {
  const sku = item?.properties?.hs_sku;

  if (!sku) {
    return null;
  }

  return hubspotClient.findProductBySKU(token, sku);
}

export async function create({ token, item }) {
  return hubspotClient.createProduct(token, item);
}

export async function update({ token, id, item }) {
  return hubspotClient.updateProduct(token, id, item);
}

export default {
  find,
  create,
  update,
  preprocess,
};
