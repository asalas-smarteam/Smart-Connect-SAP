# Sincronización de lotes y fechas de caducidad SAP → HubSpot — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Llevar los lotes de S/4HANA y sus fechas de caducidad a propiedades del producto en HubSpot, para que el vendedor vea qué lote empujar antes de que venza.

**Architecture:** Dos ejes de variación con puerto y factory cada uno — *fuente* (de dónde salen los lotes en SAP) y *proyección* (cómo se representan en HubSpot) — unidos por una forma normalizada intermedia. Un enricher orquesta config → fuente → servicio de dominio puro → proyección, y adjunta el resultado bajo `_batchExpiry` en `rawSapData` para que `product.handler.js` lo copie. Espejo estructural exacto de `warehouseStockStrategy`, que ya está en producción.

**Tech Stack:** Node.js ESM, Jest (`NODE_OPTIONS=--experimental-vm-modules`), Mongoose (modelos por tenant), OData v2 sobre `S4GatewayTransport`.

**Spec:** [2026-08-13-batch-expiry-sync-design.md](../specs/2026-08-13-batch-expiry-sync-design.md)

## Global Constraints

- **Ningún mapeo ni configuración se escribe en Mongo desde este trabajo.** Los documentos se entregan en la Tarea 9 y el usuario los inserta a mano.
- **Imports de `src/` usan los alias de `package.json`**: `#domain/*`, `#application/*`, `#infrastructure/*`, `#composition/*`. Los tests usan rutas relativas (`../../../src/...`).
- **Comando de test**: `npm test` (equivale a `NODE_OPTIONS=--experimental-vm-modules jest`). Para un archivo: `npm test -- tests/unit/domain/archivo.test.js`.
- **Línea base conocida de fallos previos**: 6 suites / 12 tests (`sendMappedItemsToHubspot`, `lineItemPriceWebhook.service`, `syncLineItemPrices`, `serviceLayerService`, `serviceLayerFlow`, `integration/internalTenant`). Cualquier otra suite en rojo es regresión introducida por este plan.
- **Nunca usar `Date.now()` dentro del dominio.** El instante actual se inyecta como parámetro `now`, o los tests son irreproducibles.
- **Default global `source: 'none'`**: los tenants B1 existentes (amc, distelsa, noelito, printer) no deben ver ni una llamada extra ni una propiedad nueva.
- **Idempotencia**: las cantidades se redondean a `QUANTITY_DECIMALS` (3). Sin esto, `12.000000000000002` hace que los 8,080 productos se "actualicen" cada noche para siempre.
- **Commits**: uno por tarea, en la rama de trabajo. Nunca en `main`.

---

### Task 1: Constantes y servicio de dominio puro

El corazón del cálculo, sin red ni Mongo. Todo lo demás se apoya en esto.

**Files:**
- Create: `src/domain/batches/batch-expiry.constants.js`
- Create: `src/domain/batches/batch-expiry.service.js`
- Test: `tests/unit/domain/batchExpiry.service.test.js`

**Interfaces:**
- Consumes: `QUANTITY_DECIMALS` de `#domain/warehouses/warehouse-stock-strategy.constants.js` (se importa en vez de duplicarse: es la misma precisión de cantidad en unidad base de SAP y el repo ya penalizó constantes duplicadas).
- Produces:
  - `BATCH_EXPIRY_CONFIG_KEY`, `BATCH_SOURCE_STRATEGIES`, `BATCH_PROJECTION_STRATEGIES`, `DEFAULT_BATCH_SOURCE`, `DEFAULT_BATCH_PROJECTION`, `BATCH_EXPIRY_KEY`, `BATCH_STATUS`, `DEFAULT_HORIZON_DAYS`
  - `daysBetween(from, to) -> number`
  - `classifyBatch({ expirationDate, now, horizonDays }) -> { status, daysToExpiry }`
  - `sortBatches(batches) -> batches[]`
  - `summarizeBatches(batches) -> { proximo, cantidadPorVencer, cantidadVencida, lotesVigentes }`
  - `roundQuantity(value) -> number`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/domain/batchExpiry.service.test.js
import {
  daysBetween,
  classifyBatch,
  sortBatches,
  summarizeBatches,
  roundQuantity,
} from '../../../src/domain/batches/batch-expiry.service.js';
import { BATCH_STATUS } from '../../../src/domain/batches/batch-expiry.constants.js';

const NOW = new Date('2026-08-13T14:37:00Z');

describe('daysBetween', () => {
  it('ignora la hora del dia: compara medianoche UTC contra medianoche UTC', () => {
    expect(daysBetween(NOW, new Date('2026-08-14T00:01:00Z'))).toBe(1);
    expect(daysBetween(NOW, new Date('2026-08-13T23:59:00Z'))).toBe(0);
    expect(daysBetween(NOW, new Date('2026-08-12T23:59:00Z'))).toBe(-1);
  });
});

