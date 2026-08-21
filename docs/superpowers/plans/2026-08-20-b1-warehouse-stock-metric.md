# Métrica de stock por bodega configurable en B1 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada entrada de `fieldsWareHouseHS` pueda declarar qué número de la bodega va a su propiedad de HubSpot (`available` | `inStock` | `committed` | `ordered`), en vez de la fórmula fija `InStock - Committed + Ordered`.

**Architecture:** Un campo `metric` opcional por entrada de config, normalizado en la strategy de dominio de B1 y aplicado en `buildB1WarehouseStockProperties`. Sin `metric` el comportamiento es el histórico, así que ninguna config existente cambia de significado. Una `metric` que no existe descarta la entrada y escribe un documento en la colección `SyncWarnings`, atado al `syncLogId` de la corrida.

**Tech Stack:** Node.js ESM, Jest (con `--experimental-vm-modules`), Mongoose, arquitectura de puertos y adaptadores del repo.

**Spec:** `docs/superpowers/specs/2026-08-20-b1-warehouse-stock-metric-design.md`

## Global Constraints

- **Sólo SAP Business One.** `S4PlantStorageLocationStrategy` no se toca. Su eje equivalente es `stockType` por field.
- **La prueba de regresión de que Distelsa y Noelito no se mueven son los cuatro tests de `tests/unit/warehouseStock.test.js` que afirman NÚMEROS** (`distelsa_stock: 8` + `exhibicion_stock: 2`; `A01_stock: 8` + `B10_stock: 2` + `C99_stock: 0`; el `toEqual([])`/`toEqual({})` de config inválida; y `getAvailableStockForWarehouse` → `7`). **Esos cuatro no se tocan en ninguna tarea.** Si una tarea cambia uno de esos valores esperados, cambió comportamiento de producción y está mal implementada.

  Los otros dos tests del archivo (las aserciones de las líneas 29 y 51) afirman la **forma** del field intermedio, `{ warehouseCode, propertyName }`, y la Task 2 les agrega `metric: 'available'` — el mismo cambio mecánico que a cuatro aserciones del test de dominio. Autorizado explícitamente por el dueño del proyecto el 2026-08-21, después de que la Task 2 lo detectara y se detuviera a preguntar.

  Filtrar `metric` en `normalizeHubspotWarehouseFields` para no tocar esos dos tests **está descartado**: esos fields alimentan el camino de fallback de `product.handler.js:71-75`, así que sin el campo ese camino ignoraría en silencio la config de métrica del tenant — un bug peor que el test editado.
- **`tests/unit/domain/b1ItemWarehouseStrategy.test.js` sí se edita**, pero sólo para (a) agregar casos nuevos y (b) el cambio puntual que la Task 2 detalla: sumar `metric: 'available'` a cuatro `toEqual` preexistentes, porque el retorno de `normalizeB1WarehouseFields` gana esa clave. Ninguna otra edición a los tests que ya estaban es aceptable — cambiar un valor esperado o borrar un caso es señal de que la implementación cambió comportamiento existente.
- **Comando de test canónico** (medido en este entorno, Windows + Git Bash + jest 30.1.3). `npm test` **no sirve**: npm en Windows lanza `cmd.exe`, que no entiende el prefijo `NODE_OPTIONS=... jest` del script. Y `jest.config.js` no tiene `testPathIgnorePatterns`, así que sin filtro se levantan también las 6 copias del repo que viven en `.claude/worktrees/**` (977 suites en vez de 178). El filtro tiene que usar clase de caracteres para el separador, porque en Windows las rutas van con `\` y un patrón con `/` no matchea nunca:

  ```bash
  NODE_OPTIONS=--experimental-vm-modules npx jest \
    --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' \
    --testPathPatterns='tests[\\/]unit[\\/]domain[\\/]b1ItemWarehouseStrategy'
  ```

  Las dos opciones van con `=`: `--testPathIgnorePatterns` es una opción de array y sin `=` se traga los argumentos posicionales, corriendo la suite entera en silencio. Omitir `--testPathPatterns` corre toda la suite propia del repo.

- **Baseline de fallos preexistentes, medida en `8c55830` antes de empezar: 178 suites, 5 fallando (10 tests).** Son `tests/integration/internalTenant.test.js`, `tests/unit/application/sendMappedItemsToHubspot.test.js`, `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js` y `tests/unit/serviceLayerService.test.js`. Ninguna toca bodegas. "La suite en verde" en este plan significa **esas cinco y sólo esas cinco**; una sexta suite roja sí es de esta rama.
- **Trabajar en el checkout principal** `C:\Users\ale_1\OneDrive\Escritorio\Proyectos\SAP`, rama `feat/b1-warehouse-stock-metric`, que ya existe con el spec commiteado. Hay trabajo sin commitear de otra feature (listas de precios S/4) en el working tree: **nunca hacer `git add -A` ni `git add .`**, siempre los archivos por nombre.
- **`available` no cambia de fórmula:** sigue siendo `InStock - Committed + Ordered`. No se agrega redondeo a ninguna métrica.
- **Nombres canónicos de las métricas, exactos:** `'available'`, `'inStock'`, `'committed'`, `'ordered'`. El `code` del warning es exactamente `'warehouse_metric_invalid'`.
- **Nada de claves con `$` al inicio en el `details` del `SyncWarning`.** El Mongo de producción es < 5.0 y las rechaza, y un `$set` se cae completo por una sola clave mala.
- **`amc_warehouse_fields.json` ya existe** en la raíz del repo, commiteado junto al spec: las 54 entradas de AMC listas para insertar. No hay que generarlo ni tocarlo, y **no hay migración** — lo aplica quien hace el onboarding, y las propiedades del portal las crea el dueño del proyecto.

---

### Task 1: Las constantes de métrica y las dos funciones puras

Dominio puro, sin tocar ninguna función existente. Al terminar esta tarea nada del comportamiento cambió todavía.

**Files:**
- Modify: `src/domain/warehouses/warehouse-stock-strategy.constants.js`
- Modify: `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`
- Test: `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `B1_STOCK_METRICS` — objeto congelado `{ AVAILABLE: 'available', IN_STOCK: 'inStock', COMMITTED: 'committed', ORDERED: 'ordered' }`
  - `DEFAULT_B1_STOCK_METRIC` — `'available'`
  - `WAREHOUSE_METRIC_INVALID_WARNING` — `'warehouse_metric_invalid'`
  - `normalizeB1StockMetric(raw): string | null` — el valor canónico, o `null` si no existe
  - `getWarehouseMetricValue(warehouse, metric): number`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tests/unit/domain/b1ItemWarehouseStrategy.test.js`, y agregar `getWarehouseMetricValue` y `normalizeB1StockMetric` al bloque de `import` que ya está al tope del archivo (líneas 1-8):

```js
describe('normalizeB1StockMetric', () => {
  it('defaults to available when the metric is absent or blank', () => {
    expect(normalizeB1StockMetric(undefined)).toBe('available');
    expect(normalizeB1StockMetric(null)).toBe('available');
    expect(normalizeB1StockMetric('')).toBe('available');
    expect(normalizeB1StockMetric('   ')).toBe('available');
  });

  it('matches case-insensitively and trims, returning the canonical name', () => {
    expect(normalizeB1StockMetric('InStock')).toBe('inStock');
    expect(normalizeB1StockMetric('instock')).toBe('inStock');
    expect(normalizeB1StockMetric(' inStock ')).toBe('inStock');
    expect(normalizeB1StockMetric('COMMITTED')).toBe('committed');
    expect(normalizeB1StockMetric('Ordered')).toBe('ordered');
    expect(normalizeB1StockMetric('available')).toBe('available');
  });

  it('returns null for a metric that does not exist', () => {
    expect(normalizeB1StockMetric('inStok')).toBeNull();
    expect(normalizeB1StockMetric('total')).toBeNull();
    expect(normalizeB1StockMetric('in stock')).toBeNull();
  });
});

