import { createPort } from '../port-validator.js';

export const ProductSyncStrategyConfigPort = createPort({
  name: 'ProductSyncStrategyConfigPort',
  methods: [
    'getProductSyncStrategyConfig',
  ],
});
