// src/domain/batches/sources/none.strategy.js

// Null object para el tenant que no maneja lotes. Existe para que la factory
// tenga entrada para el valor por default y nunca lance; el enricher corta
// antes de invocarla, asi que en la practica no produce datos.
export class NoneBatchSourceStrategy {
  normalizeConfig() {
    return { warehouses: [], stockTypes: [], includeExpired: false, horizonDays: 0 };
  }

  requiresRemoteFetch() {
    return false;
  }

  buildQueryTargets() {
    return [];
  }

  buildIndex() {
    return new Map();
  }

  resolveBatches() {
    return [];
  }
}

export default NoneBatchSourceStrategy;