describe('classifyBatch', () => {
  it('sin fecha -> sinFecha, con daysToExpiry null', () => {
    expect(classifyBatch({ expirationDate: null, now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null });
  });

  it('fecha pasada -> vencido', () => {
    expect(classifyBatch({ expirationDate: new Date('2021-12-22T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.VENCIDO, daysToExpiry: -1695 });
  });

  it('hoy mismo todavia no esta vencido', () => {
    expect(classifyBatch({ expirationDate: new Date('2026-08-13T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.POR_VENCER, daysToExpiry: 0 });
  });

  it('exactamente en el horizonte cuenta como porVencer (borde inclusivo)', () => {
    expect(classifyBatch({ expirationDate: new Date('2026-11-11T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.POR_VENCER, daysToExpiry: 90 });
  });

  it('un dia despues del horizonte ya es vigente', () => {
    expect(classifyBatch({ expirationDate: new Date('2026-11-12T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.VIGENTE, daysToExpiry: 91 });
  });
});

describe('sortBatches', () => {
  it('ordena por fecha ascendente y manda los sin fecha al final', () => {
    const sorted = sortBatches([
      { batch: 'C', expirationDate: null },
      { batch: 'B', expirationDate: new Date('2026-12-01T00:00:00Z') },
      { batch: 'A', expirationDate: new Date('2026-09-01T00:00:00Z') },
    ]);

    expect(sorted.map((b) => b.batch)).toEqual(['A', 'B', 'C']);
  });

  it('no muta el arreglo original', () => {
    const input = [
      { batch: 'B', expirationDate: new Date('2026-12-01T00:00:00Z') },
      { batch: 'A', expirationDate: new Date('2026-09-01T00:00:00Z') },
    ];
    sortBatches(input);
    expect(input.map((b) => b.batch)).toEqual(['B', 'A']);
  });
});

describe('summarizeBatches', () => {
  const batches = [
    { batch: 'VIEJO', quantity: 100, status: BATCH_STATUS.VENCIDO, daysToExpiry: -900, expirationDate: new Date('2024-02-25T00:00:00Z') },
    { batch: 'PRONTO', quantity: 50, status: BATCH_STATUS.POR_VENCER, daysToExpiry: 10, expirationDate: new Date('2026-08-23T00:00:00Z') },
    { batch: 'LEJOS', quantity: 25, status: BATCH_STATUS.VIGENTE, daysToExpiry: 400, expirationDate: new Date('2027-09-17T00:00:00Z') },
    { batch: 'NADA', quantity: 7, status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null, expirationDate: null },
  ];

  it('el proximo a vencer nunca es uno vencido', () => {
    expect(summarizeBatches(batches).proximo.batch).toBe('PRONTO');
  });

  it('suma por vencer y vencida por separado', () => {
    const summary = summarizeBatches(batches);
    expect(summary.cantidadPorVencer).toBe(50);
    expect(summary.cantidadVencida).toBe(100);
  });

  it('lotes vigentes cuenta todo lo que no esta vencido', () => {
    expect(summarizeBatches(batches).lotesVigentes).toBe(3);
  });

  it('sin lotes devuelve proximo null y ceros', () => {
    expect(summarizeBatches([])).toEqual({
      proximo: null, cantidadPorVencer: 0, cantidadVencida: 0, lotesVigentes: 0,
    });
  });

  it('solo vencidos: proximo null pero cantidadVencida poblada', () => {
    const summary = summarizeBatches([batches[0]]);
    expect(summary.proximo).toBeNull();
    expect(summary.cantidadVencida).toBe(100);
  });
});

describe('roundQuantity', () => {
  it('mata el ruido de punto flotante que rompe la idempotencia', () => {
    expect(roundQuantity(4 + 4 + 4.000000000000002)).toBe(12);
    expect(roundQuantity('8600.5')).toBe(8600.5);
    expect(roundQuantity(undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- tests/unit/domain/batchExpiry.service.test.js`
Expected: FAIL — `Cannot find module '.../batch-expiry.service.js'`

- [ ] **Step 3: Escribir las constantes**

```javascript
// src/domain/batches/batch-expiry.constants.js

// Documento Configuration por tenant que decide como se leen los lotes de SAP y
// como se proyectan a HubSpot. Ver src/domain/batches/sources/ y projections/.
export const BATCH_EXPIRY_CONFIG_KEY = 'batchExpiryStrategy';

export const BATCH_SOURCE_STRATEGIES = Object.freeze({
  // Null object: el tenant no maneja lotes. Es el default, y hace que un tenant
  // sin configurar no pague ni una llamada a SAP.
  NONE: 'none',
  // S/4HANA: el maestro de lotes vive en API_BATCH_SRV, separado del stock.
  S4_BATCH_MASTER: 's4_BatchMaster',
});

export const BATCH_PROJECTION_STRATEGIES = Object.freeze({
  // Propiedades sobre el propio registro de producto. Unica opcion viable sin
  // custom objects, que son exclusivos de los tiers Enterprise de HubSpot.
  HS_PRODUCT_PROPERTIES: 'hs_ProductProperties',
});

export const DEFAULT_BATCH_SOURCE = BATCH_SOURCE_STRATEGIES.NONE;
export const DEFAULT_BATCH_PROJECTION = BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES;

// Clave bajo la que el enricher adjunta las propiedades resueltas al rawSapData
// del producto. A diferencia de WAREHOUSE_STOCK_KEY, esta clave NO se escribe
// siempre: si la fuente falla o el tenant es 'none', se omite, y product.handler
// .js deja las propiedades intactas en vez de pisarlas. Escribir vacio es una
// afirmacion ("este producto no maneja lotes") que un fallo de red no autoriza.
export const BATCH_EXPIRY_KEY = '_batchExpiry';

export const BATCH_STATUS = Object.freeze({
  VIGENTE: 'vigente',
  POR_VENCER: 'porVencer',
  VENCIDO: 'vencido',
  SIN_FECHA: 'sinFecha',
});

// Ventana por default de "por vencer", en dias.
export const DEFAULT_HORIZON_DAYS = 90;

// '01' = Libre utilizacion. Un lote en calidad ('02') o bloqueado ('04') no se
// puede vender, asi que mostrarlo bajo "aprovecha a venderlo" seria enganoso.
export const DEFAULT_BATCH_STOCK_TYPES = Object.freeze(['01']);

export default {
  BATCH_EXPIRY_CONFIG_KEY,
  BATCH_SOURCE_STRATEGIES,
  BATCH_PROJECTION_STRATEGIES,
  DEFAULT_BATCH_SOURCE,
  DEFAULT_BATCH_PROJECTION,
  BATCH_EXPIRY_KEY,
  BATCH_STATUS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_BATCH_STOCK_TYPES,
};
```

- [ ] **Step 4: Escribir el servicio de dominio**

```javascript
// src/domain/batches/batch-expiry.service.js
import { QUANTITY_DECIMALS } from '#domain/warehouses/warehouse-stock-strategy.constants.js';
import { BATCH_STATUS } from './batch-expiry.constants.js';

const MS_PER_DAY = 86400000;

// Redondeo compartido con la estrategia de stock por bodega: las cantidades
// llegan de SAP como string y sumarlas produce 12.000000000000002, que nunca
// iguala al 12 que devuelve HubSpot -> todos los productos se "actualizan"
// en cada corrida para siempre.
export function roundQuantity(value) {
  const factor = 10 ** QUANTITY_DECIMALS;
  return Math.round((Number(value) || 0) * factor) / factor;
}

// Dias calendario entre dos instantes, comparando medianoche UTC contra
// medianoche UTC. Sin esto, un lote que vence hoy a las 00:00 daria -1 dia
// si el sync corre a las 14:37.
export function daysBetween(from, to) {
  const utcDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((utcDay(to) - utcDay(from)) / MS_PER_DAY);
}

export function classifyBatch({ expirationDate, now, horizonDays }) {
  if (!(expirationDate instanceof Date) || Number.isNaN(expirationDate.getTime())) {
    return { status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null };
  }

  const daysToExpiry = daysBetween(now, expirationDate);

  if (daysToExpiry < 0) {
    return { status: BATCH_STATUS.VENCIDO, daysToExpiry };
  }

  // Borde inclusivo: un lote que vence exactamente dentro de horizonDays ya
  // entra en la ventana de accion, no queda "vigente" por un dia.
  if (daysToExpiry <= horizonDays) {
    return { status: BATCH_STATUS.POR_VENCER, daysToExpiry };
  }

  return { status: BATCH_STATUS.VIGENTE, daysToExpiry };
}

// Fecha ascendente; los lotes sin fecha van al final (no se pueden ordenar
// contra los que si la tienen, y no son accionables).
export function sortBatches(batches) {
  return [...(Array.isArray(batches) ? batches : [])].sort((a, b) => {
    const aTime = a?.expirationDate instanceof Date ? a.expirationDate.getTime() : Infinity;
    const bTime = b?.expirationDate instanceof Date ? b.expirationDate.getTime() : Infinity;

    if (aTime !== bTime) {
      return aTime - bTime;
    }

    return String(a?.batch ?? '').localeCompare(String(b?.batch ?? ''));
  });
}

// Agregados que alimentan las propiedades escalares.
//
// `proximo` IGNORA los vencidos a proposito: en este tenant el 39% de los lotes
// con stock ya vencio, algunos hace mas de cuatro anos. Si el minimo absoluto
// mandara, "el proximo a vencer" seria siempre un lote de 2021 y la propiedad
// quedaria inservible justo para el caso de uso que la motiva.
export function summarizeBatches(batches) {
  const list = Array.isArray(batches) ? batches : [];

  let cantidadPorVencer = 0;
  let cantidadVencida = 0;
  let lotesVigentes = 0;
  let proximo = null;

  for (const batch of list) {
    const quantity = Number(batch?.quantity ?? 0) || 0;

    if (batch?.status === BATCH_STATUS.VENCIDO) {
      cantidadVencida += quantity;
      continue;
    }

    lotesVigentes += 1;

    if (batch?.status === BATCH_STATUS.POR_VENCER) {
      cantidadPorVencer += quantity;
    }

    if (batch?.expirationDate instanceof Date
      && (proximo === null || batch.expirationDate < proximo.expirationDate)) {
      proximo = batch;
    }
  }

  return {
    proximo,
    cantidadPorVencer: roundQuantity(cantidadPorVencer),
    cantidadVencida: roundQuantity(cantidadVencida),
    lotesVigentes,
  };
}

export default {
  roundQuantity, daysBetween, classifyBatch, sortBatches, summarizeBatches,
};
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npm test -- tests/unit/domain/batchExpiry.service.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain/batches/batch-expiry.constants.js src/domain/batches/batch-expiry.service.js tests/unit/domain/batchExpiry.service.test.js
git commit -m "feat: add the pure batch-expiry domain service"
```

---

### Task 2: Puerto y factory de fuente, con la estrategia `none`

**Files:**
- Create: `src/application/ports/sap/batch-source-strategy.port.js`
- Create: `src/domain/batches/batch-source-strategy.factory.js`
- Create: `src/domain/batches/sources/none.strategy.js`
- Test: `tests/unit/domain/batchSourceStrategyFactory.test.js`

**Interfaces:**
- Consumes: `createPort` de `#application/ports/port-validator.js`; `BATCH_SOURCE_STRATEGIES` de la Tarea 1.
- Produces:
  - `BatchSourceStrategyPort` con métodos `normalizeConfig`, `requiresRemoteFetch`, `buildQueryTargets`, `buildIndex`, `resolveBatches`
  - `BatchSourceStrategyFactory` con `constructor({ noneStrategy, s4BatchMasterStrategy, logger })` y `getStrategy(name)`
  - `NoneBatchSourceStrategy`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/domain/batchSourceStrategyFactory.test.js
import { jest } from '@jest/globals';
import BatchSourceStrategyFactory from '../../../src/domain/batches/batch-source-strategy.factory.js';
import NoneBatchSourceStrategy from '../../../src/domain/batches/sources/none.strategy.js';
import { BATCH_SOURCE_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';
import { BatchSourceStrategyPort } from '../../../src/application/ports/sap/batch-source-strategy.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

function buildFactory(logger) {
  return new BatchSourceStrategyFactory({
    noneStrategy: new NoneBatchSourceStrategy(),
    s4BatchMasterStrategy: { marker: 's4' },
    logger,
  });
}

describe('BatchSourceStrategyFactory', () => {
  it('resuelve cada nombre declarado en las constantes', () => {
    const factory = buildFactory(console);
    expect(factory.getStrategy(BATCH_SOURCE_STRATEGIES.NONE)).toBeInstanceOf(NoneBatchSourceStrategy);
    expect(factory.getStrategy(BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER)).toEqual({ marker: 's4' });
  });

  it('recorta espacios alrededor del nombre', () => {
    expect(buildFactory(console).getStrategy('  none  ')).toBeInstanceOf(NoneBatchSourceStrategy);
  });

  it('lanza y loguea las estrategias validas cuando el nombre no existe', () => {
    const logger = { error: jest.fn() };
    expect(() => buildFactory(logger).getStrategy('inventada')).toThrow('Batch source strategy not supported: inventada');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      strategyName: 'inventada',
      validStrategies: Object.values(BATCH_SOURCE_STRATEGIES),
    }));
  });

  it('no resuelve nombres heredados de Object.prototype', () => {
    expect(() => buildFactory(console).getStrategy('constructor')).toThrow('not supported');
  });
});

describe('NoneBatchSourceStrategy', () => {
  it('cumple el puerto completo', () => {
    expect(() => assertPort(new NoneBatchSourceStrategy(), BatchSourceStrategyPort)).not.toThrow();
  });

  it('no pide nada a SAP y no devuelve lotes', () => {
    const strategy = new NoneBatchSourceStrategy();
    expect(strategy.requiresRemoteFetch()).toBe(false);
    expect(strategy.buildQueryTargets({})).toEqual([]);
    expect(strategy.buildIndex({ stockRows: [{ Material: '1' }], batchRows: [] })).toEqual(new Map());
    expect(strategy.resolveBatches({ record: {}, index: new Map() })).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- tests/unit/domain/batchSourceStrategyFactory.test.js`
Expected: FAIL — `Cannot find module '.../batch-source-strategy.factory.js'`

- [ ] **Step 3: Escribir el puerto**

```javascript
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
```

- [ ] **Step 4: Escribir la factory y la estrategia `none`**

```javascript
// src/domain/batches/batch-source-strategy.factory.js
import { BATCH_SOURCE_STRATEGIES } from './batch-expiry.constants.js';

export class BatchSourceStrategyFactory {
  constructor({ noneStrategy, s4BatchMasterStrategy, logger = console }) {
    this.strategies = {
      [BATCH_SOURCE_STRATEGIES.NONE]: noneStrategy,
      [BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER]: s4BatchMasterStrategy,
    };
    this.logger = logger;
  }

  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    // Mismo par de condiciones que WarehouseStockStrategyFactory: hasOwn para no
    // resolver 'constructor'/'toString' por la cadena de prototipos, y el truthy
    // para no devolver undefined si la strategy no se inyecto en composicion.
    const strategy = Object.hasOwn(this.strategies, normalizedStrategyName)
      && this.strategies[normalizedStrategyName];

    if (strategy) {
      return strategy;
    }

    this.logger.error?.({
      msg: 'Batch source strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(BATCH_SOURCE_STRATEGIES),
    });

    throw new Error(`Batch source strategy not supported: ${normalizedStrategyName}`);
  }
}

export default BatchSourceStrategyFactory;
```

```javascript
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
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npm test -- tests/unit/domain/batchSourceStrategyFactory.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/application/ports/sap/batch-source-strategy.port.js src/domain/batches/batch-source-strategy.factory.js src/domain/batches/sources/none.strategy.js tests/unit/domain/batchSourceStrategyFactory.test.js
git commit -m "feat: add the batch source strategy port, factory and none strategy"
```

---

### Task 3: Estrategia de fuente `s4_BatchMaster`

La pieza con más lógica del plan. Une las filas de stock (que traen `Batch`) con el maestro de lotes (que trae las fechas), consolidando por lote.

**Files:**
- Create: `src/domain/batches/sources/s4-batch-master.strategy.js`
- Test: `tests/unit/domain/s4BatchMasterStrategy.test.js`

**Interfaces:**
- Consumes: `classifyBatch`, `sortBatches`, `roundQuantity` (Tarea 1); `BATCH_STATUS`, `DEFAULT_HORIZON_DAYS`, `DEFAULT_BATCH_STOCK_TYPES` (Tarea 1); `parseS4WarehouseCode` de `#domain/warehouses/strategies/s4-plant-storage-location.strategy.js` (ya existe y ya está testeado — se reutiliza la misma gramática `"DPDO/*"` en vez de escribir un segundo parser que se desincronice).
- Produces:
  - `parseODataDate(value) -> Date | null`
  - `normalizeBatchExpiryConfig(rawValue) -> { warehouses, stockTypes, includeExpired, horizonDays }`
  - `buildBatchIndex({ stockRows, batchRows }, { config, now }) -> Map<material, lote[]>`
  - `S4BatchMasterStrategy`
- Forma normalizada que produce `resolveBatches` (el contrato con la proyección):
  ```javascript
  { batch, expirationDate, manufactureDate, quantity, locations: [{ plant, storageLocation, quantity }], status, daysToExpiry }
  ```

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/domain/s4BatchMasterStrategy.test.js
import {
  parseODataDate,
  normalizeBatchExpiryConfig,
  S4BatchMasterStrategy,
} from '../../../src/domain/batches/sources/s4-batch-master.strategy.js';
import { BATCH_STATUS } from '../../../src/domain/batches/batch-expiry.constants.js';

const NOW = new Date('2026-08-13T00:00:00Z');
const strategy = new S4BatchMasterStrategy();

// Filas reales del S/4 de QA para el material 10000289 (ANHIDRIDO FTALICO).
const STOCK_ROWS = [
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0001', Batch: '17131', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '200.000' },
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0108', Batch: '17131', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '6000.000' },
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0001', Batch: '17141', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '8600.000' },
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0201', Batch: '17141', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '1054.000' },
  { Material: '10000289', Plant: 'MQDO', StorageLocation: '0108', Batch: '24J1', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '19000.000' },
];

const BATCH_ROWS = [
  { Material: '10000289', Batch: '17131', ShelfLifeExpirationDate: '/Date(1766707200000)/', ManufactureDate: null },
  { Material: '10000289', Batch: '17141', ShelfLifeExpirationDate: '/Date(1793491200000)/', ManufactureDate: null },
  { Material: '10000289', Batch: '24J1', ShelfLifeExpirationDate: null, ManufactureDate: null },
];

function resolve(config, { stockRows = STOCK_ROWS, batchRows = BATCH_ROWS } = {}) {
  const normalized = strategy.normalizeConfig(config);
  const index = strategy.buildIndex({ stockRows, batchRows }, { config: normalized, now: NOW });
  return strategy.resolveBatches({ record: { rawSapData: { Product: '10000289' } }, index });
}

describe('parseODataDate', () => {
  it('convierte el formato /Date(ms)/ de OData v2', () => {
    expect(parseODataDate('/Date(1766707200000)/').toISOString()).toBe('2025-12-26T00:00:00.000Z');
  });

  it('devuelve null para null, vacio y basura', () => {
    expect(parseODataDate(null)).toBeNull();
    expect(parseODataDate('')).toBeNull();
    expect(parseODataDate('no es una fecha')).toBeNull();
  });

  it('deja pasar un Date que ya venga construido', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    expect(parseODataDate(date)).toBe(date);
  });
});

describe('normalizeBatchExpiryConfig', () => {
  it('aplica los defaults cuando el valor viene vacio', () => {
    expect(normalizeBatchExpiryConfig(null)).toEqual({
      warehouses: [], stockTypes: ['01'], includeExpired: false, horizonDays: 90,
    });
  });

  it('parsea las bodegas con la misma gramatica que valueSAP', () => {
    expect(normalizeBatchExpiryConfig({ warehouses: ['DPDO/*', 'MQGT/0008', 'basura/a/b'] }).warehouses)
      .toEqual([
        { plant: 'DPDO', storageLocation: null },
        { plant: 'MQGT', storageLocation: '0008' },
      ]);
  });

  it('rechaza un horizonDays no numerico o negativo y cae al default', () => {
    expect(normalizeBatchExpiryConfig({ horizonDays: 'treinta' }).horizonDays).toBe(90);
    expect(normalizeBatchExpiryConfig({ horizonDays: -5 }).horizonDays).toBe(90);
    expect(normalizeBatchExpiryConfig({ horizonDays: 0 }).horizonDays).toBe(0);
  });
});

describe('S4BatchMasterStrategy.buildQueryTargets', () => {
  it('agrupa por centro, una entrada por Plant', () => {
    const config = strategy.normalizeConfig({ warehouses: ['DPDO/0001', 'DPDO/0201', 'MQGT/0008'] });
    expect(strategy.buildQueryTargets(config)).toEqual([
      { plant: 'DPDO', storageLocations: ['0001', '0201'] },
      { plant: 'MQGT', storageLocations: ['0008'] },
    ]);
  });

  it('el comodin de un centro gana sobre la lista explicita del mismo centro', () => {
    const config = strategy.normalizeConfig({ warehouses: ['DPDO/0001', 'DPDO/*'] });
    expect(strategy.buildQueryTargets(config)).toEqual([{ plant: 'DPDO', storageLocations: null }]);
  });

  it('sin bodegas configuradas devuelve [] (el resolver traera todos los centros)', () => {
    expect(strategy.buildQueryTargets(strategy.normalizeConfig({}))).toEqual([]);
  });
});

describe('S4BatchMasterStrategy.resolveBatches', () => {
  it('consolida un lote presente en dos almacenes en una sola entrada', () => {
    const batches = resolve({ warehouses: ['DPDO/*'] });
    const lote17131 = batches.find((b) => b.batch === '17131');

    expect(lote17131.quantity).toBe(6200);
    expect(lote17131.locations).toEqual([
      { plant: 'DPDO', storageLocation: '0001', quantity: 200 },
      { plant: 'DPDO', storageLocation: '0108', quantity: 6000 },
    ]);
  });

  it('REGRESION: no mezcla centros distintos — 24J1 vive en MQDO y DPDO/* no lo alcanza', () => {
    expect(resolve({ warehouses: ['DPDO/*'] }).map((b) => b.batch)).toEqual(['17131', '17141']);
  });

  it('REGRESION: el mismo codigo de almacen en dos centros son bodegas distintas', () => {
    const rows = [
      { Material: 'X', Plant: 'DPDO', StorageLocation: '0001', Batch: 'L1', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '10' },
      { Material: 'X', Plant: 'MQDO', StorageLocation: '0001', Batch: 'L1', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '99' },
    ];
    const normalized = strategy.normalizeConfig({ warehouses: ['DPDO/0001'] });
    const index = strategy.buildIndex({ stockRows: rows, batchRows: [] }, { config: normalized, now: NOW });
    const batches = strategy.resolveBatches({ record: { rawSapData: { Product: 'X' } }, index });

    expect(batches[0].quantity).toBe(10);
  });

  it('ordena por fecha ascendente y deja el lote sin fecha al final', () => {
    const batches = resolve({ warehouses: [] });
    expect(batches.map((b) => b.batch)).toEqual(['17131', '17141', '24J1']);
    expect(batches[2].status).toBe(BATCH_STATUS.SIN_FECHA);
  });

  it('clasifica contra el now inyectado', () => {
    // 17131 vence 2025-12-26 (pasado); 17141 vence 2026-11-01, a 80 dias del
    // NOW inyectado, o sea dentro del horizonte de 90.
    const batches = resolve({ warehouses: [], horizonDays: 90 });
    expect(batches[0].status).toBe(BATCH_STATUS.VENCIDO);
    expect(batches[1].status).toBe(BATCH_STATUS.POR_VENCER);
    expect(batches[1].daysToExpiry).toBe(80);
  });

  it('fuera del horizonte el mismo lote pasa a vigente', () => {
    const batches = resolve({ warehouses: [], horizonDays: 30 });
    expect(batches[1].status).toBe(BATCH_STATUS.VIGENTE);
  });

  it('descarta stock especial (consignacion / subcontratacion)', () => {
    const rows = [{ ...STOCK_ROWS[0], InventorySpecialStockType: 'W' }];
    expect(resolve({ warehouses: [] }, { stockRows: rows })).toEqual([]);
  });

  it('descarta tipos de stock fuera de los configurados', () => {
    const rows = [{ ...STOCK_ROWS[0], InventoryStockType: '02' }];
    expect(resolve({ warehouses: [], stockTypes: ['01'] }, { stockRows: rows })).toEqual([]);
    expect(resolve({ warehouses: [], stockTypes: ['01', '02'] }, { stockRows: rows })).toHaveLength(1);
  });

  it('descarta filas sin lote y con cantidad cero', () => {
    const rows = [
      { ...STOCK_ROWS[0], Batch: '' },
      { ...STOCK_ROWS[2], MatlWrhsStkQtyInMatlBaseUnit: '0.000' },
    ];
    expect(resolve({ warehouses: [] }, { stockRows: rows })).toEqual([]);
  });

  it('un lote con stock pero ausente del maestro queda sin fecha, no se pierde', () => {
    const batches = resolve({ warehouses: ['DPDO/0001'] }, { batchRows: [] });
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.status === BATCH_STATUS.SIN_FECHA)).toBe(true);
  });

  it('un material sin lotes en el indice devuelve []', () => {
    const index = strategy.buildIndex({ stockRows: STOCK_ROWS, batchRows: BATCH_ROWS }, { config: strategy.normalizeConfig({}), now: NOW });
    expect(strategy.resolveBatches({ record: { rawSapData: { Product: 'NO_EXISTE' } }, index })).toEqual([]);
  });

  it('redondea a 3 decimales para no romper la idempotencia', () => {
    const rows = [
      { ...STOCK_ROWS[0], MatlWrhsStkQtyInMatlBaseUnit: '4' },
      { ...STOCK_ROWS[1], MatlWrhsStkQtyInMatlBaseUnit: '4.000000000000002' },
    ];
    expect(resolve({ warehouses: [] }, { stockRows: rows })[0].quantity).toBe(8);
  });

  it('requiresRemoteFetch es true', () => {
    expect(strategy.requiresRemoteFetch()).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- tests/unit/domain/s4BatchMasterStrategy.test.js`
Expected: FAIL — `Cannot find module '.../s4-batch-master.strategy.js'`

- [ ] **Step 3: Escribir la estrategia**

```javascript
// src/domain/batches/sources/s4-batch-master.strategy.js
//
// S/4HANA: el lote de stock vive en A_MatlStkInAcctMod (que lo tiene como campo
// clave) y su fecha de caducidad en el maestro API_BATCH_SRV/Batch. No hay
// navegacion entre ambos -- se verifico el $metadata de API_MATERIAL_STOCK_SRV y
// A_MatlStkInAcctMod solo declara to_MaterialSerialNumber y to_MaterialStock --
// asi que son dos lecturas y un join en memoria por Material+Batch.
//
// El join NO lleva centro: se verificaron los 74,277 lotes del maestro y
// BatchIdentifyingPlant es "" en todos, o sea que el lote es unico a nivel
// material en este sistema.
import { parseS4WarehouseCode } from '#domain/warehouses/strategies/s4-plant-storage-location.strategy.js';
import {
  BATCH_STATUS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_BATCH_STOCK_TYPES,
} from '../batch-expiry.constants.js';
import { classifyBatch, sortBatches, roundQuantity } from '../batch-expiry.service.js';

// OData v2 serializa Edm.DateTime como "/Date(1766707200000)/".
export function parseODataDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const match = /\/Date\((-?\d+)/.exec(String(value ?? ''));

  if (!match) {
    return null;
  }

  const date = new Date(Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeBatchExpiryConfig(rawValue) {
  const value = rawValue && typeof rawValue === 'object' ? rawValue : {};

  const warehouses = (Array.isArray(value.warehouses) ? value.warehouses : [])
    .map((entry) => parseS4WarehouseCode(entry))
    .filter(Boolean);

  const stockTypes = [...new Set(
    (Array.isArray(value.stockTypes) ? value.stockTypes : [])
      .map((code) => String(code ?? '').trim())
      .filter(Boolean)
  )];

  const horizonDays = Number.isFinite(Number(value.horizonDays)) && Number(value.horizonDays) >= 0
    ? Number(value.horizonDays)
    : DEFAULT_HORIZON_DAYS;

  return {
    warehouses,
    stockTypes: stockTypes.length > 0 ? stockTypes : [...DEFAULT_BATCH_STOCK_TYPES],
    includeExpired: value.includeExpired === true,
    horizonDays,
  };
}

// Bodegas vacias = todas. Es lo que permite que la config de lotes sea
// autonoma de fieldsWareHouseHS: un tenant puede querer fechas de vencimiento
// sin haber configurado ni una propiedad de stock por bodega.
function isWarehouseInScope(warehouses, { plant, storageLocation }) {
  if (warehouses.length === 0) {
    return true;
  }

  return warehouses.some((scope) => scope.plant === plant
    && (scope.storageLocation === null || scope.storageLocation === storageLocation));
}

// Agrupa por centro para que el resolver haga exactamente un fetchAll por Plant,
// nunca uno por material. Mismo criterio que buildS4StockQueryTargets.
export function buildBatchQueryTargets(config) {
  const byPlant = new Map();

  for (const scope of config?.warehouses ?? []) {
    if (!byPlant.has(scope.plant)) {
      byPlant.set(scope.plant, { wildcard: false, locations: new Set() });
    }

    const target = byPlant.get(scope.plant);

    if (scope.storageLocation === null) {
      target.wildcard = true;
    } else {
      target.locations.add(scope.storageLocation);
    }
  }

  return [...byPlant.entries()].map(([plant, target]) => ({
    plant,
    storageLocations: target.wildcard ? null : [...target.locations],
  }));
}

export function buildBatchIndex({ stockRows, batchRows }, { config, now }) {
  const dateByKey = new Map();

  for (const row of Array.isArray(batchRows) ? batchRows : []) {
    const material = String(row?.Material ?? '').trim();
    const batch = String(row?.Batch ?? '').trim();

    if (material && batch) {
      dateByKey.set(`${material}|${batch}`, {
        expirationDate: parseODataDate(row?.ShelfLifeExpirationDate),
        manufactureDate: parseODataDate(row?.ManufactureDate),
      });
    }
  }

  const byMaterial = new Map();

  for (const row of Array.isArray(stockRows) ? stockRows : []) {
    const material = String(row?.Material ?? '').trim();
    const batch = String(row?.Batch ?? '').trim();

    if (!material || !batch) {
      continue;
    }

    // Stock especial: consignacion, subcontratacion, stock de cliente. No es
    // inventario propio y sumarlo inflaria lo que el vendedor cree tener.
    if (String(row?.InventorySpecialStockType ?? '').trim()) {
      continue;
    }

    if (!config.stockTypes.includes(String(row?.InventoryStockType ?? '').trim())) {
      continue;
    }

    const plant = String(row?.Plant ?? '').trim().toUpperCase();
    const storageLocation = String(row?.StorageLocation ?? '').trim();

    if (!plant || !isWarehouseInScope(config.warehouses, { plant, storageLocation })) {
      continue;
    }

    const quantity = Number(row?.MatlWrhsStkQtyInMatlBaseUnit ?? 0) || 0;

    if (quantity <= 0) {
      continue;
    }

    if (!byMaterial.has(material)) {
      byMaterial.set(material, new Map());
    }

    const batchesOfMaterial = byMaterial.get(material);

    if (!batchesOfMaterial.has(batch)) {
      const dates = dateByKey.get(`${material}|${batch}`) ?? {
        expirationDate: null, manufactureDate: null,
      };
      batchesOfMaterial.set(batch, {
        batch,
        expirationDate: dates.expirationDate,
        manufactureDate: dates.manufactureDate,
        quantity: 0,
        locations: [],
      });
    }

    const entry = batchesOfMaterial.get(batch);
    entry.quantity += quantity;

    // Un lote puede estar en varios almacenes con la misma fecha (es unico a
    // nivel material). Se consolida en una entrada y las bodegas se listan.
    const location = entry.locations.find(
      (item) => item.plant === plant && item.storageLocation === storageLocation
    );

    if (location) {
      location.quantity += quantity;
    } else {
      entry.locations.push({ plant, storageLocation, quantity });
    }
  }

  const index = new Map();

  for (const [material, batchesOfMaterial] of byMaterial) {
    const batches = [...batchesOfMaterial.values()].map((entry) => ({
      ...entry,
      quantity: roundQuantity(entry.quantity),
      locations: entry.locations.map((location) => ({
        ...location,
        quantity: roundQuantity(location.quantity),
      })),
      ...classifyBatch({
        expirationDate: entry.expirationDate,
        now,
        horizonDays: config.horizonDays,
      }),
    }));

    index.set(material, sortBatches(batches));
  }

  return index;
}

export class S4BatchMasterStrategy {
  normalizeConfig(rawValue) {
    return normalizeBatchExpiryConfig(rawValue);
  }

  requiresRemoteFetch() {
    return true;
  }

  buildQueryTargets(config) {
    return buildBatchQueryTargets(config);
  }

  buildIndex({ stockRows, batchRows }, { config, now } = {}) {
    return buildBatchIndex({ stockRows, batchRows }, { config, now: now ?? new Date() });
  }

  resolveBatches({ record, index }) {
    const material = String(record?.rawSapData?.Product ?? '').trim();
    return (index instanceof Map ? index.get(material) : null) ?? [];
  }
}

export { BATCH_STATUS };
export default S4BatchMasterStrategy;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm test -- tests/unit/domain/s4BatchMasterStrategy.test.js`
Expected: PASS, 19 tests.

- [ ] **Step 5: Verificar que la estrategia cumple el puerto**

Run: `npm test -- tests/unit/domain/batchSourceStrategyFactory.test.js`
Expected: PASS (sigue verde; el puerto no cambió).

- [ ] **Step 6: Commit**

```bash
git add src/domain/batches/sources/s4-batch-master.strategy.js tests/unit/domain/s4BatchMasterStrategy.test.js
git commit -m "feat: add the s4 batch master source strategy"
```

---

### Task 4: Puerto, factory y proyección a propiedades del producto

**Files:**
- Create: `src/application/ports/hubspot/product-batch-projection.port.js`
- Create: `src/domain/batches/batch-projection-strategy.factory.js`
- Create: `src/domain/batches/projections/product-properties.projection.js`
- Test: `tests/unit/domain/productPropertiesProjection.test.js`

**Interfaces:**
- Consumes: `summarizeBatches` (Tarea 1); `BATCH_STATUS`, `BATCH_PROJECTION_STRATEGIES` (Tarea 1); la forma normalizada de la Tarea 3.
- Produces:
  - `ProductBatchProjectionPort` con métodos `requiredProperties`, `project`
  - `BatchProjectionStrategyFactory` con `constructor({ productPropertiesProjection, logger })` y `getStrategy(name)`
  - `ProductPropertiesProjection`
  - `BATCH_PRODUCT_PROPERTIES` — descriptores que consume `tenantHubspotSeed.service.js` en la Tarea 8
  - `formatQuantity(value) -> string`, `formatDate(date) -> string`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/domain/productPropertiesProjection.test.js
import { jest } from '@jest/globals';
import ProductPropertiesProjection, {
  BATCH_PRODUCT_PROPERTIES,
  formatQuantity,
  formatDate,
} from '../../../src/domain/batches/projections/product-properties.projection.js';
import BatchProjectionStrategyFactory from '../../../src/domain/batches/batch-projection-strategy.factory.js';
import { BATCH_STATUS, BATCH_PROJECTION_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';
import { ProductBatchProjectionPort } from '../../../src/application/ports/hubspot/product-batch-projection.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const projection = new ProductPropertiesProjection();

const VENCIDO = {
  batch: '17131', expirationDate: new Date('2025-12-26T00:00:00Z'), quantity: 6200,
  locations: [
    { plant: 'DPDO', storageLocation: '0001', quantity: 200 },
    { plant: 'DPDO', storageLocation: '0108', quantity: 6000 },
  ],
  status: BATCH_STATUS.VENCIDO, daysToExpiry: -230,
};
const POR_VENCER = {
  batch: '17141', expirationDate: new Date('2026-11-01T00:00:00Z'), quantity: 9654,
  locations: [
    { plant: 'DPDO', storageLocation: '0001', quantity: 8600 },
    { plant: 'DPDO', storageLocation: '0201', quantity: 1054 },
  ],
  status: BATCH_STATUS.POR_VENCER, daysToExpiry: 80,
};
const SIN_FECHA = {
  batch: '24J1', expirationDate: null, quantity: 19000,
  locations: [{ plant: 'MQDO', storageLocation: '0108', quantity: 19000 }],
  status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null,
};

const config = { includeExpired: false, horizonDays: 90 };

describe('formatQuantity / formatDate', () => {
  it('formatea con separador de miles y 3 decimales, sin depender del ICU', () => {
    expect(formatQuantity(9654)).toBe('9,654.000');
    expect(formatQuantity(200)).toBe('200.000');
    expect(formatQuantity(1234567.5)).toBe('1,234,567.500');
  });

  it('formatea la fecha como YYYY-MM-DD en UTC', () => {
    expect(formatDate(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-01');
  });
});

describe('ProductPropertiesProjection', () => {
  it('cumple el puerto completo', () => {
    expect(() => assertPort(projection, ProductBatchProjectionPort)).not.toThrow();
  });

  it('requiredProperties declara las 7 propiedades sobre products', () => {
    const properties = projection.requiredProperties();
    expect(properties).toHaveLength(7);
    expect(properties.map((p) => p.name).sort()).toEqual([
      'cantidad_por_vencer', 'cantidad_vencida', 'dias_para_vencer',
      'fecha_vencimiento_proxima', 'lote_proximo_vencer', 'lotes_detalle', 'lotes_vigentes',
    ]);
    expect(properties.every((p) => p.objectType === 'products')).toBe(true);
    expect(properties).toBe(BATCH_PRODUCT_PROPERTIES);
  });

  it('renderiza una linea por lote con bodegas listadas', () => {
    const { lotes_detalle: detalle } = projection.project({ batches: [POR_VENCER], config });
    expect(detalle).toBe('17141 · vence 2026-11-01 · 9,654.000 · DPDO/0001, DPDO/0201');
  });

  it('marca el lote sin fecha en vez de omitirlo', () => {
    const { lotes_detalle: detalle } = projection.project({ batches: [SIN_FECHA], config });
    expect(detalle).toBe('24J1 · sin fecha · 19,000.000 · MQDO/0108');
  });

  it('con includeExpired false el detalle NO trae vencidos', () => {
    const { lotes_detalle: detalle } = projection.project({ batches: [VENCIDO, POR_VENCER], config });
    expect(detalle).not.toContain('17131');
    expect(detalle).toContain('17141');
  });

  it('con includeExpired true el detalle los trae marcados', () => {
    const { lotes_detalle: detalle } = projection.project({
      batches: [VENCIDO, POR_VENCER], config: { ...config, includeExpired: true },
    });
    expect(detalle.split('\n')[0]).toBe('17131 · VENCIDO 2025-12-26 · 6,200.000 · DPDO/0001, DPDO/0108');
  });

  it('cantidad_vencida se llena aunque includeExpired sea false', () => {
    const properties = projection.project({ batches: [VENCIDO, POR_VENCER], config });
    expect(properties.cantidad_vencida).toBe(6200);
  });

  it('fecha_vencimiento_proxima ignora los vencidos aun con includeExpired true', () => {
    const properties = projection.project({
      batches: [VENCIDO, POR_VENCER], config: { ...config, includeExpired: true },
    });
    expect(properties.lote_proximo_vencer).toBe('17141');
    expect(properties.fecha_vencimiento_proxima).toBe('2026-11-01');
    expect(properties.dias_para_vencer).toBe(80);
  });

  it('sin lotes escribe las 7 propiedades VACIAS, nunca en cero', () => {
    const properties = projection.project({ batches: [], config });
    expect(Object.keys(properties).sort()).toEqual([
      'cantidad_por_vencer', 'cantidad_vencida', 'dias_para_vencer',
      'fecha_vencimiento_proxima', 'lote_proximo_vencer', 'lotes_detalle', 'lotes_vigentes',
    ]);
    expect(Object.values(properties).every((value) => value === '')).toBe(true);
  });

  it('solo vencidos: escalares de vigencia vacios pero cantidad_vencida poblada', () => {
    const properties = projection.project({ batches: [VENCIDO], config });
    expect(properties.lote_proximo_vencer).toBe('');
    expect(properties.fecha_vencimiento_proxima).toBe('');
    expect(properties.dias_para_vencer).toBe('');
    expect(properties.cantidad_vencida).toBe(6200);
    expect(properties.lotes_vigentes).toBe(0);
  });
});

describe('BatchProjectionStrategyFactory', () => {
  it('resuelve la proyeccion a propiedades del producto', () => {
    const factory = new BatchProjectionStrategyFactory({
      productPropertiesProjection: projection, logger: console,
    });
    expect(factory.getStrategy(BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES)).toBe(projection);
  });

  it('lanza y loguea las proyecciones validas cuando el nombre no existe', () => {
    const logger = { error: jest.fn() };
    const factory = new BatchProjectionStrategyFactory({
      productPropertiesProjection: projection, logger,
    });
    expect(() => factory.getStrategy('hs_CustomObject')).toThrow('Batch projection strategy not supported: hs_CustomObject');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      validStrategies: Object.values(BATCH_PROJECTION_STRATEGIES),
    }));
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- tests/unit/domain/productPropertiesProjection.test.js`
Expected: FAIL — `Cannot find module '.../product-properties.projection.js'`

- [ ] **Step 3: Escribir el puerto y la factory**

```javascript
// src/application/ports/hubspot/product-batch-projection.port.js
import { createPort } from '../port-validator.js';

// Como se representan en HubSpot los lotes ya normalizados. Eje ORTOGONAL al de
// la fuente: el mismo s4_BatchMaster alimenta tanto propiedades del producto
// como, en un portal Enterprise, un custom object asociado.
export const ProductBatchProjectionPort = createPort({
  name: 'ProductBatchProjectionPort',
  methods: [
    // (config) -> descriptores de lo que hay que asegurar en el portal antes
    // del primer run. Una proyeccion a custom object declararia aqui su esquema.
    'requiredProperties',
    // ({ record, batches, config }) -> { [propertyName]: value }
    'project',
  ],
});

export default ProductBatchProjectionPort;
```

```javascript
// src/domain/batches/batch-projection-strategy.factory.js
import { BATCH_PROJECTION_STRATEGIES } from './batch-expiry.constants.js';

export class BatchProjectionStrategyFactory {
  constructor({ productPropertiesProjection, logger = console }) {
    this.strategies = {
      [BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES]: productPropertiesProjection,
    };
    this.logger = logger;
  }

  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    const strategy = Object.hasOwn(this.strategies, normalizedStrategyName)
      && this.strategies[normalizedStrategyName];

    if (strategy) {
      return strategy;
    }

    this.logger.error?.({
      msg: 'Batch projection strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(BATCH_PROJECTION_STRATEGIES),
    });

    throw new Error(`Batch projection strategy not supported: ${normalizedStrategyName}`);
  }
}

export default BatchProjectionStrategyFactory;
```

- [ ] **Step 4: Escribir la proyección**

```javascript
// src/domain/batches/projections/product-properties.projection.js
import { BATCH_STATUS } from '../batch-expiry.constants.js';
import { summarizeBatches } from '../batch-expiry.service.js';

// Una entrada = una propiedad a crear en el portal antes del primer run. Si
// falta cualquiera, batchCreateProducts falla el lote de 100 entero y degrada a
// secuencial: ~8,000 requests fallidos.
export const BATCH_PRODUCT_PROPERTIES = Object.freeze([
  { objectType: 'products', name: 'lotes_detalle', label: 'Lotes (detalle)', type: 'string', fieldType: 'textarea' },
  { objectType: 'products', name: 'lote_proximo_vencer', label: 'Lote próximo a vencer', type: 'string', fieldType: 'text' },
  { objectType: 'products', name: 'fecha_vencimiento_proxima', label: 'Fecha de vencimiento más próxima', type: 'date', fieldType: 'date' },
  { objectType: 'products', name: 'dias_para_vencer', label: 'Días para vencer', type: 'number', fieldType: 'number' },
  { objectType: 'products', name: 'cantidad_por_vencer', label: 'Cantidad por vencer', type: 'number', fieldType: 'number' },
  { objectType: 'products', name: 'cantidad_vencida', label: 'Cantidad vencida', type: 'number', fieldType: 'number' },
  { objectType: 'products', name: 'lotes_vigentes', label: 'Lotes vigentes', type: 'number', fieldType: 'number' },
]);

// Agrupado manual en vez de toLocaleString: el resultado de toLocaleString
// depende de como se compilo el ICU de Node, asi que el mismo codigo puede
// emitir "9,654.000" en desarrollo y "9654.000" en el contenedor -> el diff de
// idempotencia ve un cambio que no existe y reescribe todos los productos.
export function formatQuantity(value) {
  const [whole, decimals] = (Number(value) || 0).toFixed(3).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals}`;
}

// HubSpot acepta YYYY-MM-DD para propiedades de tipo date.
export function formatDate(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : '';
}

function renderLine(batch) {
  const bodegas = (batch.locations ?? [])
    .map((location) => `${location.plant}/${location.storageLocation}`)
    .join(', ');

  const fecha = batch.status === BATCH_STATUS.SIN_FECHA
    ? 'sin fecha'
    : `${batch.status === BATCH_STATUS.VENCIDO ? 'VENCIDO' : 'vence'} ${formatDate(batch.expirationDate)}`;

  return `${batch.batch} · ${fecha} · ${formatQuantity(batch.quantity)} · ${bodegas}`;
}

// Todas las propiedades se escriben SIEMPRE, con '' cuando no aplica. Omitirlas
// dejaria valores viejos de una corrida anterior en un producto que ya no tiene
// lotes; escribir 0 se leeria como "no hay stock por vencer" en vez de "este
// producto no maneja lotes". HubSpot limpia una propiedad con ''.
const EMPTY_PROPERTIES = Object.freeze(
  Object.fromEntries(BATCH_PRODUCT_PROPERTIES.map((property) => [property.name, '']))
);

export class ProductPropertiesProjection {
  requiredProperties() {
    return BATCH_PRODUCT_PROPERTIES;
  }

  project({ batches, config }) {
    const list = Array.isArray(batches) ? batches : [];

    if (list.length === 0) {
      return { ...EMPTY_PROPERTIES };
    }

    const { proximo, cantidadPorVencer, cantidadVencida, lotesVigentes } = summarizeBatches(list);

    const visibles = config?.includeExpired === true
      ? list
      : list.filter((batch) => batch.status !== BATCH_STATUS.VENCIDO);

    return {
      lotes_detalle: visibles.map(renderLine).join('\n'),
      lote_proximo_vencer: proximo?.batch ?? '',
      fecha_vencimiento_proxima: proximo ? formatDate(proximo.expirationDate) : '',
      dias_para_vencer: proximo ? proximo.daysToExpiry : '',
      cantidad_por_vencer: cantidadPorVencer,
      cantidad_vencida: cantidadVencida,
      lotes_vigentes: lotesVigentes,
    };
  }
}

export default ProductPropertiesProjection;
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npm test -- tests/unit/domain/productPropertiesProjection.test.js`
Expected: PASS, 13 tests.

Nota: el test `sin lotes escribe las 7 propiedades VACIAS` protege la decisión D10 del spec y **no debe relajarse**. Si un día falla, la causa es que alguien empezó a escribir `0`, y eso vuelve a HubSpot indistinguible entre "no hay stock por vencer" y "este producto no maneja lotes".

- [ ] **Step 6: Commit**

```bash
git add src/application/ports/hubspot/product-batch-projection.port.js src/domain/batches/batch-projection-strategy.factory.js src/domain/batches/projections/product-properties.projection.js tests/unit/domain/productPropertiesProjection.test.js
git commit -m "feat: add the batch projection port, factory and product-properties projection"
```

---

### Task 5: `S4BatchResolver` y el campo `Batch` en `S4StockResolver`

**Files:**
- Create: `src/infrastructure/sap/products/S4BatchResolver.js`
- Modify: `src/infrastructure/sap/products/S4StockResolver.js:8-15`
- Test: `tests/unit/infrastructure/s4BatchResolver.test.js`
- Test: `tests/unit/infrastructure/s4StockResolver.test.js:43-52` (ajustar la aserción del `$select`)

**Interfaces:**
- Consumes: un `transport` con `fetchAll({ path, query })` (`S4GatewayTransport`, que ya pagina por `d.__next` y agrega `$format=json`).
- Produces:
  - `BATCH_MASTER_PATH = '/API_BATCH_SRV/Batch'`
  - `BATCH_MASTER_SELECT`
  - `S4BatchResolver` con `constructor({ transport })` y `fetchBatchRows()`
  - `MATERIAL_STOCK_SELECT` ahora incluye `Batch`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/infrastructure/s4BatchResolver.test.js
import { jest } from '@jest/globals';
import { S4BatchResolver, BATCH_MASTER_PATH, BATCH_MASTER_SELECT } from '../../../src/infrastructure/sap/products/S4BatchResolver.js';

describe('S4BatchResolver', () => {
  it('exige un transport', () => {
    expect(() => new S4BatchResolver({})).toThrow('transport is required');
  });

  it('trae el maestro completo en UNA sola conversacion (no una por centro)', async () => {
    const transport = { fetchAll: jest.fn(async () => [{ Material: '10000289', Batch: '17131' }]) };
    const resolver = new S4BatchResolver({ transport });

    const rows = await resolver.fetchBatchRows();

    // El maestro de lotes no tiene centro -- BatchIdentifyingPlant es "" en los
    // 74,277 lotes de este sistema -- asi que particionarlo por Plant seria
    // imposible y por material seria el N+1 que S4ContactResolver ya evito.
    expect(transport.fetchAll).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ Material: '10000289', Batch: '17131' }]);
  });

  it('usa la ruta y el $select exactos, sin $filter', async () => {
    const transport = { fetchAll: jest.fn(async () => []) };
    await new S4BatchResolver({ transport }).fetchBatchRows();

    const call = transport.fetchAll.mock.calls[0][0];
    expect(call.path).toBe(BATCH_MASTER_PATH);
    expect(call.query.$select).toBe(BATCH_MASTER_SELECT);
    expect(call.query.$filter).toBeUndefined();
  });

  it('el $select trae material, lote y las dos fechas', () => {
    expect(BATCH_MASTER_SELECT.split(',')).toEqual([
      'Material', 'BatchIdentifyingPlant', 'Batch', 'ShelfLifeExpirationDate', 'ManufactureDate',
    ]);
  });

  it('descarta filas nulas que pueda devolver la paginacion', async () => {
    const transport = { fetchAll: jest.fn(async () => [null, { Material: 'X', Batch: 'L' }]) };
    expect(await new S4BatchResolver({ transport }).fetchBatchRows()).toEqual([{ Material: 'X', Batch: 'L' }]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- tests/unit/infrastructure/s4BatchResolver.test.js`
Expected: FAIL — `Cannot find module '.../S4BatchResolver.js'`

- [ ] **Step 3: Escribir el resolver**

```javascript
// src/infrastructure/sap/products/S4BatchResolver.js
//
// Trae el maestro de lotes de S/4 en una sola conversacion paginada. A
// diferencia de S4StockResolver -- que particiona por centro porque Plant es
// campo clave de A_MatlStkInAcctMod y filtra selectivamente en el indice ABAP --
// el maestro de lotes NO tiene centro: se verificaron los 74,277 lotes de este
// sistema y BatchIdentifyingPlant es "" en todos.
//
// Costo medido contra el S/4 de QA: 74,277 filas en 319 segundos. Es caro, y es
// deliberado: filtrar por ShelfLifeExpirationDate >= hoy bajaria a 21,397 filas
// (~90 s) pero dejaria fuera los vencidos, y la propiedad cantidad_vencida es
// justamente la senal de que hay inventario para depurar (decision D6 del spec).
export const BATCH_MASTER_PATH = '/API_BATCH_SRV/Batch';

export const BATCH_MASTER_SELECT = [
  'Material',
  // Se pide aunque hoy sea siempre "": el dia que activen lotes a nivel centro,
  // este campo deja de ser vacio y el join Material+Batch pasa a ser ambiguo.
  // Traerlo permite detectarlo en los logs en vez de sumar lotes de centros
  // distintos en silencio.
  'BatchIdentifyingPlant',
  'Batch',
  'ShelfLifeExpirationDate',
  'ManufactureDate',
].join(',');

export class S4BatchResolver {
  constructor({ transport }) {
    if (!transport) {
      throw new Error('transport is required for S4BatchResolver');
    }
    this.transport = transport;
  }

  async fetchBatchRows() {
    const rows = await this.transport.fetchAll({
      path: BATCH_MASTER_PATH,
      query: { $select: BATCH_MASTER_SELECT },
    });

    return (Array.isArray(rows) ? rows : []).filter(Boolean);
  }
}

export default S4BatchResolver;
```

- [ ] **Step 4: Agregar `Batch` al `$select` del stock**

En `src/infrastructure/sap/products/S4StockResolver.js`, agregar `'Batch',` a `MATERIAL_STOCK_SELECT` inmediatamente después de `'StorageLocation',`:

```javascript
export const MATERIAL_STOCK_SELECT = [
  'Material',
  'Plant',
  'StorageLocation',
  // Campo clave de A_MatlStkInAcctMod. La estrategia de stock por bodega suma
  // sobre el (y por eso no lo pedia); la de lotes lo necesita para el join
  // contra el maestro de API_BATCH_SRV.
  'Batch',
  'InventorySpecialStockType',
  'InventoryStockType',
  'MatlWrhsStkQtyInMatlBaseUnit',
].join(',');
```

- [ ] **Step 5: Ajustar el test existente del stock resolver**

En `tests/unit/infrastructure/s4StockResolver.test.js`, el test `usa la ruta y el $select exactos` compara contra la constante importada, así que sigue pasando. Agregar un test explícito que ancle el campo nuevo, después del test de la línea 52:

```javascript
  it('pide Batch: la estrategia de lotes hace el join contra el maestro con el', () => {
    expect(MATERIAL_STOCK_SELECT.split(',')).toContain('Batch');
  });
```

- [ ] **Step 6: Correr ambas suites y verificar que pasan**

Run: `npm test -- tests/unit/infrastructure/s4BatchResolver.test.js tests/unit/infrastructure/s4StockResolver.test.js`
Expected: PASS ambas.

- [ ] **Step 7: Verificar que la estrategia de stock por bodega no se rompió**

Run: `npm test -- tests/unit/domain/s4PlantStorageLocationStrategy.test.js tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`
Expected: PASS. `buildS4StockIndex` ignora `Batch` y suma los duplicados que solo difieren en ese campo, así que traerlo de más no cambia ningún total.

- [ ] **Step 8: Commit**

```bash
git add src/infrastructure/sap/products/S4BatchResolver.js src/infrastructure/sap/products/S4StockResolver.js tests/unit/infrastructure/s4BatchResolver.test.js tests/unit/infrastructure/s4StockResolver.test.js
git commit -m "feat: add S4BatchResolver and select Batch on the stock resolver"
```

---

### Task 6: `BatchExpiryConfigRepository`

**Files:**
- Create: `src/infrastructure/config/BatchExpiryConfigRepository.js`
- Test: `tests/unit/infrastructure/batchExpiryConfigRepository.test.js`

**Interfaces:**
- Consumes: `BATCH_EXPIRY_CONFIG_KEY`, `DEFAULT_BATCH_SOURCE`, `DEFAULT_BATCH_PROJECTION` (Tarea 1).
- Produces: `BatchExpiryConfigRepository` con `getBatchExpiryConfig({ tenantModels, tenantContext }) -> { sourceName, projectionName, rawConfig }`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/infrastructure/batchExpiryConfigRepository.test.js
import { jest } from '@jest/globals';
import BatchExpiryConfigRepository from '../../../src/infrastructure/config/BatchExpiryConfigRepository.js';
import { BATCH_SOURCE_STRATEGIES, BATCH_PROJECTION_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';

function buildTenantModels(value) {
  return {
    Configuration: {
      findOne: jest.fn(() => ({ lean: async () => (value === undefined ? null : { value }) })),
    },
  };
}

const repository = new BatchExpiryConfigRepository();

describe('BatchExpiryConfigRepository', () => {
  it('lee la configuracion del tenant', async () => {
    const tenantModels = buildTenantModels({
      source: 's4_BatchMaster', projection: 'hs_ProductProperties', warehouses: ['DPDO/*'],
    });

    const result = await repository.getBatchExpiryConfig({ tenantModels });

    expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: 'batchExpiryStrategy' });
    expect(result.sourceName).toBe(BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER);
    expect(result.projectionName).toBe(BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES);
    expect(result.rawConfig).toEqual({
      source: 's4_BatchMaster', projection: 'hs_ProductProperties', warehouses: ['DPDO/*'],
    });
  });

  it('sin documento cae al default none: cero impacto en los tenants B1', async () => {
    const result = await repository.getBatchExpiryConfig({ tenantModels: buildTenantModels(undefined) });
    expect(result.sourceName).toBe(BATCH_SOURCE_STRATEGIES.NONE);
    expect(result.rawConfig).toBeNull();
  });

  it('usa findOne directo, nunca un upsert que cree documentos vacios', async () => {
    const tenantModels = buildTenantModels(undefined);
    await repository.getBatchExpiryConfig({ tenantModels });
    expect(tenantModels.Configuration.findOne).toHaveBeenCalledTimes(1);
  });

  it('acepta el modelo por tenantContext ademas de por tenantModels', async () => {
    const tenantModels = buildTenantModels({ source: 's4_BatchMaster' });
    const result = await repository.getBatchExpiryConfig({ tenantContext: { tenantModels } });
    expect(result.sourceName).toBe(BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER);
  });

  it('NUNCA lanza: un error de lectura devuelve el default', async () => {
    const tenantModels = {
      Configuration: { findOne: jest.fn(() => { throw new Error('mongo caido'); }) },
    };

    const result = await repository.getBatchExpiryConfig({ tenantModels });

    expect(result).toEqual({
      sourceName: BATCH_SOURCE_STRATEGIES.NONE,
      projectionName: BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES,
      rawConfig: null,
    });
  });

  it('sin modelo Configuration devuelve el default', async () => {
    expect((await repository.getBatchExpiryConfig({})).sourceName).toBe(BATCH_SOURCE_STRATEGIES.NONE);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- tests/unit/infrastructure/batchExpiryConfigRepository.test.js`
Expected: FAIL — `Cannot find module '.../BatchExpiryConfigRepository.js'`

- [ ] **Step 3: Escribir el repositorio**

```javascript
// src/infrastructure/config/BatchExpiryConfigRepository.js
import {
  BATCH_EXPIRY_CONFIG_KEY,
  DEFAULT_BATCH_SOURCE,
  DEFAULT_BATCH_PROJECTION,
} from '#domain/batches/batch-expiry.constants.js';

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

export class BatchExpiryConfigRepository {
  // Nunca lanza: un fallo leyendo la config no puede detener un sync de
  // productos, solo significa que esta corrida no escribe lotes. Lee con
  // findOne directo (no con tenantConfiguration.service.js's getValue, que
  // hace upsert) para que un tenant que no configuro nada no termine con
  // documentos vacios creados por el solo hecho de correr el sync.
  async getBatchExpiryConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const rawConfig = await readConfiguration(Configuration, BATCH_EXPIRY_CONFIG_KEY);

      return {
        sourceName: String(rawConfig?.source ?? '').trim() || DEFAULT_BATCH_SOURCE,
        projectionName: String(rawConfig?.projection ?? '').trim() || DEFAULT_BATCH_PROJECTION,
        rawConfig,
      };
    } catch (error) {
      console.error('Batch expiry config read error:', error);
      return {
        sourceName: DEFAULT_BATCH_SOURCE,
        projectionName: DEFAULT_BATCH_PROJECTION,
        rawConfig: null,
      };
    }
  }
}

export default BatchExpiryConfigRepository;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm test -- tests/unit/infrastructure/batchExpiryConfigRepository.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/config/BatchExpiryConfigRepository.js tests/unit/infrastructure/batchExpiryConfigRepository.test.js
git commit -m "feat: add BatchExpiryConfigRepository"
```

---

### Task 7: `BatchExpiryEnrichmentAdapter`

**Files:**
- Create: `src/infrastructure/sap/products/BatchExpiryEnrichmentAdapter.js`
- Test: `tests/unit/infrastructure/batchExpiryEnrichmentAdapter.test.js`

**Interfaces:**
- Consumes: `BatchSourceStrategyFactory` (T2), `BatchProjectionStrategyFactory` (T4), `BatchExpiryConfigRepository` (T6), `S4StockResolver` + `S4BatchResolver` (T5), `BATCH_EXPIRY_KEY` y `BATCH_SOURCE_STRATEGIES` (T1), `createSapTransport` de `../transport/sapTransportFactory.js`, `SAP_FLAVORS` de `#domain/sap/sap-flavor.constants.js`.
- Produces: `BatchExpiryEnrichmentAdapter` con `enrich({ mappedRecords, objectType, tenantModels })`, conforme a `SapRecordEnricherPort` (que ya existe).

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/infrastructure/batchExpiryEnrichmentAdapter.test.js
import { jest } from '@jest/globals';
import BatchExpiryEnrichmentAdapter from '../../../src/infrastructure/sap/products/BatchExpiryEnrichmentAdapter.js';
import { BATCH_EXPIRY_KEY, BATCH_SOURCE_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';
import { SapRecordEnricherPort } from '../../../src/application/ports/sap/sap-record-enricher.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const STOCK_ROWS = [{ Material: '1', Batch: 'L1' }];
const BATCH_ROWS = [{ Material: '1', Batch: 'L1' }];

function buildAdapter({
  sourceName = BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER,
  strategy,
  projection,
  stockResolver,
  batchResolver,
  logger = { error: jest.fn(), warn: jest.fn() },
  credentials = [{ baseUrl: 'https://sap', user: 'u' }],
} = {}) {
  const resolvedStrategy = strategy ?? {
    normalizeConfig: jest.fn((raw) => ({ normalized: true, raw })),
    requiresRemoteFetch: jest.fn(() => true),
    buildQueryTargets: jest.fn(() => [{ plant: 'DPDO', storageLocations: null }]),
    buildIndex: jest.fn(() => new Map([['1', [{ batch: 'L1' }]]])),
    resolveBatches: jest.fn(() => [{ batch: 'L1' }]),
  };
  const resolvedProjection = projection ?? { requiredProperties: jest.fn(() => []), project: jest.fn(() => ({ lotes_detalle: 'L1' })) };

  const adapter = new BatchExpiryEnrichmentAdapter({
    sourceFactory: { getStrategy: jest.fn(() => resolvedStrategy) },
    projectionFactory: { getStrategy: jest.fn(() => resolvedProjection) },
    configRepository: { getBatchExpiryConfig: jest.fn(async () => ({ sourceName, projectionName: 'hs_ProductProperties', rawConfig: {} })) },
    stockResolverFactory: () => stockResolver ?? { fetchStockRows: jest.fn(async () => STOCK_ROWS) },
    batchResolverFactory: () => batchResolver ?? { fetchBatchRows: jest.fn(async () => BATCH_ROWS) },
    logger,
  });

  const tenantModels = { SapCredentials: { find: () => ({ lean: async () => credentials }) } };
  return { adapter, tenantModels, strategy: resolvedStrategy, projection: resolvedProjection, logger };
}

function buildRecords() {
  return [{ rawSapData: { Product: '1' } }, { rawSapData: { Product: '2' } }];
}

describe('BatchExpiryEnrichmentAdapter', () => {
  it('cumple el puerto de enricher', () => {
    expect(() => assertPort(buildAdapter().adapter, SapRecordEnricherPort)).not.toThrow();
  });

  it('escribe la clave con las propiedades proyectadas', async () => {
    const { adapter, tenantModels } = buildAdapter();
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(records[0].rawSapData[BATCH_EXPIRY_KEY]).toEqual({ lotes_detalle: 'L1' });
  });

  it('inyecta un now unico a toda la corrida, no uno por producto', async () => {
    const { adapter, tenantModels, strategy } = buildAdapter();
    await adapter.enrich({ mappedRecords: buildRecords(), objectType: 'product', tenantModels });

    expect(strategy.buildIndex).toHaveBeenCalledTimes(1);
    expect(strategy.buildIndex.mock.calls[0][1].now).toBeInstanceOf(Date);
  });

  it('no hace nada en un sync que no es de productos', async () => {
    const { adapter, tenantModels } = buildAdapter();
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('source none: ni una llamada a SAP y NO escribe la clave', async () => {
    const stockResolver = { fetchStockRows: jest.fn() };
    const { adapter, tenantModels } = buildAdapter({ sourceName: BATCH_SOURCE_STRATEGIES.NONE, stockResolver });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(stockResolver.fetchStockRows).not.toHaveBeenCalled();
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('sin credenciales SAP avisa y NO escribe la clave', async () => {
    const { adapter, tenantModels, logger } = buildAdapter({ credentials: [] });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(logger.warn).toHaveBeenCalled();
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('un fallo del resolver se traga con logger.error y NO pisa propiedades', async () => {
    const batchResolver = { fetchBatchRows: jest.fn(async () => { throw new Error('gateway 500'); }) };
    const { adapter, tenantModels, logger } = buildAdapter({ batchResolver });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(logger.error).toHaveBeenCalledWith('Batch expiry enrichment failed', expect.objectContaining({ error: 'gateway 500' }));
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('una estrategia desconocida se traga igual', async () => {
    const adapter = new BatchExpiryEnrichmentAdapter({
      sourceFactory: { getStrategy: () => { throw new Error('Batch source strategy not supported: xx'); } },
      projectionFactory: { getStrategy: jest.fn() },
      configRepository: { getBatchExpiryConfig: async () => ({ sourceName: 'xx', projectionName: 'y', rawConfig: {} }) },
      logger: { error: jest.fn() },
    });
    const records = buildRecords();

    await expect(adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: {} })).resolves.toBeUndefined();
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('salta registros sin rawSapData sin romperse', async () => {
    const { adapter, tenantModels } = buildAdapter();
    await expect(adapter.enrich({ mappedRecords: [null, {}], objectType: 'product', tenantModels })).resolves.toBeUndefined();
  });

  it('pide el stock UNA vez y el maestro UNA vez para todo el lote de productos', async () => {
    const stockResolver = { fetchStockRows: jest.fn(async () => STOCK_ROWS) };
    const batchResolver = { fetchBatchRows: jest.fn(async () => BATCH_ROWS) };
    const { adapter, tenantModels } = buildAdapter({ stockResolver, batchResolver });

    await adapter.enrich({ mappedRecords: buildRecords(), objectType: 'product', tenantModels });

    expect(stockResolver.fetchStockRows).toHaveBeenCalledTimes(1);
    expect(batchResolver.fetchBatchRows).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- tests/unit/infrastructure/batchExpiryEnrichmentAdapter.test.js`
Expected: FAIL — `Cannot find module '.../BatchExpiryEnrichmentAdapter.js'`

- [ ] **Step 3: Escribir el adaptador**

```javascript
// src/infrastructure/sap/products/BatchExpiryEnrichmentAdapter.js
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import {
  BATCH_EXPIRY_KEY,
  BATCH_SOURCE_STRATEGIES,
} from '#domain/batches/batch-expiry.constants.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import S4StockResolver from './S4StockResolver.js';
import S4BatchResolver from './S4BatchResolver.js';

// Adjunta al rawSapData de cada producto las propiedades de lote/caducidad ya
// resueltas, antes de que product.handler.js las copie.
//
// A diferencia de WarehouseStockEnrichmentAdapter, este NO escribe la clave
// cuando algo sale mal ni cuando el tenant no maneja lotes. Escribir vacio es
// una afirmacion ("este producto no tiene lotes") y un fallo de red no la
// autoriza: dejar la clave ausente hace que el handler no toque las
// propiedades y HubSpot conserve lo de la corrida anterior.
export class BatchExpiryEnrichmentAdapter {
  constructor({
    sourceFactory,
    projectionFactory,
    configRepository,
    stockResolverFactory = null,
    batchResolverFactory = null,
    logger = console,
  }) {
    this.sourceFactory = sourceFactory;
    this.projectionFactory = projectionFactory;
    this.configRepository = configRepository;
    this.stockResolverFactory = stockResolverFactory
      || ((config) => new S4StockResolver({
        transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config }),
      }));
    this.batchResolverFactory = batchResolverFactory
      || ((config) => new S4BatchResolver({
        transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config }),
      }));
    this.logger = logger;
  }

  async enrich({ mappedRecords, objectType, tenantModels }) {
    if (objectType !== 'product' || !tenantModels) {
      return;
    }

    const records = Array.isArray(mappedRecords) ? mappedRecords : [];

    try {
      const { sourceName, projectionName, rawConfig } = await this.configRepository
        .getBatchExpiryConfig({ tenantModels });

      if (sourceName === BATCH_SOURCE_STRATEGIES.NONE) {
        return;
      }

      const strategy = this.sourceFactory.getStrategy(sourceName);
      const projection = this.projectionFactory.getStrategy(projectionName);
      const config = strategy.normalizeConfig(rawConfig);

      let index = new Map();

      if (strategy.requiresRemoteFetch()) {
        const sapCredentialsList = typeof tenantModels.SapCredentials?.find === 'function'
          ? await tenantModels.SapCredentials.find().lean()
          : [];
        const [sapCredentials] = sapCredentialsList;

        if (!sapCredentials) {
          this.logger.warn?.('Batch expiry enrichment skipped: no SAP credentials');
          return;
        }

        // Las dos lecturas son independientes y juntas dominan el tiempo de la
        // corrida (~1.8 s el stock, ~319 s el maestro de lotes), asi que van en
        // paralelo. Ambas corren UNA sola vez sobre el set completo, antes de
        // que processProductBatches lotee de a 100: un solo indice sirve a
        // todos los lotes.
        const [stockRows, batchRows] = await Promise.all([
          this.stockResolverFactory(sapCredentials)
            .fetchStockRows(strategy.buildQueryTargets(config)),
          this.batchResolverFactory(sapCredentials).fetchBatchRows(),
        ]);

        // Un unico `now` para toda la corrida: si cada producto tomara el suyo,
        // dos productos evaluados a ambos lados de la medianoche darian
        // dias_para_vencer inconsistentes entre si.
        index = strategy.buildIndex({ stockRows, batchRows }, { config, now: new Date() });
      }

      for (const record of records) {
        if (!record?.rawSapData) {
          continue;
        }

        record.rawSapData[BATCH_EXPIRY_KEY] = projection.project({
          record,
          batches: strategy.resolveBatches({ record, index }),
          config,
        });
      }
    } catch (error) {
      this.logger.error?.('Batch expiry enrichment failed', { error: error?.message });
    }
  }
}

export default BatchExpiryEnrichmentAdapter;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm test -- tests/unit/infrastructure/batchExpiryEnrichmentAdapter.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sap/products/BatchExpiryEnrichmentAdapter.js tests/unit/infrastructure/batchExpiryEnrichmentAdapter.test.js
git commit -m "feat: add BatchExpiryEnrichmentAdapter"
```

---

### Task 8: Enganche en el pipeline, la composición, el handler y el seed

Hasta acá nada de lo construido se ejecuta. Esta tarea lo conecta.

**Files:**
- Modify: `src/application/use-cases/SyncSapConfigToHubspot.js:20-22`, `:40-42`, `:216` (insertar el bloque después del de `warehouseStockEnricher`)
- Modify: `src/composition/sap-sync.composition.js:72-76` (factories), `:100-107` (inyección)
- Modify: `src/infrastructure/hubspot/handlers/product.handler.js:51-80`
- Modify: `src/infrastructure/hubspot/tenantHubspotSeed.service.js:177-192`
- Test: `tests/unit/product.handler.test.js` (extender)
- Test: `tests/unit/composition/sapSyncComposition.test.js` (crear si no existe)

**Interfaces:**
- Consumes: todo lo de las Tareas 1–7.
- Produces: `SyncSapConfigToHubspot` acepta `batchExpiryEnricher = null`; `product.handler.js` copia `BATCH_EXPIRY_KEY` a `item.properties`.

- [ ] **Step 1: Escribir el test que falla, en `tests/unit/product.handler.test.js`**

Agregar al final del archivo:

```javascript
import { BATCH_EXPIRY_KEY } from '../../src/domain/batches/batch-expiry.constants.js';

describe('product.handler + lotes de caducidad', () => {
  it('copia las propiedades de lote cuando el enricher dejo la clave', async () => {
    const item = {
      rawSapData: {
        Product: '10000289',
        [WAREHOUSE_STOCK_KEY]: { dpdo_0001_stock: 8600 },
        [BATCH_EXPIRY_KEY]: { lotes_detalle: '17141 · vence 2026-11-01 · 9,654.000 · DPDO/0001', dias_para_vencer: 80 },
      },
      properties: {},
    };

    await preprocess({ item, tenantModels: {}, preprocessContext: { warehouseFields: [], priceFields: ['hs_price_usd'] } });

    expect(item.properties.lotes_detalle).toContain('17141');
    expect(item.properties.dias_para_vencer).toBe(80);
    // El stock por bodega no se pisa
    expect(item.properties.dpdo_0001_stock).toBe(8600);
  });

  it('sin la clave no escribe ninguna propiedad de lote', async () => {
    const item = { rawSapData: { Product: '10000289', [WAREHOUSE_STOCK_KEY]: {} }, properties: {} };

    await preprocess({ item, tenantModels: {}, preprocessContext: { warehouseFields: [], priceFields: ['hs_price_usd'] } });

    expect(item.properties).not.toHaveProperty('lotes_detalle');
    expect(item.properties).not.toHaveProperty('dias_para_vencer');
  });

  it('con la clave vacia escribe las propiedades vacias (limpia valores viejos)', async () => {
    const item = {
      rawSapData: { Product: 'X', [WAREHOUSE_STOCK_KEY]: {}, [BATCH_EXPIRY_KEY]: { lotes_detalle: '', cantidad_vencida: '' } },
      properties: {},
    };

    await preprocess({ item, tenantModels: {}, preprocessContext: { warehouseFields: [], priceFields: ['hs_price_usd'] } });

    expect(item.properties.lotes_detalle).toBe('');
    expect(item.properties.cantidad_vencida).toBe('');
  });
});
```

Nota: si el archivo no importa ya `WAREHOUSE_STOCK_KEY` ni `preprocess`, agregarlos a los imports existentes en vez de duplicarlos.

- [ ] **Step 2: Escribir el test de composición**

```javascript
// tests/unit/composition/sapSyncComposition.test.js
import fs from 'node:fs';
import path from 'node:path';

// Verificacion textual a proposito: un parametro del constructor puede quedar
// sin cablear en composicion y TODOS los tests unitarios siguen verdes, porque
// cada uno inyecta su propio doble. Ya paso tres veces en este repo. Aserciones
// como expect.any(Object) no lo detectan; leer el archivo si.
const source = fs.readFileSync(
  path.resolve('src/composition/sap-sync.composition.js'),
  'utf8'
);

describe('sap-sync.composition', () => {
  it('inyecta batchExpiryEnricher en SyncSapConfigToHubspot', () => {
    expect(source).toMatch(/batchExpiryEnricher:\s*assertPort\(/);
  });

  it('construye el adaptador con AMBAS factories y el repositorio de config', () => {
    expect(source).toContain('new BatchExpiryEnrichmentAdapter({');
    expect(source).toMatch(/sourceFactory:\s*batchSourceStrategyFactory/);
    expect(source).toMatch(/projectionFactory:\s*batchProjectionStrategyFactory/);
    expect(source).toMatch(/configRepository:\s*new BatchExpiryConfigRepository\(\)/);
  });

  it('registra la estrategia s4 Y la none en la factory de fuente', () => {
    expect(source).toMatch(/noneStrategy:\s*new NoneBatchSourceStrategy\(\)/);
    expect(source).toMatch(/s4BatchMasterStrategy:\s*new S4BatchMasterStrategy\(\)/);
  });

  it('valida el adaptador contra SapRecordEnricherPort', () => {
    expect(source).toMatch(/BatchExpiryEnrichmentAdapter[\s\S]{0,400}?SapRecordEnricherPort/);
  });
});
```

- [ ] **Step 3: Correr ambos tests y verificar que fallan**

Run: `npm test -- tests/unit/product.handler.test.js tests/unit/composition/sapSyncComposition.test.js`
Expected: FAIL — el handler no copia la clave; la composición no menciona `batchExpiryEnricher`.

- [ ] **Step 4: Enganchar el use-case**

En `src/application/use-cases/SyncSapConfigToHubspot.js`:

En la desestructuración del constructor (junto a `propertiesFlagsEnricher = null,` en la línea 22):

```javascript
    batchExpiryEnricher = null,
```

En las asignaciones (junto a `this.propertiesFlagsEnricher = propertiesFlagsEnricher;` en la línea 42):

```javascript
    this.batchExpiryEnricher = batchExpiryEnricher;
```

Inmediatamente después del bloque `if (this.warehouseStockEnricher) { ... }` que termina en la línea 216:

```javascript
      // Adjunta los lotes y sus fechas de caducidad (no-op salvo en tenants con
      // batchExpiryStrategy configurada). Va despues del de stock porque ambos
      // leen rawSapData y son independientes, y antes de sendMappedRecords para
      // que product.handler.js encuentre la clave ya resuelta.
      if (this.batchExpiryEnricher) {
        await this.batchExpiryEnricher.enrich({
          mappedRecords: mappedRecordsWithRawSap,
          objectType,
          tenantModels: tenantContext?.tenantModels,
        });
      }
```

- [ ] **Step 5: Cablear la composición**

En `src/composition/sap-sync.composition.js`, agregar a los imports:

```javascript
import BatchSourceStrategyFactory from '#domain/batches/batch-source-strategy.factory.js';
import BatchProjectionStrategyFactory from '#domain/batches/batch-projection-strategy.factory.js';
import NoneBatchSourceStrategy from '#domain/batches/sources/none.strategy.js';
import S4BatchMasterStrategy from '#domain/batches/sources/s4-batch-master.strategy.js';
import ProductPropertiesProjection from '#domain/batches/projections/product-properties.projection.js';
import BatchExpiryConfigRepository from '#infrastructure/config/BatchExpiryConfigRepository.js';
import BatchExpiryEnrichmentAdapter from '#infrastructure/sap/products/BatchExpiryEnrichmentAdapter.js';
```

Después del bloque `warehouseStockStrategyFactory` (línea 76):

```javascript
  const batchSourceStrategyFactory = new BatchSourceStrategyFactory({
    noneStrategy: new NoneBatchSourceStrategy(),
    s4BatchMasterStrategy: new S4BatchMasterStrategy(),
    logger,
  });

  const batchProjectionStrategyFactory = new BatchProjectionStrategyFactory({
    productPropertiesProjection: new ProductPropertiesProjection(),
    logger,
  });
```

Dentro del `return new SyncSapConfigToHubspot({ ... })`, después del bloque `warehouseStockEnricher` (línea 107):

```javascript
    batchExpiryEnricher: assertPort(
      new BatchExpiryEnrichmentAdapter({
        sourceFactory: batchSourceStrategyFactory,
        projectionFactory: batchProjectionStrategyFactory,
        configRepository: new BatchExpiryConfigRepository(),
        logger,
      }),
      SapRecordEnricherPort
    ),
```

- [ ] **Step 6: Ramificar el handler**

En `src/infrastructure/hubspot/handlers/product.handler.js`, agregar al import de constantes de dominio:

```javascript
import { BATCH_EXPIRY_KEY } from '#domain/batches/batch-expiry.constants.js';
```

Inmediatamente después de `Object.assign(item.properties, warehouseStockProperties);` (línea 80):

```javascript
  // A diferencia del stock por bodega, esta clave puede NO estar: el enricher la
  // omite cuando el tenant no maneja lotes o cuando la lectura de SAP fallo. En
  // ese caso no se toca nada y HubSpot conserva lo de la corrida anterior, en
  // vez de quedar con las propiedades en blanco por un timeout de red.
  if (Object.prototype.hasOwnProperty.call(rawSapData, BATCH_EXPIRY_KEY)) {
    Object.assign(item.properties, rawSapData[BATCH_EXPIRY_KEY]);
  }
```

- [ ] **Step 7: Sembrar las propiedades en el portal**

En `src/infrastructure/hubspot/tenantHubspotSeed.service.js`, agregar al import:

```javascript
import { BATCH_PRODUCT_PROPERTIES } from '#domain/batches/projections/product-properties.projection.js';
```

Dentro del bloque `if (sapFlavor === SAP_FLAVORS.S4) { ... }`, después del `fieldsToEnsure.push(...)` existente:

```javascript
    // Las siete propiedades de lote/caducidad, tomadas de la propia proyeccion
    // para que exista una sola fuente de verdad. Se importa la implementacion
    // directo en vez de resolverla por la factory porque el seed corre en
    // aprovisionamiento, sin config de tenant todavia. Cuando exista una segunda
    // proyeccion (custom object), este servicio pasa a recibir la factory.
    fieldsToEnsure.push(...BATCH_PRODUCT_PROPERTIES);
```

- [ ] **Step 8: Correr los tests de la tarea**

Run: `npm test -- tests/unit/product.handler.test.js tests/unit/composition/sapSyncComposition.test.js`
Expected: PASS ambos.

- [ ] **Step 9: Correr la suite completa y comparar contra la línea base**

Run: `npm test`
Expected: exactamente los 6 suites / 12 tests de la línea base en rojo, ni uno más. Si aparece otra suite fallando, es regresión de este plan — arreglarla antes de commitear.

- [ ] **Step 10: Commit**

```bash
git add src/application/use-cases/SyncSapConfigToHubspot.js src/composition/sap-sync.composition.js src/infrastructure/hubspot/handlers/product.handler.js src/infrastructure/hubspot/tenantHubspotSeed.service.js tests/unit/product.handler.test.js tests/unit/composition/sapSyncComposition.test.js
git commit -m "feat: wire the batch expiry enricher into the product sync pipeline"
```

---

### Task 9: Documento de entrega y verificación end-to-end

Ninguna escritura a Mongo la hace el implementador: se entregan los documentos y el usuario los inserta.

**Files:**
- Create: `docs/superpowers/specs/2026-08-13-batch-expiry-sync-configs.md`
- Modify: `configuration_examples.md` (agregar la clave `batchExpiryStrategy` con descripción y ejemplo, siguiendo el formato del archivo)

**Interfaces:**
- Consumes: `BATCH_PRODUCT_PROPERTIES` (T4) para la lista de propiedades a crear.
- Produces: documento de entrega.

- [ ] **Step 1: Escribir el documento de entrega**

Debe contener, en este orden:

1. **Prerrequisito**: Multiquímica todavía no tiene tenant aprovisionado. Hay que correr `provisionTenant({ ..., sapFlavor: 'S4' })` y completar el OAuth de HubSpot antes de poder insertar nada.

2. **Las 7 propiedades a crear en el portal antes del primer run**, con nombre interno, label, `type` y `fieldType` exactos, copiados de `BATCH_PRODUCT_PROPERTIES`. Advertencia explícita: si falta una sola, `batchCreateProducts` falla el lote de 100 entero y degrada a secuencial, o sea ~8,000 requests fallidos.

3. **El documento `Configuration`**:

```json
{
  "key": "batchExpiryStrategy",
  "userUpdated": "admin",
  "value": {
    "source": "s4_BatchMaster",
    "projection": "hs_ProductProperties",
    "warehouses": [],
    "stockTypes": ["01"],
    "includeExpired": false,
    "horizonDays": 90
  }
}
```

Con una tabla explicando cada clave y su default, y la nota de que `warehouses: []` significa **todas** las bodegas.

4. **Advertencia para el cliente**: 2,668 de los 6,818 pares material-lote con stock libre están vencidos, algunos hace más de cuatro años. Con `includeExpired: false` no salen en el detalle, pero `cantidad_vencida` los va a exponer igual. Conviene avisarle a Multiquímica antes del primer run productivo.

5. **Nota de performance**: la corrida agrega ~5.3 min por el maestro de lotes (74,277 filas). Si molesta, la palanca es filtrar por `ShelfLifeExpirationDate` en `S4BatchResolver`, a costa de perder `cantidad_vencida`.

- [ ] **Step 2: Verificar contra el sistema real — lectura**

Con la VPN del cliente arriba, confirmar que los datos que asume el diseño siguen vigentes:

```bash
curl -s -k -u 'smarteam:Multiquimica.600' "https://vhmldqs4ci.hec.multidomsa.com:44300/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod?sap-client=600&\$format=json&\$select=Material,Plant,StorageLocation,Batch,InventoryStockType,MatlWrhsStkQtyInMatlBaseUnit&\$filter=Material%20eq%20'10000289'%20and%20MatlWrhsStkQtyInMatlBaseUnit%20gt%200"
```

Expected: 5 filas — DPDO/0001 lote 17131 (200), DPDO/0001 lote 17141 (8600), DPDO/0108 lote 17131 (6000), DPDO/0201 lote 17141 (1054), MQDO/0108 lote 24J1 (19000).

- [ ] **Step 3: Verificar el sync acotado**

Dejar **solo** `Obtener Productos S4` con `active: true`, agregarle un filtro acotado con `PATCH /client-configs/:id`:

```json
{"filters":[{"property":"Product","operator":"eq","value":"10000289"}]}
```

y lanzar:

```bash
curl -X POST http://localhost:3000/sap-sync/run -H 'Content-Type: application/json' -d '{"tenantID":"<tenantKey>"}'
```

- [ ] **Step 4: Revisar el resultado en HubSpot**

Con `warehouses: ["DPDO/*"]` en la config, el producto `10000289` debe quedar con:

- `lotes_detalle` con **dos líneas**: `17131` consolidando 6,200 de sus dos almacenes (`DPDO/0001, DPDO/0108`) y `17141` con 9,654 (`DPDO/0001, DPDO/0201`)
- **sin** el lote `24J1`, que vive en MQDO y queda fuera del alcance
- `fecha_vencimiento_proxima` poblada y **nunca** con una fecha pasada
- `cantidad_vencida` reflejando lo vencido aunque no aparezca en el detalle

Confirmar además que `fecha_vencimiento_proxima` se ve como fecha en la UI de HubSpot y no como texto: es el único punto del diseño donde el formato `YYYY-MM-DD` se verifica contra la API real.

- [ ] **Step 5: Verificar el producto sin lotes**

Buscar en HubSpot un producto con `IsBatchManagementRequired = false` y confirmar que las 7 propiedades están **vacías**, no en cero.

- [ ] **Step 6: Verificar idempotencia**

Relanzar el mismo `POST /sap-sync/run` sin cambiar nada.

Expected: el `SyncLog` reporta `skipped ≈ total`. Si `updated` sigue alto, la causa es el formato de alguna propiedad (típicamente el redondeo o el separador de miles), no el contenido.

- [ ] **Step 7: Verificar la regresión B1**

Correr el sync de productos de un tenant B1 existente (amc, distelsa, noelito o printer).

Expected: el stock por bodega sale idéntico a antes, **ninguna** propiedad de lote se creó ni se escribió, y el log no muestra ni una llamada a `API_BATCH_SRV`.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-08-13-batch-expiry-sync-configs.md configuration_examples.md
git commit -m "docs: add the batch expiry delivery configs and catalog entry"
```