describe('getWarehouseMetricValue', () => {
  const warehouse = { InStock: 7, Committed: 1, Ordered: 2 };

  it('returns the raw SAP field for each separate metric', () => {
    expect(getWarehouseMetricValue(warehouse, 'inStock')).toBe(7);
    expect(getWarehouseMetricValue(warehouse, 'committed')).toBe(1);
    expect(getWarehouseMetricValue(warehouse, 'ordered')).toBe(2);
  });

  it('returns InStock - Committed + Ordered for available', () => {
    expect(getWarehouseMetricValue(warehouse, 'available')).toBe(8);
  });

  it('treats a legacy field with no metric as available', () => {
    expect(getWarehouseMetricValue(warehouse, undefined)).toBe(8);
  });

  it('treats a missing warehouse as zero for every metric', () => {
    ['available', 'inStock', 'committed', 'ordered'].forEach((metric) => {
      expect(getWarehouseMetricValue(undefined, metric)).toBe(0);
    });
  });

  it('treats a missing SAP field as zero', () => {
    expect(getWarehouseMetricValue({ InStock: 5 }, 'committed')).toBe(0);
    expect(getWarehouseMetricValue({ InStock: 5 }, 'ordered')).toBe(0);
    expect(getWarehouseMetricValue({ InStock: 5 }, 'available')).toBe(5);
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

Expected: FAIL. `normalizeB1StockMetric is not a function` y `getWarehouseMetricValue is not a function`.

- [ ] **Step 3: Agregar las constantes**

En `src/domain/warehouses/warehouse-stock-strategy.constants.js`, después de `STOCK_TYPE_ALL` (línea 26) y antes de `QUANTITY_DECIMALS`:

```js
// Que numero de una bodega de B1 va a la propiedad de HubSpot. Es el eje
// equivalente a stockType del lado S/4: uno por field, no por tenant, para que
// un tenant pueda pedir tres columnas de una bodega y una sola de otra.
export const B1_STOCK_METRICS = Object.freeze({
  // InStock - Committed + Ordered. El comportamiento historico y el default:
  // ninguna config existente declara metric, y ninguna debe cambiar.
  AVAILABLE: 'available',
  IN_STOCK: 'inStock',
  COMMITTED: 'committed',
  ORDERED: 'ordered',
});

export const DEFAULT_B1_STOCK_METRIC = B1_STOCK_METRICS.AVAILABLE;

// code del documento de SyncWarnings que se escribe cuando una entrada de
// fieldsWareHouseHS declara una metric que no existe. La entrada se descarta:
// caer de vuelta a available escribiria un numero plausible pero equivocado en
// una columna de inventario, y eso nadie lo detecta mirando.
export const WAREHOUSE_METRIC_INVALID_WARNING = 'warehouse_metric_invalid';
```

Y agregar las tres al objeto del `export default` (línea 33), que lista todas las constantes del módulo:

```js
export default {
  WAREHOUSE_STOCK_CONFIG_KEY,
  WAREHOUSE_STOCK_STRATEGIES,
  DEFAULT_WAREHOUSE_STOCK_STRATEGY,
  WAREHOUSE_STOCK_KEY,
  STOCK_TYPE_ALL,
  B1_STOCK_METRICS,
  DEFAULT_B1_STOCK_METRIC,
  WAREHOUSE_METRIC_INVALID_WARNING,
  QUANTITY_DECIMALS,
};
```

- [ ] **Step 4: Agregar las dos funciones a la strategy**

En `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`: agregar el import al tope del archivo (el archivo hoy no importa nada, así que va antes del `const DEFAULT_WAREHOUSE_FIELDS` de la línea 8, después del comentario de cabecera):

```js
import {
  B1_STOCK_METRICS,
  DEFAULT_B1_STOCK_METRIC,
} from '../warehouse-stock-strategy.constants.js';
```

Y después de `getWarehouseAvailableStock` (que termina en la línea 41 y **no se toca**):

```js
// La comparacion es en minusculas para que el cliente pueda escribir la metrica
// tal como la ve en el JSON de SAP ("InStock") o en minusculas, sin que una u
// otra forma se descarte.
const METRIC_BY_LOWERCASE = new Map(
  Object.values(B1_STOCK_METRICS).map((metric) => [metric.toLowerCase(), metric])
);

export function normalizeB1StockMetric(raw) {
  const value = String(raw ?? '').trim();

  if (!value) {
    return DEFAULT_B1_STOCK_METRIC;
  }

  return METRIC_BY_LOWERCASE.get(value.toLowerCase()) ?? null;
}

// El default del switch es `available` a proposito: un field armado a mano sin
// metric (la forma historica, { warehouseCode, propertyName }) tiene que seguir
// dando el mismo numero que antes. Una metric invalida nunca llega hasta aca --
// normalizeB1WarehouseFields ya descarto esa entrada.
export function getWarehouseMetricValue(warehouse, metric = DEFAULT_B1_STOCK_METRIC) {
  switch (metric) {
    case B1_STOCK_METRICS.IN_STOCK:
      return Number(warehouse?.InStock ?? 0);
    case B1_STOCK_METRICS.COMMITTED:
      return Number(warehouse?.Committed ?? 0);
    case B1_STOCK_METRICS.ORDERED:
      return Number(warehouse?.Ordered ?? 0);
    default:
      return getWarehouseAvailableStock(warehouse);
  }
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

Expected: PASS, todos los tests del archivo — los nuevos y los 16 que ya estaban.

- [ ] **Step 6: Commit**

```bash
git add src/domain/warehouses/warehouse-stock-strategy.constants.js src/domain/warehouses/strategies/b1-item-warehouse.strategy.js tests/unit/domain/b1ItemWarehouseStrategy.test.js
git commit -m "feat: constantes de metrica de stock B1 y getWarehouseMetricValue"
```

---

### Task 2: `normalizeB1WarehouseFields` resuelve y reporta la métrica

**Files:**
- Modify: `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js` (`resolveWarehouseField` línea 19, `normalizeB1WarehouseFields` línea 43, clave de dedupe línea 59)
- Test: `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

**Interfaces:**
- Consumes: `normalizeB1StockMetric` de la Task 1.
- Produces:
  - `normalizeB1WarehouseFields(value, { onInvalidMetric } = {})` → `Array<{ warehouseCode, propertyName, metric }>`. La firma de un solo argumento sigue funcionando idéntica.
  - `onInvalidMetric` se llama con `{ propertyName, warehouseCode, metric }`, donde `metric` es **el valor crudo recibido**, no el normalizado.
  - `B1ItemWarehouseStrategy.normalizeFields(rawValue, options)` pasa `options` por transparencia.

> **Ojo con la regresión:** los tests existentes de las líneas 20-53 afirman con `toEqual([{ warehouseCode, propertyName }])`, sin `metric`. `toEqual` es exacto con las claves de un objeto, así que agregar `metric` al retorno **los rompe**. Eso es esperado y es el único caso en todo el plan donde tocar ese archivo de test está permitido: hay que agregarles `metric: 'available'`. No se cambia ninguna otra cosa de esos tests, y `tests/unit/warehouseStock.test.js` sigue intacto.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al `describe('normalizeB1WarehouseFields')` que ya existe (línea 20):

```js
  it('defaults a field with no metric to available', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'A01', value: 'a01_stock', valueSAP: 'A01' },
    ])).toEqual([{ warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'available' }]);
  });

  it('resolves the metric to its canonical name', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'A01 en stock', value: 'a01_instock', valueSAP: 'A01', metric: 'InStock' },
    ])).toEqual([{ warehouseCode: 'A01', propertyName: 'a01_instock', metric: 'inStock' }]);
  });

  it('keeps three entries for the same warehouse with different metrics', () => {
    expect(normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStock' },
      { value: 'a01_committed', valueSAP: 'A01', metric: 'committed' },
      { value: 'a01_ordered', valueSAP: 'A01', metric: 'ordered' },
    ])).toEqual([
      { warehouseCode: 'A01', propertyName: 'a01_instock', metric: 'inStock' },
      { warehouseCode: 'A01', propertyName: 'a01_committed', metric: 'committed' },
      { warehouseCode: 'A01', propertyName: 'a01_ordered', metric: 'ordered' },
    ]);
  });

  it('drops an entry with an unsupported metric and reports the raw value', () => {
    const onInvalidMetric = jest.fn();

    const fields = normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStok' },
      { value: 'a02_instock', valueSAP: 'A02', metric: 'inStock' },
    ], { onInvalidMetric });

    expect(fields).toEqual([
      { warehouseCode: 'A02', propertyName: 'a02_instock', metric: 'inStock' },
    ]);
    expect(onInvalidMetric).toHaveBeenCalledTimes(1);
    expect(onInvalidMetric).toHaveBeenCalledWith({
      propertyName: 'a01_instock',
      warehouseCode: 'A01',
      metric: 'inStok',
    });
  });

  it('drops an unsupported metric without throwing when no reporter is passed', () => {
    expect(() => normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStok' },
    ])).not.toThrow();
    expect(normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStok' },
    ])).toEqual([]);
  });

  it('does not dedupe two entries that differ only by metric', () => {
    // Config erronea del cliente (dos metricas a la MISMA propiedad). Sobreviven
    // las dos a la normalizacion y el reduce de buildB1WarehouseStockProperties
    // deja ganar a la ultima, igual que hoy con dos bodegas apuntando a una
    // sola propiedad.
    expect(normalizeB1WarehouseFields([
      { value: 'a01_x', valueSAP: 'A01', metric: 'inStock' },
      { value: 'a01_x', valueSAP: 'A01', metric: 'ordered' },
    ])).toHaveLength(2);
  });
```

Este archivo de test todavía no importa `jest`. Agregar al tope, antes del import de la strategy:

```js
import { jest } from '@jest/globals';
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

Expected: FAIL. Los nuevos fallan porque el retorno no trae `metric`; y los 4 tests preexistentes de `normalizeB1WarehouseFields` (líneas 21-48) **todavía pasan** porque el retorno aún no cambió.

- [ ] **Step 3: Implementar**

En `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`, reemplazar `resolveWarehouseField` (líneas 19-33) por:

```js
// Devuelve `metric: null` en vez de descartar la entrada acá, para que el
// llamador pueda reportar el propertyName y la bodega en el aviso antes de
// tirarla.
function resolveWarehouseField(field) {
  const propertyName = field?.value;

  if (!propertyName) {
    return null;
  }

  const rawWarehouseCode = field?.valueSAP || resolveWarehouseCodeFromPropertyName(propertyName);

  if (!rawWarehouseCode) {
    return null;
  }

  return {
    warehouseCode: String(rawWarehouseCode).toUpperCase(),
    propertyName,
    metric: normalizeB1StockMetric(field?.metric),
  };
}
```

Y reemplazar el cuerpo del `forEach` de `normalizeB1WarehouseFields` (líneas 43-70) por:

```js
export function normalizeB1WarehouseFields(value, { onInvalidMetric } = {}) {
  if (!Array.isArray(value)) {
    return DEFAULT_WAREHOUSE_FIELDS;
  }

  const seen = new Set();
  const normalizedFields = [];

  value.forEach((field) => {
    const warehouseField = resolveWarehouseField(field);

    if (!warehouseField) {
      return;
    }

    const { warehouseCode, propertyName, metric } = warehouseField;

    if (!metric) {
      onInvalidMetric?.({ propertyName, warehouseCode, metric: field?.metric });
      return;
    }

    // La metrica entra en la clave: la misma bodega puede aportar tres
    // propiedades distintas. Para una config sin metric el valor es siempre la
    // constante 'available', asi que la clave es equivalente a la de antes y el
    // comportamiento no se mueve.
    const dedupeKey = `${warehouseCode}:${metric}:${propertyName.toLowerCase()}`;

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    normalizedFields.push({ warehouseCode, propertyName, metric });
  });

  return normalizedFields;
}
```

Y en la clase, que `normalizeFields` pase las opciones:

```js
  normalizeFields(rawValue, options) {
    return normalizeB1WarehouseFields(rawValue, options);
  }
```

- [ ] **Step 4: Actualizar los 4 tests preexistentes de `normalizeB1WarehouseFields`**

Ahora el retorno trae `metric` y los `toEqual` de las líneas 21-48 fallan. Agregarles `metric: 'available'` al objeto esperado, sin cambiar nada más:

- línea 24: `.toEqual([{ warehouseCode: '01', propertyName: 'distelsa_stock', metric: 'available' }])`
- línea 30: `.toEqual([{ warehouseCode: 'A01', propertyName: 'A01_stock', metric: 'available' }])`
- línea 40: `.toEqual([{ warehouseCode: 'B10', propertyName: 'B10_stock', metric: 'available' }])`
- línea 47: `.toEqual([{ warehouseCode: 'B10', propertyName: 'b10_stock', metric: 'available' }])`

El test de `B1ItemWarehouseStrategy` de la línea 127 no se toca: afirma sobre `buildProperties`, no sobre la forma del field.

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/domain/b1ItemWarehouseStrategy.test.js tests/unit/warehouseStock.test.js`

Expected: PASS los dos archivos. `warehouseStock.test.js` tiene que pasar **sin haber sido editado** — es la prueba de que la firma de un argumento sigue intacta.

- [ ] **Step 6: Commit**

```bash
git add src/domain/warehouses/strategies/b1-item-warehouse.strategy.js tests/unit/domain/b1ItemWarehouseStrategy.test.js
git commit -m "feat: normalizeB1WarehouseFields resuelve metric y reporta las invalidas"
```

---

### Task 3: `buildB1WarehouseStockProperties` aplica la métrica

**Files:**
- Modify: `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js` (línea 117)
- Test: `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

**Interfaces:**
- Consumes: `getWarehouseMetricValue` (Task 1), fields con `metric` (Task 2).
- Produces: `buildB1WarehouseStockProperties(warehouseItems, warehouseFields, exclusions)` → `{ [propertyName]: number }`, sin cambio de firma.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al `describe('buildB1WarehouseStockProperties')` que ya existe (línea 65). El fixture va justo antes de ese `describe`:

```js
// ItemWarehouseInfoCollection real del producto P27020056 (18 bodegas),
// reducido a los cuatro campos que la strategy lee. Los unicos valores no
// nulos del payload real son A02.InStock=1, B09.InStock=66 y B12.Ordered=1400.
const P27020056_STOCK = {
  A02: { InStock: 1 },
  B09: { InStock: 66 },
  B12: { Ordered: 1400 },
};

const P27020056_WAREHOUSES = [
  'A01', 'A02', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08',
  'B09', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'PA',
].map((WarehouseCode) => ({
  WarehouseCode,
  ItemCode: 'P27020056',
  InStock: 0,
  Committed: 0,
  Ordered: 0,
  ...P27020056_STOCK[WarehouseCode],
}));
```

Y los casos:

```js
  it('emits the three separate metrics for one warehouse (AMC profile)', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'B09', propertyName: 'b09_instock', metric: 'inStock' },
      { warehouseCode: 'B09', propertyName: 'b09_committed', metric: 'committed' },
      { warehouseCode: 'B09', propertyName: 'b09_ordered', metric: 'ordered' },
      { warehouseCode: 'B12', propertyName: 'b12_instock', metric: 'inStock' },
      { warehouseCode: 'B12', propertyName: 'b12_ordered', metric: 'ordered' },
      { warehouseCode: 'A02', propertyName: 'a02_instock', metric: 'inStock' },
    ]);

    expect(properties).toEqual({
      b09_instock: 66,
      b09_committed: 0,
      b09_ordered: 0,
      b12_instock: 0,
      b12_ordered: 1400,
      a02_instock: 1,
    });
  });

  it('emits only InStock, leaving Ordered out (Printer profile)', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'inStock' },
      { warehouseCode: 'B09', propertyName: 'b09_stock', metric: 'inStock' },
      { warehouseCode: 'B12', propertyName: 'b12_stock', metric: 'inStock' },
    ]);

    // B12 tiene Ordered 1400 y NO entra: con metric inStock la propiedad es 0.
    expect(properties).toEqual({ a01_stock: 0, b09_stock: 66, b12_stock: 0 });
  });

  it('keeps the historical formula for fields with no metric (Distelsa/Noelito profile)', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'A02', propertyName: 'a02_stock' },
      { warehouseCode: 'B09', propertyName: 'b09_stock' },
      { warehouseCode: 'B12', propertyName: 'b12_stock' },
    ]);

    // b12 = 0 - 0 + 1400: la formula historica cuenta lo pedido como disponible.
    expect(properties).toEqual({ a02_stock: 1, b09_stock: 66, b12_stock: 1400 });
  });

  it('resolves a configured warehouse missing from the payload to 0 for any metric', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'C99', propertyName: 'c99_instock', metric: 'inStock' },
      { warehouseCode: 'C99', propertyName: 'c99_committed', metric: 'committed' },
    ]);

    expect(properties).toEqual({ c99_instock: 0, c99_committed: 0 });
  });

  it('forces an excluded warehouse to 0 in all three metrics', () => {
    const properties = buildB1WarehouseStockProperties(
      P27020056_WAREHOUSES,
      [
        { warehouseCode: 'B09', propertyName: 'b09_instock', metric: 'inStock' },
        { warehouseCode: 'B09', propertyName: 'b09_committed', metric: 'committed' },
        { warehouseCode: 'B09', propertyName: 'b09_ordered', metric: 'ordered' },
      ],
      ['B09']
    );

    expect(properties).toEqual({ b09_instock: 0, b09_committed: 0, b09_ordered: 0 });
  });
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

