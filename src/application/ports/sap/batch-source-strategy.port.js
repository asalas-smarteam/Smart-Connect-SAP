// src/application/ports/sap/batch-source-strategy.port.js
import { createPort } from '../port-validator.js';

// Interfaz uniforme que implementa toda fuente de lotes, para que
// BatchExpiryEnrichmentAdapter maneje S/4 (y manana B1, donde los lotes vienen
// por BatchNumberDetails del Service Layer) sin saber cual le dio la factory.
export const BatchSourceStrategyPort = createPort({
  name: 'BatchSourceStrategyPort',
  methods: [
    // valor crudo del Configuration -> forma interna de la estrategia
    'normalizeConfig',
    // false en 'none'
    'requiresRemoteFetch',
    // config normalizada -> que pedirle a SAP
    'buildQueryTargets',
    // { stockRows, batchRows } -> Map<material, lote normalizado[]>
    'buildIndex',
    // { record, index } -> lote normalizado[] de ESE producto
    'resolveBatches',
  ],
});

export default BatchSourceStrategyPort;
