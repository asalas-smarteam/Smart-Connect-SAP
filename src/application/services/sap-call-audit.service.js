// Fallback del grabador de tráfico SAP para construcción directa de los use cases (tests
// que no pasan por composition). Composition siempre inyecta el real
// (infrastructure/sap/sapCallRecorder.js); application no puede importar infrastructure, y
// tests/unit/architecture/hexagonalBoundaries.test.js lo verifica.
//
// No graba nada y `wrap` devuelve el adapter tal cual, así que un use case construido sin
// esta dependencia se comporta exactamente como antes de que existiera la auditoría.
export function createNoopSapCallRecorder() {
  return {
    calls: [],
    droppedCalls: 0,
    record: (_options, run) => run(),
    wrap: (adapter) => adapter,
  };
}

export default createNoopSapCallRecorder;