Expected: FAIL. Los perfiles AMC y Printer dan los números de la fórmula vieja: `b09_committed` sale `66` en vez de `0` y `b12_stock` sale `1400` en vez de `0`.

- [ ] **Step 3: Implementar**

En `buildB1WarehouseStockProperties`, cambiar la línea 117:

```js
    acc[propertyName] = getWarehouseMetricValue(
      warehousesByCode.get(warehouseCode),
      field.metric
    );
```

La rama de exclusión de la línea 112 no se toca: sigue escribiendo `0` antes de mirar la métrica.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/domain/b1ItemWarehouseStrategy.test.js tests/unit/warehouseStock.test.js`

Expected: PASS los dos archivos, `warehouseStock.test.js` de nuevo sin editar.

- [ ] **Step 5: Commit**

```bash
git add src/domain/warehouses/strategies/b1-item-warehouse.strategy.js tests/unit/domain/b1ItemWarehouseStrategy.test.js
git commit -m "feat: buildB1WarehouseStockProperties aplica la metric de cada field"
```

---

### Task 4: El adapter escribe el `SyncWarning`

**Files:**
- Modify: `src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js`
- Test: `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`

**Interfaces:**
- Consumes: `WAREHOUSE_METRIC_INVALID_WARNING` y `B1_STOCK_METRICS` (Task 1); el `onInvalidMetric` de `normalizeFields` (Task 2); `MongooseSyncWarningRepository.record({ tenantModels, clientConfigId, syncLogId, objectType, sapId, code, message, details })`, que ya existe y nunca tira.
- Produces: `enrich({ mappedRecords, objectType, tenantModels, clientConfigId = null, syncLogId = null })`, y el constructor acepta `syncWarningRepository = null`.

> **Orden que importa:** los avisos se escriben **antes** del `return` temprano de `fields.length === 0` (línea 48 del adapter). Si las 54 entradas de un tenant estuvieran todas mal escritas, `fields` queda vacío y ese `return` se lleva puesto el aviso — que es justo el caso donde más se necesita.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`. El helper `buildB1Strategy` va después de los helpers que ya están al tope del archivo:

