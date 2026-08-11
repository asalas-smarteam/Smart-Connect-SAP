import { createPort } from '../port-validator.js';

// enrich({ mappedRecords, objectType, tenantModels }) -> void. Mutates
// mappedRecords in place (attaching data under rawSapData); never throws.
// Covers both S4ContactEnrichmentAdapter and WarehouseStockEnrichmentAdapter.
export const SapRecordEnricherPort = createPort({
  name: 'SapRecordEnricherPort',
  methods: ['enrich'],
});

export default SapRecordEnricherPort;
