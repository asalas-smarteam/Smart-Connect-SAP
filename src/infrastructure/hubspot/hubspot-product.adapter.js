import {
  batchCreateProducts,
  batchReadProductsBySku,
  batchUpdateProducts,
  createProduct,
  findProductBySKU,
  updateProduct,
} from './hubspotClient.js';

export const hubspotProductAdapter = Object.freeze({
  batchCreateProducts,
  batchReadProductsBySku,
  batchUpdateProducts,
  createProduct,
  findProductBySKU,
  updateProduct,
});

export default hubspotProductAdapter;