```js
function buildB1Strategy({ invalidEntries = [], fields = [{ warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'available' }] } = {}) {
  return {
    normalizeFields: jest.fn((rawValue, { onInvalidMetric } = {}) => {
      invalidEntries.forEach((entry) => onInvalidMetric?.(entry));
      return fields;
    }),
    normalizeExclusions: jest.fn().mockReturnValue([]),
    requiresRemoteFetch: jest.fn().mockReturnValue(false),
    buildProperties: jest.fn().mockReturnValue({ a01_stock: 5 }),
  };
}

function buildSyncWarningRepository() {
  return { record: jest.fn().mockResolvedValue({ _id: 'warn-1' }) };
}
```

Y los casos:

```js
describe('WarehouseStockEnrichmentAdapter — avisos de metric invalida', () => {
  beforeEach(() => jest.clearAllMocks());

  const invalid = [
    { propertyName: 'a01_instock', warehouseCode: 'A01', metric: 'inStok' },
    { propertyName: 'a02_instock', warehouseCode: 'A02', metric: 'total' },
  ];

  it('records one SyncWarning per misconfigured entry', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({ invalidEntries: invalid });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({
      mappedRecords: buildRecords(1),
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(2);
    expect(syncWarningRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
      objectType: 'product',
      code: 'warehouse_metric_invalid',
      message: 'Warehouse stock metric not supported: "inStok"',
      details: {
        propertyName: 'a01_instock',
        warehouseCode: 'A01',
        metric: 'inStok',
        validMetrics: ['available', 'inStock', 'committed', 'ordered'],
      },
    }));
  });

  it('records once per entry, not once per product', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: [invalid[0]] })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({
      mappedRecords: buildRecords(3),
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(1);
  });

  it('records the warning even when every entry is invalid and no field survives', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: invalid, fields: [] })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({
      mappedRecords: records,
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(2);
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({});
  });

  it('does not record anything when the config is fully valid', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy()) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({
      mappedRecords: buildRecords(1),
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).not.toHaveBeenCalled();
  });

  it('enriches normally when no syncWarningRepository is injected', async () => {
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: invalid })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({
      mappedRecords: records,
      objectType: 'product',
      tenantModels: buildTenantModels(),
    });

    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });

  it('still writes the valid properties when recording a warning fails', async () => {
    const syncWarningRepository = { record: jest.fn().mockRejectedValue(new Error('mongo down')) };
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: [invalid[0]] })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({
      mappedRecords: records,
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`

