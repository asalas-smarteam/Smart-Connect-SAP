import { createPort } from '../port-validator.js';

// Uniform interface every warehouse-stock strategy implements, so
// WarehouseStockEnrichmentAdapter can drive B1 and S/4 (and future flavors)
// without knowing which one it got from the factory.
export const WarehouseStockStrategyPort = createPort({
  name: 'WarehouseStockStrategyPort',
  methods: [
    'normalizeFields',
    'normalizeExclusions',
    'requiresRemoteFetch',
    'buildQueryTargets',
    'buildIndex',
    'buildProperties',
  ],
});

export default WarehouseStockStrategyPort;
