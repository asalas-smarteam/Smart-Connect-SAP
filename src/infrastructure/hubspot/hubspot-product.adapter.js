import {
  batchCreateProducts,
  batchUpdateProducts,
  createProduct,
  findProductBySKU,
  updateProduct,
} from './hubspotClient.js';

export const hubspotProductAdapter = Object.freeze({
  batchCreateProducts,
  batchUpdateProducts,
  createProduct,
  findProductBySKU,
  updateProduct,
});

export default hubspotProductAdapter;