Expected: FAIL. `record` no se llama nunca porque el adapter todavía no conoce `syncWarningRepository`.

- [ ] **Step 3: Implementar**

En `src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js`:

Agregar al import de constantes de la línea 2:

```js
import {
  B1_STOCK_METRICS,
  WAREHOUSE_METRIC_INVALID_WARNING,
  WAREHOUSE_STOCK_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';
```

En el constructor, agregar el parámetro con el mismo patrón de dependencia opcional que usan cinco use-cases del repo (`SendMappedItemsToHubspot.js:81`):

```js
  constructor({
    strategyFactory,
    configRepository,
    resolverFactory = null,
    // Opcional a proposito: sin el, el enrich sigue funcionando y el aviso solo
    // queda en el log. Se cablea en sap-sync.composition.js.
    syncWarningRepository = null,
    logger = console,
  }) {
    ...
    this.syncWarningRepository = syncWarningRepository;
```

Cambiar la firma de `enrich` y el bloque de normalización:

```js
  async enrich({
    mappedRecords,
    objectType,
    tenantModels,
    clientConfigId = null,
    syncLogId = null,
  }) {
```

Y dentro del `try`, reemplazar las dos líneas de normalización por:

```js
      // Se juntan acá y se reportan ANTES del return temprano de
      // fields.length === 0: si todas las entradas del tenant estan mal
      // escritas, fields queda vacio y ese return se llevaria puesto el aviso,
      // que es justo el caso donde mas se necesita.
      const invalidMetricFields = [];
      const fields = strategy.normalizeFields(rawFields, {
        onInvalidMetric: (entry) => invalidMetricFields.push(entry),
      });
      const exclusions = strategy.normalizeExclusions(rawExclusions);

      await this.recordInvalidMetricWarnings({
        invalidMetricFields,
        tenantModels,
        clientConfigId,
        syncLogId,
      });
```

Y agregar el método, después de `enrich` y antes de `applyToAllRecords`:

```js
  // Un documento de SyncWarnings por entrada mal configurada, una vez por
  // corrida y no una por producto.
  //
  // El try/catch por iteracion no es redundante con el que envuelve a enrich:
  // este metodo corre ANTES del bucle que escribe las propiedades, asi que un
  // fallo al registrar el aviso que subiera hasta el catch de enrich se
  // llevaria puesto el enriquecimiento de las entradas que SI estan bien.
  // MongooseSyncWarningRepository.record ya resuelve null ante cualquier fallo;
  // esto cubre un repositorio inyectado que no lo haga.
  async recordInvalidMetricWarnings({
    invalidMetricFields,
    tenantModels,
    clientConfigId,
    syncLogId,
  }) {
    if (invalidMetricFields.length === 0) {
      return;
    }

    this.logger.error?.('Warehouse stock metric not supported', {
      invalidMetricFields,
    });

    if (typeof this.syncWarningRepository?.record !== 'function') {
      return;
    }

    for (const { propertyName, warehouseCode, metric } of invalidMetricFields) {
      try {
        await this.syncWarningRepository.record({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType: 'product',
          // La config es del tenant, no de un producto puntual.
          sapId: null,
          code: WAREHOUSE_METRIC_INVALID_WARNING,
          message: `Warehouse stock metric not supported: "${metric}"`,
          details: {
            propertyName,
            warehouseCode,
            metric,
            validMetrics: Object.values(B1_STOCK_METRICS),
          },
        });
      } catch (error) {
        this.logger.error?.('Warehouse stock metric warning not recorded', {
          propertyName,
          error: error?.message,
        });
      }
    }
  }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`

Expected: PASS, los 6 nuevos y los 8 que ya estaban en el archivo.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js
git commit -m "feat: el enricher de bodegas registra un SyncWarning por metric invalida"
```

---

### Task 5: El use-case le pasa `clientConfigId` y `syncLogId`

**Files:**
- Modify: `src/application/use-cases/SyncSapConfigToHubspot.js:213`
- Test: `tests/unit/application/syncSapConfigToHubspot.test.js`

**Interfaces:**
- Consumes: la firma de `enrich` de la Task 4.
- Produces: nada nuevo.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/unit/application/syncSapConfigToHubspot.test.js`, dentro del `describe('SyncSapConfigToHubspot')`:

```js
  it('passes clientConfigId and syncLogId to the warehouse stock enricher', async () => {
    const config = createConfig({ objectType: 'product' });
    const tenantContext = { tenantKey: 'tenant-a', tenantModels: {} };
    const warehouseStockEnricher = { enrich: jest.fn().mockResolvedValue(undefined) };

    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: { fetchData: jest.fn().mockResolvedValue([{ ItemCode: 'P1' }]) },
      mappingRepository: {
        ensureDefaultMappings: jest.fn().mockResolvedValue([]),
        findMappings: jest.fn().mockResolvedValue([{ sourceField: 'ItemCode', targetField: 'idsap' }]),
        mapRecords: jest.fn().mockResolvedValue([{ properties: { idsap: 'P1' } }]),
      },
      hubspotSyncTarget: {
        send: jest.fn().mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0 }),
      },
      syncLogRepository: {
        start: jest.fn().mockResolvedValue({ _id: 'log-1' }),
        finish: jest.fn().mockResolvedValue(null),
      },
      clientConfigRepository: {
        findById: jest.fn(),
        markSyncSucceeded: jest.fn().mockResolvedValue(null),
        markSyncFailed: jest.fn(),
      },
      hubspotCredentialRepository: {
        findByClientConfig: jest.fn().mockResolvedValue({ _id: 'cred-1' }),
        findById: jest.fn(),
      },
      warehouseStockEnricher,
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    await useCase.execute({ config, tenantContext });

    // Sin estos dos, el SyncWarning se escribe huerfano: sin corrida y sin
    // tenant al que atribuirlo.
    expect(warehouseStockEnricher.enrich).toHaveBeenCalledWith(expect.objectContaining({
      objectType: 'product',
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    }));
  });
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/application/syncSapConfigToHubspot.test.js`

Expected: FAIL. El objeto recibido no tiene `clientConfigId` ni `syncLogId`.

- [ ] **Step 3: Implementar**

En `src/application/use-cases/SyncSapConfigToHubspot.js`, la llamada de la línea 213:

```js
      if (this.warehouseStockEnricher) {
        await this.warehouseStockEnricher.enrich({
          mappedRecords: mappedRecordsWithRawSap,
          objectType,
          tenantModels: tenantContext?.tenantModels,
          // Para que el SyncWarning de una metric mal configurada quede atado a
          // esta corrida y a este tenant.
          clientConfigId,
          syncLogId: syncLog?.id ?? syncLog?._id ?? null,
        });
      }
```

`clientConfigId` ya está en scope desde la línea 54; el cálculo de `syncLogId` es el mismo que usa la línea 250 para `sendMappedRecords`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/application/syncSapConfigToHubspot.test.js`

Expected: PASS, el nuevo y los que ya estaban.

- [ ] **Step 5: Commit**

```bash
git add src/application/use-cases/SyncSapConfigToHubspot.js tests/unit/application/syncSapConfigToHubspot.test.js
git commit -m "feat: SyncSapConfigToHubspot pasa clientConfigId y syncLogId al enricher de bodegas"
```

---

### Task 6: Cablear el repositorio de avisos en la composición

Esta es la tarea que evita el único modo de fallo silencioso del cambio: sin la clave, todo funciona, todos los tests de las tareas 1-5 pasan, y el aviso nunca se escribe en producción.

**Files:**
- Modify: `src/composition/sap-sync.composition.js` (import nuevo + líneas 119-124)
- Test: `tests/unit/composition/sapSyncComposition.test.js`

**Interfaces:**
- Consumes: el parámetro `syncWarningRepository` del constructor del adapter (Task 4).
- Produces: nada nuevo.

- [ ] **Step 1: Escribir el test que falla**

`sap-sync.composition.js` hoy **no importa** `MongooseSyncWarningRepository` en absoluto (el que lo hace es `hubspot-sync.composition.js:68`). La aserción va en el `describe` de verificación textual que ya existe al final del archivo de test (línea 150), que es el patrón del repo para esto — un `expect.any(Object)` no detecta una clave sin cablear:

```js
  it('inyecta syncWarningRepository en WarehouseStockEnrichmentAdapter', () => {
    expect(source).toMatch(/import MongooseSyncWarningRepository from/);
    expect(source).toMatch(
      /new WarehouseStockEnrichmentAdapter\(\{[\s\S]{0,400}?syncWarningRepository:\s*new MongooseSyncWarningRepository\(\)/
    );
  });
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/composition/sapSyncComposition.test.js`

Expected: FAIL en las dos aserciones: no hay import y no hay clave.

- [ ] **Step 3: Implementar**

En `src/composition/sap-sync.composition.js`, agregar el import junto a los otros de repositorios Mongoose (cerca de la línea 30, donde está `MongooseSyncLogRepository`):

```js
import MongooseSyncWarningRepository from '#infrastructure/database/repositories/MongooseSyncWarningRepository.js';
```

Y la clave al constructor del adapter (líneas 119-124):

```js
    warehouseStockEnricher: assertPort(
      new WarehouseStockEnrichmentAdapter({
        strategyFactory: warehouseStockStrategyFactory,
        configRepository: new WarehouseStockConfigRepository(),
        syncWarningRepository: new MongooseSyncWarningRepository(),
        logger,
      }),
      SapRecordEnricherPort
    ),
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/unit/composition/sapSyncComposition.test.js`

Expected: PASS.

- [ ] **Step 5: Verificar a ojo el archivo**

Abrir `src/composition/sap-sync.composition.js` y confirmar que la clave `syncWarningRepository` está literalmente dentro del `new WarehouseStockEnrichmentAdapter({...})` y no en el bloque del enricher de lotes, que está inmediatamente debajo y tiene una forma muy parecida. La aserción por regex con ventana de 400 caracteres podría matchear cruzado entre los dos bloques.

- [ ] **Step 6: Commit**

```bash
git add src/composition/sap-sync.composition.js tests/unit/composition/sapSyncComposition.test.js
git commit -m "feat: cablea MongooseSyncWarningRepository en el enricher de bodegas"
```

---

### Task 7: Documentar la config y correr la suite completa

**Files:**
- Modify: `configuration_examples.md`
- Test: toda la suite de `tests/`

**Interfaces:**
- Consumes: el comportamiento de las tareas 1-6.
- Produces: nada de código.

- [ ] **Step 1: Escribir la entrada del catálogo**

Agregar a `configuration_examples.md`, siguiendo el formato del archivo (línea `Detalle: <clave>`, prosa, y el `{ key, value }` de ejemplo). Va después de la entrada de `batchExpiry`:

````markdown
Detalle: fieldsWareHouseHS
Qué bodegas de SAP se llevan a propiedades numéricas del producto en HubSpot, y qué número va en cada una. **Cada entrada de la lista es UNA propiedad**: `value` es el nombre interno de la propiedad en HubSpot y `valueSAP` es el código de bodega en SAP (si falta `valueSAP`, se deduce del nombre de la propiedad, pero sólo si termina en `_stock`: `a01_stock` → `A01`; cualquier otro nombre se descarta). `metric` decide el número, y **sólo aplica a SAP Business One**: `'available'` (el default, y lo que aplica a toda config que no declare `metric`) es `InStock - Committed + Ordered`, o sea que cuenta lo pedido a proveedor como disponible; `'inStock'`, `'committed'` y `'ordered'` son el campo crudo de `ItemWarehouseInfoCollection` sin aritmética. Se compara sin distinguir mayúsculas, así que `'InStock'` e `'instock'` son lo mismo. Para tener tres columnas de la misma bodega se ponen tres entradas con el mismo `valueSAP` y `value` distintos. Una `metric` que no existe (un typo como `'inStok'`) **descarta esa entrada y escribe un documento en la colección `SyncWarnings`** con `code: 'warehouse_metric_invalid'`, atado al `syncLogId` de la corrida: la propiedad queda sin escribir en vez de recibir un número equivocado, que en una columna de inventario nadie detecta mirando. Una bodega listada en `excludedWarehouses` sale en `0` en cualquier métrica, aunque SAP reporte existencias. Una bodega configurada que no aparece en el producto también sale en `0`. Las propiedades tienen que existir en el portal **antes** del primer sync: una propiedad inexistente hace fallar el lote de 100 completo en `batchCreateProducts`. En SAP S/4HANA `metric` no se lee; el eje equivalente es `stockType` (ver `warehouseStockStrategy`).
{
  "key": "fieldsWareHouseHS",
  "value": [
    { "label": "A01 En stock",     "value": "a01_instock",   "valueSAP": "A01", "metric": "inStock" },
    { "label": "A01 Comprometido", "value": "a01_committed", "valueSAP": "A01", "metric": "committed" },
    { "label": "A01 Solicitado",   "value": "a01_ordered",   "valueSAP": "A01", "metric": "ordered" },
    { "label": "Bodega B09",       "value": "b09_stock",     "valueSAP": "B09" }
  ]
}
````

- [ ] **Step 2: Correr la suite completa acotada al repo**

Run (ver el comando canónico en Global Constraints; `npm test` no funciona en este entorno): jest acotado a `tests/`

Expected: PASS. Comparar el número de suites con el de `main` antes de empezar: tiene que ser el mismo, y `tests/unit/warehouseStock.test.js` tiene que aparecer en verde **sin haber sido modificado nunca**.

- [ ] **Step 3: Verificar que la prueba de regresión sigue intacta**

Run: `git diff main --stat -- tests/unit/warehouseStock.test.js`

Expected: sin salida. Si aparece algo, alguna tarea cambió el comportamiento de una config existente y hay que volver atrás a averiguar cuál.

- [ ] **Step 4: Verificar que S/4 no se tocó**

Run: `git diff main --stat -- src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js`

Expected: sin salida.

- [ ] **Step 5: Commit**

```bash
git add configuration_examples.md
git commit -m "docs: catalogo de fieldsWareHouseHS con las cuatro metricas de B1"
```

---

## Verificación final

- [ ] jest sobre toda la suite propia del repo (sin `--testPathPatterns`) en verde contra la baseline: 5 suites rojas, las mismas cinco de Global Constraints, ninguna de bodegas
- [ ] `git diff main --stat -- tests/unit/warehouseStock.test.js` vacío
- [ ] `git diff main --stat -- src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js` vacío
- [ ] `grep -n "syncWarningRepository" src/composition/sap-sync.composition.js` muestra la clave dentro del bloque de `WarehouseStockEnrichmentAdapter`
- [ ] `git diff main --stat` no incluye ningún archivo de la feature de listas de precios S/4 que estaba sin commitear en el working tree
