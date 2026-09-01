# Fórmula de disponible por bodega configurable por tenant (B1) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la métrica `available` de `fieldsWareHouseHS` en SAP Business One se calcule con una fórmula `{ add: [...], subtract: [...] }` configurable por tenant (`Configuration` key `warehouseAvailableFormula`), con default `InStock - Committed + Ordered`, sembrada al nacer el tenant, y que una fórmula inválida omita las `available` de la corrida y deje un `SyncWarning`.

**Architecture:** La fórmula entra como cuarto parámetro opcional (`{ availableFormula }`) en `buildB1WarehouseStockProperties` y baja hasta `getWarehouseAvailableStock`; con default en cada firma, un llamador viejo sigue dando los números de hoy. La strategy B1 gana `normalizeAvailableFormula` (la S/4 lo implementa devolviendo `undefined`), el port lo declara, y los dos caminos de lectura —`WarehouseStockConfigRepository` para el sync de productos y `warehouseStock.js` (vía `tenantConfigurationService.getValue`) para line items y el fallback de `product.handler`— la leen y la pasan. `ensureTenantConfigurations` siembra el default.

**Tech Stack:** Node ESM, Mongoose, Jest 30 (`--experimental-vm-modules`).

**Spec:** `docs/superpowers/specs/2026-09-01-b1-warehouse-available-formula-design.md`. Leerlo entero antes de empezar; las decisiones (por qué no cae al default, por qué la exclusión gana, por qué S/4 no lee la clave) están ahí y no se repiten acá.

## Global Constraints

- Clave de config: `warehouseAvailableFormula`. Forma: `{ add: string[], subtract: string[] }`.
- Campos válidos, en su forma canónica exacta: `InStock`, `Committed`, `Ordered`. Comparación con `trim()` + minúsculas.
- Default: `{ add: ['InStock', 'Ordered'], subtract: ['Committed'] }`. Documento ausente/`null` = default.
- Motivos de invalidez (`reason`), literales: `not_an_object`, `add_not_an_array`, `subtract_not_an_array`, `unknown_field:<nombre>`, `field_in_both_lists:<nombre>`, `empty_formula`.
- Código del `SyncWarning`: `warehouse_available_formula_invalid`. Mensaje: `Warehouse available formula invalid: <reason>`. `details: { raw, reason, validFields: ['InStock', 'Committed', 'Ordered'] }`, `objectType: 'product'`, `sapId: null`.
- Fórmula inválida ⇒ las entradas `available` **no se emiten**; `inStock`/`committed`/`ordered` y la exclusión (`0`) siguen igual. Nunca caer al default.
- S/4HANA no lee la clave ni avisa.
- Ningún número que hoy reciben Distelsa, AMC o Printer cambia. Los tests que afirman números (`distelsa_stock: 8`, `A01_stock: 8`, `b12_stock: 1400`…) no se editan.
- **Jest se corre así, desde Git Bash, en el checkout principal** (ver `memory/jest-picks-up-worktree-tests.md`; `npm test` no funciona en Windows):

  ```bash
  NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='<patron>'
  ```

  Baseline de fallos preexistentes en `main` (5 suites): `tests/integration/internalTenant.test.js`, `tests/unit/application/sendMappedItemsToHubspot.test.js`, `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js`, `tests/unit/serviceLayerService.test.js`. "Verde" = esas cinco y sólo esas cinco.
- Commits en español, estilo del repo (`feat:`, `test:`, `docs:`), con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` al final. Rama: `claude/inventory-availability-config-efa0ef`.

---

## Mapa de archivos

| Archivo | Responsabilidad en este cambio |
|---|---|
| `src/domain/warehouses/warehouse-stock-strategy.constants.js` | Clave, campos válidos, default, código del warning |
| `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js` | `normalizeB1AvailableFormula`, fórmula en `getWarehouseAvailableStock`/`getWarehouseMetricValue`/`buildB1WarehouseStockProperties`, método nuevo en la clase |
| `src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js` | `normalizeAvailableFormula()` → `undefined` |
| `src/application/ports/sap/warehouse-stock-strategy.port.js` | Declara `normalizeAvailableFormula` |
| `src/infrastructure/config/WarehouseStockConfigRepository.js` | Lee la 4ª clave → `rawAvailableFormula` |
| `src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js` | Normaliza, avisa, pasa `availableFormula` a `buildProperties` |
| `src/infrastructure/hubspot/warehouseStock.js` | `resolveHubspotAvailableFormula`, pasa la fórmula en los dos builders |
| `src/infrastructure/hubspot/handlers/product.handler.js` | `buildPreprocessContext` y `preprocess` llevan `availableFormula` |
| `src/infrastructure/tenants/tenantProvisioning.js` | Siembra el default |
| `configuration_examples.md` | Entrada nueva + ajuste a `fieldsWareHouseHS` |

Tests: `tests/unit/domain/b1ItemWarehouseStrategy.test.js`, `tests/unit/domain/s4PlantStorageLocationStrategy.test.js`, `tests/unit/infrastructure/warehouseStockConfigRepository.test.js`, `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`, `tests/unit/warehouseStock.test.js`, `tests/unit/product.handler.test.js`, `tests/unit/infrastructure/tenantProvisioningBpKeys.test.js`.

---

### Task 1: Constantes y `normalizeB1AvailableFormula` + `getWarehouseAvailableStock(warehouse, formula)`

**Files:**
- Modify: `src/domain/warehouses/warehouse-stock-strategy.constants.js:46-63`
- Modify: `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js:8-11` (imports), `:47-53` (`getWarehouseAvailableStock`)
- Test: `tests/unit/domain/b1ItemWarehouseStrategy.test.js`

**Interfaces:**
- Produces (constantes): `WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY = 'warehouseAvailableFormula'`, `B1_WAREHOUSE_STOCK_FIELDS` (frozen `['InStock','Committed','Ordered']`), `DEFAULT_B1_AVAILABLE_FORMULA` (frozen `{ add: ['InStock','Ordered'], subtract: ['Committed'] }`), `WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING = 'warehouse_available_formula_invalid'`.
- Produces (strategy): `normalizeB1AvailableFormula(raw, { onInvalid } = {}) → { add: string[], subtract: string[] } | null`, donde `onInvalid({ raw, reason })` se llama una vez cuando devuelve `null`. `getWarehouseAvailableStock(warehouse, formula = DEFAULT_B1_AVAILABLE_FORMULA) → number`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tests/unit/domain/b1ItemWarehouseStrategy.test.js`, y sumar `normalizeB1AvailableFormula` al `import { ... }` de la línea 2-11:

```js
import {
  DEFAULT_B1_AVAILABLE_FORMULA,
  B1_WAREHOUSE_STOCK_FIELDS,
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
  WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING,
} from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';

describe('constantes de la formula de disponible', () => {
  it('expone la clave, los campos validos, el default y el codigo del warning', () => {
    expect(WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY).toBe('warehouseAvailableFormula');
    expect(B1_WAREHOUSE_STOCK_FIELDS).toEqual(['InStock', 'Committed', 'Ordered']);
    expect(DEFAULT_B1_AVAILABLE_FORMULA).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
    expect(Object.isFrozen(DEFAULT_B1_AVAILABLE_FORMULA)).toBe(true);
    expect(WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING).toBe('warehouse_available_formula_invalid');
  });
});

describe('normalizeB1AvailableFormula', () => {
  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };

  it('documento ausente o null = default historico', () => {
    expect(normalizeB1AvailableFormula(undefined)).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
    expect(normalizeB1AvailableFormula(null)).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
  });

  it('canonicaliza nombres sin distinguir mayusculas ni espacios', () => {
    expect(normalizeB1AvailableFormula({ add: [' instock '], subtract: ['COMMITTED'] })).toEqual(NOELITO);
  });

  it('lista ausente = vacia, y los duplicados dentro de una lista se colapsan', () => {
    expect(normalizeB1AvailableFormula({ add: ['InStock', 'InStock'] })).toEqual({ add: ['InStock'], subtract: [] });
  });

  it.each([
    ['InStock - Committed', 'not_an_object'],
    [['InStock'], 'not_an_object'],
    [42, 'not_an_object'],
    [{ add: 'InStock' }, 'add_not_an_array'],
    [{ add: ['InStock'], subtract: 'Committed' }, 'subtract_not_an_array'],
    [{ add: ['InStok'] }, 'unknown_field:InStok'],
    [{ add: ['InStock'], subtract: ['MinimalStock'] }, 'unknown_field:MinimalStock'],
    [{ add: ['InStock'], subtract: ['instock'] }, 'field_in_both_lists:InStock'],
    [{ add: [], subtract: [] }, 'empty_formula'],
    [{}, 'empty_formula'],
  ])('devuelve null y reporta %j como %s', (raw, reason) => {
    const onInvalid = jest.fn();

    expect(normalizeB1AvailableFormula(raw, { onInvalid })).toBeNull();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid).toHaveBeenCalledWith({ raw, reason });
  });

  it('sin onInvalid una formula invalida devuelve null y no tira', () => {
    expect(() => normalizeB1AvailableFormula({ add: ['InStok'] })).not.toThrow();
    expect(normalizeB1AvailableFormula({ add: ['InStok'] })).toBeNull();
  });
});

describe('getWarehouseAvailableStock con formula', () => {
  const warehouse = { InStock: 7, Committed: 1, Ordered: 2 };

  it('aplica la formula de Noelito', () => {
    expect(getWarehouseAvailableStock(warehouse, { add: ['InStock'], subtract: ['Committed'] })).toBe(6);
  });

  it('acepta una lista vacia', () => {
    expect(getWarehouseAvailableStock(warehouse, { add: ['InStock'], subtract: [] })).toBe(7);
  });

  it('puede dar negativo', () => {
    expect(getWarehouseAvailableStock(warehouse, { add: ['Ordered'], subtract: ['InStock', 'Committed'] })).toBe(-6);
  });

  it('bodega ausente da 0 con cualquier formula', () => {
    expect(getWarehouseAvailableStock(undefined, { add: ['InStock'], subtract: ['Committed'] })).toBe(0);
  });

  it('campo ausente en la bodega cuenta como 0', () => {
    expect(getWarehouseAvailableStock({ InStock: 5 }, { add: ['InStock', 'Ordered'], subtract: ['Committed'] })).toBe(5);
  });
});
```

Los dos tests existentes de `getWarehouseAvailableStock` (líneas 13-21) quedan intactos: son la regresión del default.

- [ ] **Step 2: Correr y ver que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]domain[\\/]b1ItemWarehouseStrategy'
```

Esperado: FAIL — `SyntaxError: The requested module ... does not provide an export named 'DEFAULT_B1_AVAILABLE_FORMULA'` (o `normalizeB1AvailableFormula`).

- [ ] **Step 3: Constantes**

En `src/domain/warehouses/warehouse-stock-strategy.constants.js`, después de la línea 46 (`WAREHOUSE_METRIC_INVALID_WARNING`) y antes del comentario de `QUANTITY_DECIMALS`:

```js
// Documento por tenant ({ key: 'warehouseAvailableFormula', value: { add: [...],
// subtract: [...] } }) que define que significa la metrica `available` en B1:
// suma de los campos de add menos suma de los de subtract.
export const WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY = 'warehouseAvailableFormula';

// Los unicos campos de ItemWarehouseInfoCollection que pueden entrar en la
// formula. Los demas numeros del payload (MinimalStock, Counted...) no son
// stock disponible, y abrir la lista solo agranda el espacio de configs
// plausibles-pero-equivocadas.
export const B1_WAREHOUSE_STOCK_FIELDS = Object.freeze(['InStock', 'Committed', 'Ordered']);

// InStock - Committed + Ordered: el comportamiento historico. Documento ausente
// = esta formula, asi que ningun tenant existente cambia hasta que la edite.
export const DEFAULT_B1_AVAILABLE_FORMULA = Object.freeze({
  add: Object.freeze(['InStock', 'Ordered']),
  subtract: Object.freeze(['Committed']),
});

// code del SyncWarning cuando warehouseAvailableFormula no pasa la validacion.
// Las entradas `available` de esa corrida no se escriben: caer al default
// escribiria un numero plausible pero distinto del que el tenant pidio.
export const WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING = 'warehouse_available_formula_invalid';
```

Y en el `export default { ... }` del final agregar las cuatro:

```js
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
  B1_WAREHOUSE_STOCK_FIELDS,
  DEFAULT_B1_AVAILABLE_FORMULA,
  WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING,
```

- [ ] **Step 4: `normalizeB1AvailableFormula` y `getWarehouseAvailableStock(warehouse, formula)`**

En `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`, ampliar el import de las líneas 8-11:

```js
import {
  B1_STOCK_METRICS,
  B1_WAREHOUSE_STOCK_FIELDS,
  DEFAULT_B1_AVAILABLE_FORMULA,
  DEFAULT_B1_STOCK_METRIC,
} from '../warehouse-stock-strategy.constants.js';
```

Reemplazar `getWarehouseAvailableStock` (líneas 47-53) por:

```js
const STOCK_FIELD_BY_LOWERCASE = new Map(
  B1_WAREHOUSE_STOCK_FIELDS.map((field) => [field.toLowerCase(), field])
);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Un lado de la formula (add o subtract). Devuelve { fields } canonicos y sin
// duplicados, o { reason } con el primer problema encontrado.
function normalizeFormulaSide(rawList, sideName) {
  if (rawList === undefined || rawList === null) {
    return { fields: [] };
  }

  if (!Array.isArray(rawList)) {
    return { reason: `${sideName}_not_an_array` };
  }

  const fields = [];

  for (const entry of rawList) {
    const trimmed = String(entry ?? '').trim();
    const canonical = STOCK_FIELD_BY_LOWERCASE.get(trimmed.toLowerCase());

    if (!canonical) {
      return { reason: `unknown_field:${trimmed}` };
    }

    if (!fields.includes(canonical)) {
      fields.push(canonical);
    }
  }

  return { fields };
}

// undefined/null -> default historico. Cualquier otra cosa se valida entera y,
// si falla, devuelve null tras avisar UNA vez con el primer motivo. No cae al
// default a proposito: un typo daria un numero plausible pero equivocado.
export function normalizeB1AvailableFormula(raw, { onInvalid } = {}) {
  if (raw === undefined || raw === null) {
    return DEFAULT_B1_AVAILABLE_FORMULA;
  }

  const invalid = (reason) => {
    onInvalid?.({ raw, reason });
    return null;
  };

  if (!isPlainObject(raw)) {
    return invalid('not_an_object');
  }

  const add = normalizeFormulaSide(raw.add, 'add');

  if (add.reason) {
    return invalid(add.reason);
  }

  const subtract = normalizeFormulaSide(raw.subtract, 'subtract');

  if (subtract.reason) {
    return invalid(subtract.reason);
  }

  const overlap = add.fields.find((field) => subtract.fields.includes(field));

  if (overlap) {
    return invalid(`field_in_both_lists:${overlap}`);
  }

  if (add.fields.length === 0 && subtract.fields.length === 0) {
    return invalid('empty_formula');
  }

  return { add: add.fields, subtract: subtract.fields };
}

function sumWarehouseFields(warehouse, fields) {
  return (Array.isArray(fields) ? fields : [])
    .reduce((total, field) => total + Number(warehouse?.[field] ?? 0), 0);
}

// Con un solo argumento da exactamente InStock - Committed + Ordered, que es lo
// que todo llamador y test existente espera. El segundo argumento es la
// formula ya normalizada (nunca la cruda de Mongo).
export function getWarehouseAvailableStock(warehouse, formula = DEFAULT_B1_AVAILABLE_FORMULA) {
  return sumWarehouseFields(warehouse, formula?.add) - sumWarehouseFields(warehouse, formula?.subtract);
}
```

Nota: el orden de suma cambia de `(inStock - committed) + ordered` a `(inStock + ordered) - committed`. Con enteros y con los decimales típicos de B1 da lo mismo; con flotantes raros podría diferir en el último bit **una sola vez** (la primera corrida tras el deploy) y después ser estable. No se agrega redondeo: el spec lo excluye.

- [ ] **Step 5: Correr y ver que pasa**

Mismo comando del Step 2. Esperado: PASS, incluyendo los 2 tests viejos de `getWarehouseAvailableStock` y los 38 preexistentes del archivo.

- [ ] **Step 6: Commit**

```bash
git add src/domain/warehouses/warehouse-stock-strategy.constants.js src/domain/warehouses/strategies/b1-item-warehouse.strategy.js tests/unit/domain/b1ItemWarehouseStrategy.test.js
git commit -m "feat: normalizeB1AvailableFormula y formula opcional en getWarehouseAvailableStock

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: La fórmula baja por `getWarehouseMetricValue` y `buildB1WarehouseStockProperties`; strategies y port

**Files:**
- Modify: `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js` — `getWarehouseMetricValue` (hoy línea 76), `buildB1WarehouseStockProperties` (hoy línea 148), clase `B1ItemWarehouseStrategy` (hoy línea 194)
- Modify: `src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js:261-284`
- Modify: `src/application/ports/sap/warehouse-stock-strategy.port.js:8-15`
- Test: `tests/unit/domain/b1ItemWarehouseStrategy.test.js`, `tests/unit/domain/s4PlantStorageLocationStrategy.test.js`

**Interfaces:**
- Consumes: `normalizeB1AvailableFormula`, `getWarehouseAvailableStock(warehouse, formula)`, `DEFAULT_B1_AVAILABLE_FORMULA`, `B1_STOCK_METRICS`, `DEFAULT_B1_STOCK_METRIC` (Task 1 y existentes).
- Produces: `getWarehouseMetricValue(warehouse, metric = DEFAULT_B1_STOCK_METRIC, formula = DEFAULT_B1_AVAILABLE_FORMULA)`; `buildB1WarehouseStockProperties(warehouseItems, warehouseFields, exclusions = [], { availableFormula = DEFAULT_B1_AVAILABLE_FORMULA } = {})`; `B1ItemWarehouseStrategy#normalizeAvailableFormula(rawValue, options)` y `#buildProperties({ record, fields, exclusions, availableFormula })`; `S4PlantStorageLocationStrategy#normalizeAvailableFormula() → undefined`; el port declara `'normalizeAvailableFormula'`.

- [ ] **Step 1: Tests que fallan (B1)**

Agregar al final de `tests/unit/domain/b1ItemWarehouseStrategy.test.js`:

```js
describe('getWarehouseMetricValue con formula', () => {
  const warehouse = { InStock: 7, Committed: 1, Ordered: 2 };
  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };

  it('available usa la formula recibida', () => {
    expect(getWarehouseMetricValue(warehouse, 'available', NOELITO)).toBe(6);
    expect(getWarehouseMetricValue(warehouse, undefined, NOELITO)).toBe(6);
  });

  it('las metricas crudas ignoran la formula', () => {
    expect(getWarehouseMetricValue(warehouse, 'inStock', NOELITO)).toBe(7);
    expect(getWarehouseMetricValue(warehouse, 'committed', NOELITO)).toBe(1);
    expect(getWarehouseMetricValue(warehouse, 'ordered', NOELITO)).toBe(2);
  });
});

describe('buildB1WarehouseStockProperties con formula', () => {
  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };
  const items = [
    { WarehouseCode: 'A01', InStock: 10, Committed: 4, Ordered: 100 },
    { WarehouseCode: 'B09', InStock: 66, Committed: 0, Ordered: 0 },
  ];
  const fields = [
    { warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'available' },
    { warehouseCode: 'A01', propertyName: 'a01_instock', metric: 'inStock' },
    { warehouseCode: 'B09', propertyName: 'b09_stock', metric: 'available' },
  ];

  it('aplica la formula a las entradas available y deja las crudas como estan', () => {
    expect(buildB1WarehouseStockProperties(items, fields, [], { availableFormula: NOELITO })).toEqual({
      a01_stock: 6,
      a01_instock: 10,
      b09_stock: 66,
    });
  });

  it('sin cuarto argumento da los numeros historicos', () => {
    expect(buildB1WarehouseStockProperties(items, fields)).toEqual({
      a01_stock: 106,
      a01_instock: 10,
      b09_stock: 66,
    });
  });

  it('con formula invalida (null) omite las available y conserva las crudas', () => {
    const properties = buildB1WarehouseStockProperties(items, fields, [], { availableFormula: null });

    expect(properties).toEqual({ a01_instock: 10 });
    expect(Object.prototype.hasOwnProperty.call(properties, 'a01_stock')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(properties, 'b09_stock')).toBe(false);
  });

  it('con formula invalida, una bodega excluida sigue saliendo en 0', () => {
    expect(buildB1WarehouseStockProperties(items, fields, ['B09'], { availableFormula: null })).toEqual({
      a01_instock: 10,
      b09_stock: 0,
    });
  });

  it('con formula invalida, un field a mano sin metric tambien es available y se omite', () => {
    const legacyFields = [{ warehouseCode: 'A01', propertyName: 'a01_stock' }];

    expect(buildB1WarehouseStockProperties(items, legacyFields, [], { availableFormula: null })).toEqual({});
  });
});

describe('B1ItemWarehouseStrategy — formula de disponible', () => {
  it('normalizeAvailableFormula delega y pasa options', () => {
    const strategy = new B1ItemWarehouseStrategy();
    const onInvalid = jest.fn();

    expect(strategy.normalizeAvailableFormula({ add: ['instock'], subtract: ['committed'] }))
      .toEqual({ add: ['InStock'], subtract: ['Committed'] });
    expect(strategy.normalizeAvailableFormula({ add: ['InStok'] }, { onInvalid })).toBeNull();
    expect(onInvalid).toHaveBeenCalledWith({ raw: { add: ['InStok'] }, reason: 'unknown_field:InStok' });
  });

  it('buildProperties aplica availableFormula y sin ella usa el default', () => {
    const strategy = new B1ItemWarehouseStrategy();
    const fields = strategy.normalizeFields([{ value: 'a01_stock', valueSAP: 'A01' }]);
    const record = { rawSapData: { ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', InStock: 10, Committed: 4, Ordered: 100 }] } };

    expect(strategy.buildProperties({ record, fields, availableFormula: { add: ['InStock'], subtract: ['Committed'] } }))
      .toEqual({ a01_stock: 6 });
    expect(strategy.buildProperties({ record, fields })).toEqual({ a01_stock: 106 });
  });
});
```

Y en el test existente `implements the WarehouseStockStrategyPort contract` (hoy línea 287), agregar `'normalizeAvailableFormula'` al array de métodos.

- [ ] **Step 2: Tests que fallan (S/4)**

En `tests/unit/domain/s4PlantStorageLocationStrategy.test.js`, dentro del `describe('S4PlantStorageLocationStrategy')` (hoy línea 256), agregar `'normalizeAvailableFormula'` al array del test de contrato (línea 264) y sumar:

```js
  it('normalizeAvailableFormula devuelve undefined y nunca avisa: la formula es un concepto de B1', () => {
    const onInvalid = jest.fn();

    expect(new S4PlantStorageLocationStrategy().normalizeAvailableFormula({ add: ['garbage'] }, { onInvalid }))
      .toBeUndefined();
    expect(onInvalid).not.toHaveBeenCalled();
  });
```

Ese archivo no importa `jest`; agregar `import { jest } from '@jest/globals';` como primera línea.

- [ ] **Step 3: Correr y ver que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]domain[\\/](b1ItemWarehouseStrategy|s4PlantStorageLocationStrategy)'
```

Esperado: FAIL — `strategy.normalizeAvailableFormula is not a function`, y los `toEqual` de `buildB1WarehouseStockProperties` con fórmula dan los números del default.

- [ ] **Step 4: Implementar en la strategy B1**

`getWarehouseMetricValue` (hoy línea 76):

```js
export function getWarehouseMetricValue(
  warehouse,
  metric = DEFAULT_B1_STOCK_METRIC,
  formula = DEFAULT_B1_AVAILABLE_FORMULA
) {
  switch (metric) {
    case B1_STOCK_METRICS.IN_STOCK:
      return Number(warehouse?.InStock ?? 0);
    case B1_STOCK_METRICS.COMMITTED:
      return Number(warehouse?.Committed ?? 0);
    case B1_STOCK_METRICS.ORDERED:
      return Number(warehouse?.Ordered ?? 0);
    default:
      return getWarehouseAvailableStock(warehouse, formula);
  }
}
```

`buildB1WarehouseStockProperties` (hoy línea 148): firma nueva y una rama más dentro del `reduce`, **después** de la exclusión y **antes** de la asignación:

```js
export function buildB1WarehouseStockProperties(
  warehouseItems,
  warehouseFields = DEFAULT_WAREHOUSE_FIELDS,
  exclusions = [],
  { availableFormula = DEFAULT_B1_AVAILABLE_FORMULA } = {}
) {
  const excludedSet = new Set(exclusions);
  const warehousesByCode = new Map(
    (Array.isArray(warehouseItems) ? warehouseItems : [])
      .map((warehouse) => [String(warehouse?.WarehouseCode ?? '').toUpperCase(), warehouse])
      .filter(([warehouseCode]) => warehouseCode)
  );

  return (Array.isArray(warehouseFields) ? warehouseFields : []).reduce((acc, field) => {
    const propertyName = field?.propertyName;
    const warehouseCode = field?.warehouseCode ? String(field.warehouseCode).toUpperCase() : null;

    if (!propertyName || !warehouseCode) {
      return acc;
    }

    if (excludedSet.has(warehouseCode)) {
      acc[propertyName] = 0;
      return acc;
    }

    // Formula invalida: la entrada `available` se omite en vez de escribir un
    // numero con la formula equivocada; HubSpot conserva el ultimo valor. Las
    // metricas crudas no dependen de la formula. El `??` cubre un field armado
    // a mano sin metric (forma historica), que tambien es `available`.
    if (
      availableFormula === null
      && (field.metric ?? DEFAULT_B1_STOCK_METRIC) === B1_STOCK_METRICS.AVAILABLE
    ) {
      return acc;
    }

    acc[propertyName] = getWarehouseMetricValue(
      warehousesByCode.get(warehouseCode),
      field.metric,
      availableFormula
    );
    return acc;
  }, {});
}
```

Clase `B1ItemWarehouseStrategy` (hoy línea 194): agregar el método después de `normalizeExclusions` y cambiar `buildProperties`:

```js
  normalizeAvailableFormula(rawValue, options) {
    return normalizeB1AvailableFormula(rawValue, options);
  }
```

```js
  buildProperties({ record, fields, exclusions = [], availableFormula }) {
    return buildB1WarehouseStockProperties(
      record?.rawSapData?.ItemWarehouseInfoCollection,
      fields,
      exclusions,
      { availableFormula }
    );
  }
```

Cuando `availableFormula` viene `undefined` (llamador viejo), el default del parámetro destructurado lo resuelve a la fórmula histórica. Cuando viene `null` (inválida), se respeta el `null`.

- [ ] **Step 5: Implementar en la strategy S/4 y en el port**

En `src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js`, dentro de la clase (después de `normalizeExclusions`, hoy línea 266-268):

```js
  // La formula de disponible es un concepto de B1 (InStock/Committed/Ordered).
  // En S/4 lo que cuenta lo decide stockType por entrada, asi que aca no hay
  // nada que validar ni avisar. buildProperties ignora el argumento.
  normalizeAvailableFormula() {
    return undefined;
  }
```

En `src/application/ports/sap/warehouse-stock-strategy.port.js`, agregar a `methods` (después de `'normalizeExclusions'`):

```js
    'normalizeAvailableFormula',
```

- [ ] **Step 6: Correr y ver que pasa**

Mismo comando del Step 3. Esperado: PASS en ambos archivos. Verificar que los tests de regresión del spec anterior (`buildB1WarehouseStockProperties` perfil legacy con `b12_stock: 1400`) siguen verdes sin tocarlos.

- [ ] **Step 7: Commit**

```bash
git add src/domain/warehouses/strategies/b1-item-warehouse.strategy.js src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js src/application/ports/sap/warehouse-stock-strategy.port.js tests/unit/domain/b1ItemWarehouseStrategy.test.js tests/unit/domain/s4PlantStorageLocationStrategy.test.js
git commit -m "feat: buildB1WarehouseStockProperties aplica availableFormula y omite available si es invalida

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `WarehouseStockConfigRepository` lee `warehouseAvailableFormula`

**Files:**
- Modify: `src/infrastructure/config/WarehouseStockConfigRepository.js:1-5` (import), `:33-49`
- Test: `tests/unit/infrastructure/warehouseStockConfigRepository.test.js`

**Interfaces:**
- Consumes: `WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY` (Task 1).
- Produces: `getWarehouseStockConfig(...) → { strategyName, rawFields, rawExclusions, rawAvailableFormula }`, con `rawAvailableFormula: null` si no hay documento o si la lectura tira. **Crudo, sin normalizar.**

- [ ] **Step 1: Tests que fallan**

En `tests/unit/infrastructure/warehouseStockConfigRepository.test.js`:

Cambiar el import de constantes (línea 6) a:

```js
import {
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
  WAREHOUSE_STOCK_CONFIG_KEY,
} from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';
```

Editar los `toEqual` de los tests existentes para que incluyan la clave nueva (son `toEqual`, así que sin esto fallan igual; es la única edición a tests viejos de este archivo):

- Test `defaults to the B1 strategy...` (línea 21): `{ strategyName: 'b1_ItemWarehouse', rawFields: null, rawExclusions: null, rawAvailableFormula: null }`.
- Test `reads the configured strategy...` (línea 26): agregar `rawAvailableFormula: null` al objeto esperado.
- Test `reads with a plain findOne per key...` (línea 39): `toHaveBeenCalledTimes(4)` y una aserción más: `expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY });`
- Test `falls back to the default strategy when the read throws` (línea 50): agregar `rawAvailableFormula: null`.

Y agregar:

```js
  it('devuelve la formula de disponible cruda, sin normalizar', async () => {
    const rawAvailableFormula = { add: ['instock'], subtract: ['committed'] };

    await expect(repository.getWarehouseStockConfig({
      tenantModels: models({ [WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY]: rawAvailableFormula }),
    })).resolves.toMatchObject({ rawAvailableFormula });
  });
```

- [ ] **Step 2: Correr y ver que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]infrastructure[\\/]warehouseStockConfigRepository'
```

Esperado: FAIL — los `toEqual` no traen `rawAvailableFormula`, `findOne` se llamó 3 veces.

- [ ] **Step 3: Implementar**

Import (líneas 1-4):

```js
import {
  DEFAULT_WAREHOUSE_STOCK_STRATEGY,
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
  WAREHOUSE_STOCK_CONFIG_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';
```

Cuerpo del `try` y del `catch` (líneas 33-49):

```js
      const [strategyConfig, rawFields, rawExclusions, rawAvailableFormula] = await Promise.all([
        readConfiguration(Configuration, WAREHOUSE_STOCK_CONFIG_KEY),
        readConfiguration(Configuration, WAREHOUSE_FIELDS_CONFIG_KEY),
        readConfiguration(Configuration, EXCLUDED_WAREHOUSES_CONFIG_KEY),
        // Cruda a proposito: quien sabe validarla es la strategy de B1
        // (normalizeAvailableFormula), y la de S/4 la ignora.
        readConfiguration(Configuration, WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY),
      ]);

      const strategyName = String(strategyConfig?.strategy ?? '').trim()
        || DEFAULT_WAREHOUSE_STOCK_STRATEGY;

      return { strategyName, rawFields, rawExclusions, rawAvailableFormula };
    } catch (error) {
      console.error('Warehouse stock config read error:', error);
      return {
        strategyName: DEFAULT_WAREHOUSE_STOCK_STRATEGY,
        rawFields: null,
        rawExclusions: null,
        rawAvailableFormula: null,
      };
    }
```

- [ ] **Step 4: Correr y ver que pasa**

Mismo comando del Step 2. Esperado: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/config/WarehouseStockConfigRepository.js tests/unit/infrastructure/warehouseStockConfigRepository.test.js
git commit -m "feat: WarehouseStockConfigRepository lee warehouseAvailableFormula cruda

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `WarehouseStockEnrichmentAdapter` normaliza, avisa y pasa la fórmula

**Files:**
- Modify: `src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js:2-6` (import), `:55-72` (lectura + normalización + aviso), `:110-115` (`buildProperties`), método nuevo después de `recordInvalidMetricWarnings`
- Test: `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`

**Interfaces:**
- Consumes: `getWarehouseStockConfig → { ..., rawAvailableFormula }` (Task 3); `strategy.normalizeAvailableFormula(raw, { onInvalid })` (Task 2); `WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING`, `B1_WAREHOUSE_STOCK_FIELDS` (Task 1).
- Produces: `strategy.buildProperties({ record, index, fields, exclusions, availableFormula })`; método `recordInvalidFormulaWarning({ invalidFormula, tenantModels, clientConfigId, syncLogId })`.

**Nota de diseño para quien implementa:** varios tests existentes de este archivo construyen strategies mockeadas a mano **sin** `normalizeAvailableFormula` (ej. líneas 55-75). El adapter llama al método sólo si existe (`typeof strategy.normalizeAvailableFormula === 'function'`), y si no, usa `undefined` (= default). Es tolerancia a mocks parciales; las dos strategies reales siempre lo tienen y el port lo exige.

- [ ] **Step 1: Tests que fallan**

En `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`, reemplazar el helper `buildB1Strategy` (al final del archivo) por esta versión que además simula la fórmula:

```js
function buildB1Strategy({
  invalidEntries = [],
  fields = [{ warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'available' }],
  formula = { add: ['InStock', 'Ordered'], subtract: ['Committed'] },
  invalidFormula = null,
} = {}) {
  return {
    normalizeFields: jest.fn((rawValue, { onInvalidMetric } = {}) => {
      invalidEntries.forEach((entry) => onInvalidMetric?.(entry));
      return fields;
    }),
    normalizeExclusions: jest.fn().mockReturnValue([]),
    normalizeAvailableFormula: jest.fn((rawValue, { onInvalid } = {}) => {
      if (invalidFormula) {
        onInvalid?.(invalidFormula);
        return null;
      }
      return formula;
    }),
    requiresRemoteFetch: jest.fn().mockReturnValue(false),
    buildProperties: jest.fn().mockReturnValue({ a01_stock: 5 }),
  };
}
```

Y agregar un `describe` nuevo antes de las funciones helper:

```js
describe('WarehouseStockEnrichmentAdapter — formula de disponible', () => {
  beforeEach(() => jest.clearAllMocks());

  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };
  const config = (rawAvailableFormula) => buildConfigRepository({
    strategyName: 'b1_ItemWarehouse', rawFields: [{}], rawExclusions: [], rawAvailableFormula,
  });

  it('pasa la formula cruda a la strategy y la normalizada a buildProperties', async () => {
    const strategy = buildB1Strategy({ formula: NOELITO });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({ add: ['instock'], subtract: ['committed'] }),
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() });

    expect(strategy.normalizeAvailableFormula).toHaveBeenCalledWith(
      { add: ['instock'], subtract: ['committed'] },
      expect.objectContaining({ onInvalid: expect.any(Function) })
    );
    expect(strategy.buildProperties).toHaveBeenCalledWith(expect.objectContaining({ availableFormula: NOELITO }));
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });

  it('con formula invalida registra UN SyncWarning por corrida y pasa null a buildProperties', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({ invalidFormula: { raw: { add: ['InStok'] }, reason: 'unknown_field:InStok' } });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({ add: ['InStok'] }),
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
    expect(syncWarningRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
      objectType: 'product',
      sapId: null,
      code: 'warehouse_available_formula_invalid',
      message: 'Warehouse available formula invalid: unknown_field:InStok',
      details: {
        raw: { add: ['InStok'] },
        reason: 'unknown_field:InStok',
        validFields: ['InStock', 'Committed', 'Ordered'],
      },
    }));
    expect(strategy.buildProperties).toHaveBeenCalledTimes(3);
    expect(strategy.buildProperties).toHaveBeenCalledWith(expect.objectContaining({ availableFormula: null }));
  });

  it('registra el warning aunque no haya ninguna bodega configurada', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({ fields: [], invalidFormula: { raw: {}, reason: 'empty_formula' } });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({}),
      syncWarningRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(1);
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({});
  });

  it('formula invalida y metric invalida a la vez dan dos warnings con codigos distintos', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({
      invalidEntries: [{ propertyName: 'a01_instock', warehouseCode: 'A01', metric: 'inStok' }],
      invalidFormula: { raw: 'x', reason: 'not_an_object' },
    });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config('x'),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({ mappedRecords: buildRecords(1), objectType: 'product', tenantModels: buildTenantModels() });

    const codes = syncWarningRepository.record.mock.calls.map(([call]) => call.code).sort();
    expect(codes).toEqual(['warehouse_available_formula_invalid', 'warehouse_metric_invalid']);
  });

  it('con la formula valida no registra nada', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy()) },
      configRepository: config(null),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({ mappedRecords: buildRecords(1), objectType: 'product', tenantModels: buildTenantModels() });

    expect(syncWarningRepository.record).not.toHaveBeenCalled();
  });

  it('sin syncWarningRepository no tira, y si record rechaza las propiedades se escriben igual', async () => {
    const strategy = buildB1Strategy({ invalidFormula: { raw: {}, reason: 'empty_formula' } });
    const sinRepo = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({}),
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await expect(sinRepo.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() }))
      .resolves.toBeUndefined();
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });

    const conRepoRoto = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({}),
      syncWarningRepository: { record: jest.fn().mockRejectedValue(new Error('mongo down')) },
      logger: silentLogger,
    });
    const records2 = buildRecords(1);

    await conRepoRoto.enrich({ mappedRecords: records2, objectType: 'product', tenantModels: buildTenantModels() });

    expect(records2[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });

  it('una strategy que devuelve undefined (S/4) con un documento basura no registra nada', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const s4 = {
      normalizeFields: jest.fn().mockReturnValue([]),
      normalizeExclusions: jest.fn().mockReturnValue([]),
      normalizeAvailableFormula: jest.fn().mockReturnValue(undefined),
      requiresRemoteFetch: jest.fn().mockReturnValue(true),
    };
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(s4) },
      configRepository: buildConfigRepository({
        strategyName: 's4_PlantStorageLocation', rawFields: null, rawExclusions: null, rawAvailableFormula: 'basura',
      }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({ mappedRecords: buildRecords(1), objectType: 'product', tenantModels: buildTenantModels() });

    expect(syncWarningRepository.record).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr y ver que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]infrastructure[\\/]warehouseStockEnrichmentAdapter'
```

Esperado: FAIL — `normalizeAvailableFormula` nunca se llama, `buildProperties` no recibe `availableFormula`, `record` no se llama con el código nuevo. Los 20 tests preexistentes siguen PASS.

- [ ] **Step 3: Implementar**

Import (líneas 2-6):

```js
import {
  B1_STOCK_METRICS,
  B1_WAREHOUSE_STOCK_FIELDS,
  WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING,
  WAREHOUSE_METRIC_INVALID_WARNING,
  WAREHOUSE_STOCK_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';
```

Dentro de `enrich`, reemplazar desde `const { strategyName, rawFields, rawExclusions } = ...` (línea 55) hasta el `await this.recordInvalidMetricWarnings({...})` (línea 74) por:

```js
      const {
        strategyName,
        rawFields,
        rawExclusions,
        rawAvailableFormula,
      } = await this.configRepository.getWarehouseStockConfig({ tenantModels });
      const strategy = this.strategyFactory.getStrategy(strategyName);

      // Se juntan acá y se reportan ANTES del return temprano de
      // fields.length === 0: si todas las entradas del tenant estan mal
      // escritas, fields queda vacio y ese return se llevaria puesto el aviso,
      // que es justo el caso donde mas se necesita.
      const invalidMetricFields = [];
      const fields = strategy.normalizeFields(rawFields, {
        onInvalidMetric: (entry) => invalidMetricFields.push(entry),
      });
      const exclusions = strategy.normalizeExclusions(rawExclusions);

      // undefined = default historico; null = invalida (la strategy ya aviso
      // por onInvalid). El guard de typeof tolera strategies mockeadas a mano
      // en tests; las dos reales lo implementan y el port lo exige.
      let invalidFormula = null;
      const availableFormula = typeof strategy.normalizeAvailableFormula === 'function'
        ? strategy.normalizeAvailableFormula(rawAvailableFormula, {
          onInvalid: (entry) => { invalidFormula = entry; },
        })
        : undefined;

      await this.recordInvalidMetricWarnings({
        invalidMetricFields,
        tenantModels,
        clientConfigId,
        syncLogId,
      });
      await this.recordInvalidFormulaWarning({
        invalidFormula,
        tenantModels,
        clientConfigId,
        syncLogId,
      });
```

La llamada a `strategy.buildProperties` (línea 110):

```js
        record.rawSapData[WAREHOUSE_STOCK_KEY] = strategy.buildProperties({
          record,
          index,
          fields,
          exclusions,
          availableFormula,
        });
```

Método nuevo, después de `recordInvalidMetricWarnings` y antes de `applyToAllRecords`:

```js
  // Un solo documento por corrida: la formula es del tenant, no de una entrada
  // ni de un producto. Mismo contrato que recordInvalidMetricWarnings: el log
  // siempre, el SyncWarning solo si hay repositorio, y un fallo al avisar no
  // se lleva puesto el enriquecimiento.
  async recordInvalidFormulaWarning({
    invalidFormula,
    tenantModels,
    clientConfigId,
    syncLogId,
  }) {
    if (!invalidFormula) {
      return;
    }

    this.logger.error?.('Warehouse available formula invalid', invalidFormula);

    if (typeof this.syncWarningRepository?.record !== 'function') {
      return;
    }

    try {
      await this.syncWarningRepository.record({
        tenantModels,
        clientConfigId,
        syncLogId,
        objectType: 'product',
        sapId: null,
        code: WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING,
        message: `Warehouse available formula invalid: ${invalidFormula.reason}`,
        details: {
          raw: invalidFormula.raw,
          reason: invalidFormula.reason,
          validFields: [...B1_WAREHOUSE_STOCK_FIELDS],
        },
      });
    } catch (error) {
      this.logger.error?.('Warehouse available formula warning not recorded', {
        error: error?.message,
      });
    }
  }
```

- [ ] **Step 4: Correr y ver que pasa**

Mismo comando del Step 2. Esperado: PASS (27 tests). También correr el test de composición, que no debe cambiar:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]composition[\\/]sapSyncComposition'
```

Esperado: PASS. No hay cambio de cableado: `syncWarningRepository` ya está inyectado en `sap-sync.composition.js:123`.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js
git commit -m "feat: el enricher de bodegas normaliza warehouseAvailableFormula y avisa si es invalida

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `warehouseStock.js` (camino de line items y fallback) lee y pasa la fórmula

**Files:**
- Modify: `src/infrastructure/hubspot/warehouseStock.js` (entero: 48 líneas)
- Test: `tests/unit/warehouseStock.test.js`

**Interfaces:**
- Consumes: `normalizeB1AvailableFormula`, `buildB1WarehouseStockProperties(items, fields, exclusions, { availableFormula })` (Tasks 1-2); `WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY`, `DEFAULT_B1_AVAILABLE_FORMULA` (Task 1); `tenantConfigurationService.getValue(tenantModels, key, defaultValue)` (existente).
- Produces: `resolveHubspotAvailableFormula(tenantModels) → Promise<{ add, subtract } | null>`; `buildHubspotWarehouseStockProperties(warehouseItems, warehouseFields, options)` (tercer parámetro nuevo, `{ availableFormula }`); `getHubspotWarehouseStockPropertiesForTenant(tenantModels, warehouseItems)` ahora aplica la fórmula del tenant.

**Nota para quien implementa:** los cuatro tests existentes de este archivo mockean `Configuration.findOneAndUpdate` con `mockResolvedValue(<doc de fieldsWareHouseHS>)`, **sin mirar la clave**. Como `getValue` no encuentra `findOne` en ese mock, va directo a `findOneAndUpdate` para **cualquier** clave; con la lectura nueva, la clave de la fórmula recibiría el array de `fieldsWareHouseHS`, que es `not_an_object`, y las `available` se omitirían → `distelsa_stock: 8` desaparece. El mock era irreal (una colección no devuelve el mismo doc para dos claves); se reemplaza por uno que responde por clave. **Los números afirmados no se tocan.**

- [ ] **Step 1: Tests que fallan**

Reescribir `tests/unit/warehouseStock.test.js` así (los seis tests viejos conservan sus aserciones; sólo cambia cómo se arma `tenantModels`):

```js
import { jest } from '@jest/globals';
import {
  buildHubspotWarehouseStockProperties,
  getAvailableStockForWarehouse,
  getHubspotWarehouseStockPropertiesForTenant,
  normalizeHubspotWarehouseFields,
  resolveHubspotAvailableFormula,
  resolveHubspotWarehouseFields,
} from '../../src/infrastructure/hubspot/warehouseStock.js';

// Responde por clave, como una coleccion real: la clave que no esta devuelve
// null y getValue cae al default que le pasaron.
function buildTenantModels(valuesByKey) {
  return {
    Configuration: {
      findOneAndUpdate: jest.fn(async ({ key }) => (
        Object.prototype.hasOwnProperty.call(valuesByKey, key)
          ? { key, value: valuesByKey[key], userUpdated: 'admin' }
          : null
      )),
    },
  };
}

describe('warehouseStock utils', () => {
  it('normalizes tenant warehouse config and preserves property key from config value', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'Entrepiso-T1', value: 'A01_stock' },
        { label: 'PVC', value: ' B10_stock ' },
        { label: 'Duplicado', value: 'B10_stock' },
        { label: 'Inválido', value: '' },
      ],
    });

    const fields = await resolveHubspotWarehouseFields(tenantModels);

    expect(fields).toEqual([
      { warehouseCode: 'A01', propertyName: 'A01_stock', metric: 'available' },
      { warehouseCode: 'B10', propertyName: 'B10_stock', metric: 'available' },
    ]);
  });

  it('uses valueSAP as warehouse code and keeps value as the HubSpot property name', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'DISTELSA', value: 'distelsa_stock', valueSAP: '01' },
        { label: 'PRODUCTOS DE EXHIBICION', value: 'exhibicion_stock', valueSAP: '05' },
      ],
    });

    const fields = await resolveHubspotWarehouseFields(tenantModels);

    expect(fields).toEqual([
      { warehouseCode: '01', propertyName: 'distelsa_stock', metric: 'available' },
      { warehouseCode: '05', propertyName: 'exhibicion_stock', metric: 'available' },
    ]);
  });

  it('builds stock properties for numeric SAP warehouse codes mapped via valueSAP', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'DISTELSA', value: 'distelsa_stock', valueSAP: '01' },
        { label: 'PRODUCTOS DE EXHIBICION', value: 'exhibicion_stock', valueSAP: '05' },
      ],
    });

    const properties = await getHubspotWarehouseStockPropertiesForTenant(tenantModels, [
      { WarehouseCode: '01', Ordered: 2, Committed: 1, InStock: 7 },
      { WarehouseCode: '05', Ordered: 0, Committed: 3, InStock: 5 },
    ]);

    expect(properties).toEqual({
      distelsa_stock: 8,
      exhibicion_stock: 2,
    });
  });

  it('builds HubSpot stock properties per configured warehouse', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'Entrepiso-T1', value: 'A01_stock' },
        { label: 'PVC', value: 'B10_stock' },
        { label: 'No existe', value: 'C99_stock' },
      ],
    });

    const properties = await getHubspotWarehouseStockPropertiesForTenant(tenantModels, [
      { WarehouseCode: 'A01', Ordered: 2, Committed: 1, InStock: 7 },
      { WarehouseCode: 'B10', Ordered: 0, Committed: 3, InStock: 5 },
    ]);

    expect(properties).toEqual({
      A01_stock: 8,
      B10_stock: 2,
      C99_stock: 0,
    });
  });

  it('falls back to empty warehouse field list when config value is invalid', () => {
    expect(normalizeHubspotWarehouseFields('B10_stock')).toEqual([]);
    expect(buildHubspotWarehouseStockProperties([], null)).toEqual({});
  });

  it('returns available stock for one warehouse code without summing all warehouses', () => {
    const available = getAvailableStockForWarehouse(
      [
        { WarehouseCode: 'B04', Ordered: 1, Committed: 2, InStock: 8 },
        { WarehouseCode: 'B10', Ordered: 9, Committed: 0, InStock: 9 },
      ],
      'B04'
    );

    expect(available).toBe(7);
  });
});

describe('warehouseStock — formula de disponible del tenant', () => {
  const fieldsWareHouseHS = [{ label: 'DISTELSA', value: 'distelsa_stock', valueSAP: '01' }];
  const items = [{ WarehouseCode: '01', Ordered: 2, Committed: 1, InStock: 7 }];

  it('resolveHubspotAvailableFormula lee la clave con getValue y su default, y normaliza', async () => {
    const tenantModels = buildTenantModels({ warehouseAvailableFormula: { add: ['instock'], subtract: ['committed'] } });

    await expect(resolveHubspotAvailableFormula(tenantModels))
      .resolves.toEqual({ add: ['InStock'], subtract: ['Committed'] });
    expect(tenantModels.Configuration.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'warehouseAvailableFormula' },
      { $setOnInsert: { key: 'warehouseAvailableFormula', value: { add: ['InStock', 'Ordered'], subtract: ['Committed'] }, userUpdated: 'admin' } },
      expect.any(Object)
    );
  });

  it('sin documento, el disponible sigue siendo InStock - Committed + Ordered', async () => {
    const properties = await getHubspotWarehouseStockPropertiesForTenant(buildTenantModels({ fieldsWareHouseHS }), items);

    expect(properties).toEqual({ distelsa_stock: 8 });
  });

  it('con la formula de Noelito, el disponible es InStock - Committed', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS,
      warehouseAvailableFormula: { add: ['InStock'], subtract: ['Committed'] },
    });

    await expect(getHubspotWarehouseStockPropertiesForTenant(tenantModels, items))
      .resolves.toEqual({ distelsa_stock: 6 });
  });

  it('con formula invalida omite las available, loguea y no tira', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        ...fieldsWareHouseHS,
        { label: 'DISTELSA en stock', value: 'distelsa_instock', valueSAP: '01', metric: 'inStock' },
      ],
      warehouseAvailableFormula: { add: ['InStok'] },
    });

    await expect(getHubspotWarehouseStockPropertiesForTenant(tenantModels, items))
      .resolves.toEqual({ distelsa_instock: 7 });
    expect(consoleError).toHaveBeenCalledWith(
      'Warehouse available formula invalid',
      { raw: { add: ['InStok'] }, reason: 'unknown_field:InStok' }
    );

    consoleError.mockRestore();
  });

  it('buildHubspotWarehouseStockProperties pasa la formula al builder de dominio', () => {
    const fields = normalizeHubspotWarehouseFields(fieldsWareHouseHS);

    expect(buildHubspotWarehouseStockProperties(items, fields, { availableFormula: { add: ['InStock'], subtract: ['Committed'] } }))
      .toEqual({ distelsa_stock: 6 });
    expect(buildHubspotWarehouseStockProperties(items, fields)).toEqual({ distelsa_stock: 8 });
  });
});
```

- [ ] **Step 2: Correr y ver que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]warehouseStock\.test'
```

Esperado: FAIL — `does not provide an export named 'resolveHubspotAvailableFormula'`.

- [ ] **Step 3: Implementar**

Reemplazar el contenido de `src/infrastructure/hubspot/warehouseStock.js` desde los imports hasta antes de `getAvailableStockForWarehouse`:

```js
// Thin infrastructure wrapper: the actual B1 warehouse-stock logic now lives
// in the domain strategy (src/domain/warehouses/strategies/b1-item-warehouse.strategy.js),
// since it is one of two interchangeable WarehouseStockStrategyPort
// implementations (see WarehouseStockEnrichmentAdapter). Kept here, with the
// same export names, so product.handler.js's B1 fallback path and existing
// tests do not need to change their imports.
import tenantConfigurationService from '../config/tenantConfiguration.service.js';
import {
  buildB1WarehouseStockProperties,
  getAvailableStockForB1Warehouse,
  getWarehouseAvailableStock,
  normalizeB1AvailableFormula,
  normalizeB1WarehouseFields,
} from '#domain/warehouses/strategies/b1-item-warehouse.strategy.js';
import {
  DEFAULT_B1_AVAILABLE_FORMULA,
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';

const DEFAULT_WAREHOUSE_FIELDS = [];
const WAREHOUSE_FIELDS_KEY = 'fieldsWareHouseHS';

export { getWarehouseAvailableStock };

export function normalizeHubspotWarehouseFields(value) {
  return normalizeB1WarehouseFields(value);
}

export async function resolveHubspotWarehouseFields(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    WAREHOUSE_FIELDS_KEY,
    DEFAULT_WAREHOUSE_FIELDS
  );

  return normalizeB1WarehouseFields(value);
}

// getValue crea el documento con el default la primera vez que falta (igual
// que con fieldsWareHouseHS), asi que un tenant "aparece" con la clave tras el
// primer webhook de precios aunque nadie la haya insertado. Este camino no
// tiene syncLogId ni repositorio de avisos: una formula invalida queda en el
// log y omite las `available`; el SyncWarning lo escribe el sync de productos
// (WarehouseStockEnrichmentAdapter) sobre la misma config.
export async function resolveHubspotAvailableFormula(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
    DEFAULT_B1_AVAILABLE_FORMULA
  );

  return normalizeB1AvailableFormula(value, {
    onInvalid: (entry) => console.error('Warehouse available formula invalid', entry),
  });
}

export function buildHubspotWarehouseStockProperties(
  warehouseItems,
  warehouseFields = DEFAULT_WAREHOUSE_FIELDS,
  options = {}
) {
  return buildB1WarehouseStockProperties(warehouseItems, warehouseFields, [], options);
}

export async function getHubspotWarehouseStockPropertiesForTenant(tenantModels, warehouseItems) {
  const [warehouseFields, availableFormula] = await Promise.all([
    resolveHubspotWarehouseFields(tenantModels),
    resolveHubspotAvailableFormula(tenantModels),
  ]);

  return buildB1WarehouseStockProperties(warehouseItems, warehouseFields, [], { availableFormula });
}
```

`getAvailableStockForWarehouse` queda igual.

Ojo con `getValue` y el default congelado: `DEFAULT_B1_AVAILABLE_FORMULA` va como `value` de `$setOnInsert` cuando el doc no existe. Mongoose serializa el objeto congelado sin problema (no lo muta en `findOneAndUpdate`); si en la prueba manual el insert fallara por eso, pasar `{ add: [...DEFAULT_B1_AVAILABLE_FORMULA.add], subtract: [...DEFAULT_B1_AVAILABLE_FORMULA.subtract] }` y ajustar la aserción del test.

- [ ] **Step 4: Correr y ver que pasa**

Mismo comando del Step 2. Esperado: PASS (11 tests). Confirmar que las aserciones `distelsa_stock: 8`, `exhibicion_stock: 2`, `A01_stock: 8`, `B10_stock: 2`, `C99_stock: 0` y `toBe(7)` no cambiaron (`git diff tests/unit/warehouseStock.test.js` no debe tocar esas líneas).

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/warehouseStock.js tests/unit/warehouseStock.test.js
git commit -m "feat: el camino de line items lee warehouseAvailableFormula al resolver stock por bodega

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `product.handler.js` lleva la fórmula en `preprocessContext`

**Files:**
- Modify: `src/infrastructure/hubspot/handlers/product.handler.js:10-14` (import), `:46-53` (`buildPreprocessContext`), `:70-79` (`preprocess`)
- Test: `tests/unit/product.handler.test.js`

**Interfaces:**
- Consumes: `resolveHubspotAvailableFormula(tenantModels)`, `buildHubspotWarehouseStockProperties(items, fields, { availableFormula })` (Task 5).
- Produces: `buildPreprocessContext({ tenantModels }) → { warehouseFields, priceFields, availableFormula }`; `preprocess` pasa `{ availableFormula: preprocessContext.availableFormula }` al builder cuando usa el contexto.

- [ ] **Step 1: Tests que fallan**

En `tests/unit/product.handler.test.js`:

1. Al mock del módulo (líneas 5-13) agregar el export nuevo — sin esto el import ESM del handler falla:

```js
const mockGetHubspotWarehouseStockPropertiesForTenant = jest.fn();
const mockBuildHubspotWarehouseStockProperties = jest.fn();
const mockResolveHubspotWarehouseFields = jest.fn();
const mockResolveHubspotAvailableFormula = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/warehouseStock.js', () => ({
  getHubspotWarehouseStockPropertiesForTenant: mockGetHubspotWarehouseStockPropertiesForTenant,
  buildHubspotWarehouseStockProperties: mockBuildHubspotWarehouseStockProperties,
  resolveHubspotWarehouseFields: mockResolveHubspotWarehouseFields,
  resolveHubspotAvailableFormula: mockResolveHubspotAvailableFormula,
}));
```

2. En el test `buildPreprocessContext resolves warehouse and price fields for the whole run` (línea 118), después de `mockResolveHubspotWarehouseFields.mockResolvedValue(warehouseFields);` agregar:

```js
    const availableFormula = { add: ['InStock'], subtract: ['Committed'] };
    mockResolveHubspotAvailableFormula.mockResolvedValue(availableFormula);
```

y cambiar el `toEqual` a `{ warehouseFields, priceFields: ['hs_price_nio'], availableFormula }`, más
`expect(mockResolveHubspotAvailableFormula).toHaveBeenCalledWith(tenantModels);`.

3. En el test `preprocess uses the preprocessContext without touching the database` (línea 141): en el `preprocessContext` agregar `availableFormula: { add: ['InStock'], subtract: ['Committed'] }`, y cambiar la aserción de `mockBuildHubspotWarehouseStockProperties` a:

```js
    expect(mockBuildHubspotWarehouseStockProperties).toHaveBeenCalledWith(
      item.rawSapData.ItemWarehouseInfoCollection,
      warehouseFields,
      { availableFormula: { add: ['InStock'], subtract: ['Committed'] } }
    );
```

4. Agregar, dentro del mismo `describe('product.handler preprocess')`:

```js
  it('un preprocessContext viejo sin availableFormula sigue funcionando (cae al default del builder)', async () => {
    mockBuildHubspotWarehouseStockProperties.mockReturnValue({ A01_stock: 7 });
    const item = { properties: {}, rawSapData: { ItemWarehouseInfoCollection: [] } };

    await preprocess({
      item,
      tenantModels: { Configuration: { findOne: jest.fn(), findOneAndUpdate: jest.fn() } },
      preprocessContext: { warehouseFields: [], priceFields: ['hs_price_nio'] },
    });

    expect(mockBuildHubspotWarehouseStockProperties).toHaveBeenCalledWith(
      [],
      [],
      { availableFormula: undefined }
    );
  });
```

- [ ] **Step 2: Correr y ver que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]product\.handler'
```

Esperado: FAIL — el `toEqual` del contexto no trae `availableFormula`; el builder se llamó con 2 argumentos.

- [ ] **Step 3: Implementar**

Import (líneas 10-14):

```js
import {
  buildHubspotWarehouseStockProperties,
  getHubspotWarehouseStockPropertiesForTenant,
  resolveHubspotAvailableFormula,
  resolveHubspotWarehouseFields,
} from '../warehouseStock.js';
```

`buildPreprocessContext` (líneas 46-53):

```js
export async function buildPreprocessContext({ tenantModels }) {
  const [warehouseFields, priceFields, availableFormula] = await Promise.all([
    resolveHubspotWarehouseFields(tenantModels),
    resolveHubspotPriceFields(tenantModels),
    resolveHubspotAvailableFormula(tenantModels),
  ]);

  return { warehouseFields, priceFields, availableFormula };
}
```

En `preprocess`, la rama del contexto (líneas 72-75):

```js
    : preprocessContext?.warehouseFields
      ? buildHubspotWarehouseStockProperties(
        rawSapData.ItemWarehouseInfoCollection,
        preprocessContext.warehouseFields,
        { availableFormula: preprocessContext.availableFormula }
      )
```

La rama `getHubspotWarehouseStockPropertiesForTenant` no cambia: ya resuelve la fórmula por dentro (Task 5).

- [ ] **Step 4: Correr y ver que pasa**

Mismo comando del Step 2. Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/handlers/product.handler.js tests/unit/product.handler.test.js
git commit -m "feat: product.handler lleva availableFormula en el preprocessContext

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `ensureTenantConfigurations` siembra el default

**Files:**
- Modify: `src/infrastructure/tenants/tenantProvisioning.js:35` (import), final de `ensureTenantConfigurations` (después del bloque de `REQUIRE_ADDRESS_CONFIG_KEY`, hoy líneas 201-213)
- Test: `tests/unit/infrastructure/tenantProvisioningBpKeys.test.js`

**Interfaces:**
- Consumes: `WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY`, `DEFAULT_B1_AVAILABLE_FORMULA` (Task 1).
- Produces: un `updateOne({ key: 'warehouseAvailableFormula' }, { $setOnInsert: {...} }, { upsert: true })` más por tenant nuevo.

- [ ] **Step 1: Test que falla**

En `tests/unit/infrastructure/tenantProvisioningBpKeys.test.js`, agregar el import y un test:

```js
import { WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY }
  from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';
```

```js
  it('siembra warehouseAvailableFormula con el calculo historico, con arrays mutables', async () => {
    const updateOne = jest.fn().mockResolvedValue({});

    await ensureTenantConfigurations({ Configuration: { updateOne } });

    const call = updateOne.mock.calls.find(
      ([filter]) => filter.key === WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY
    );

    expect(call).toBeDefined();
    expect(call[1].$setOnInsert.value).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
    expect(Object.isFrozen(call[1].$setOnInsert.value)).toBe(false);
    expect(Object.isFrozen(call[1].$setOnInsert.value.add)).toBe(false);
    expect(call[1].$setOnInsert.userUpdated).toBe('admin');
    expect(call[2]).toEqual({ upsert: true });
  });
```

- [ ] **Step 2: Correr y ver que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='tests[\\/]unit[\\/]infrastructure[\\/]tenantProvisioningBpKeys'
```

Esperado: FAIL — `expect(call).toBeDefined()` recibe `undefined`.

- [ ] **Step 3: Implementar**

Import, después de la línea 35 (`REQUIRE_ADDRESS_CONFIG_KEY`):

```js
import {
  DEFAULT_B1_AVAILABLE_FORMULA,
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';
```

Al final de `ensureTenantConfigurations`, después del `updateOne` de `REQUIRE_ADDRESS_CONFIG_KEY`:

```js
  // Sembrada con el calculo historico de disponible por bodega en B1
  // (InStock - Committed + Ordered). Se cambia editando el documento; nunca hay
  // que crear la clave a mano. Se copian los arrays porque la constante esta
  // congelada y un Object.freeze dentro de un $setOnInsert es un bug dificil
  // de ver si Mongoose intenta mutarlo.
  await Configuration.updateOne(
    { key: WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY },
    {
      $setOnInsert: {
        key: WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
        userUpdated: 'admin',
        value: {
          add: [...DEFAULT_B1_AVAILABLE_FORMULA.add],
          subtract: [...DEFAULT_B1_AVAILABLE_FORMULA.subtract],
        },
      },
    },
    { upsert: true }
  );
```

- [ ] **Step 4: Correr y ver que pasa**

Mismo comando del Step 2. Esperado: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/tenants/tenantProvisioning.js tests/unit/infrastructure/tenantProvisioningBpKeys.test.js
git commit -m "feat: todo tenant nace con warehouseAvailableFormula = InStock - Committed + Ordered

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Documentación y suite completa

**Files:**
- Modify: `configuration_examples.md:83` (entrada `fieldsWareHouseHS`) y nueva entrada después de la línea 92

- [ ] **Step 1: Entrada nueva en `configuration_examples.md`**

Insertar después del bloque JSON de `fieldsWareHouseHS` (termina en la línea 92, `}`) y antes de `Detalle: s4PriceList`, respetando el formato del catálogo (línea `Detalle: <clave>`, prosa en un párrafo, ejemplo):

```
Detalle: warehouseAvailableFormula
Qué significa la métrica `available` de `fieldsWareHouseHS` en SAP Business One: la suma de los campos de `add` menos la suma de los campos de `subtract`, leídos de la bodega tal como vienen en `ItemWarehouseInfoCollection`. Los únicos campos válidos son `InStock`, `Committed` y `Ordered` (se comparan sin distinguir mayúsculas y se guardan en esa forma); cualquier otro nombre invalida la config. **Ausente = `InStock - Committed + Ordered`**, que es el cálculo histórico y con el que nace todo tenant nuevo (`ensureTenantConfigurations` la siembra). Sólo define `available`: las métricas crudas `inStock`, `committed` y `ordered` no la leen. Es **por tenant**, no por bodega. Una fórmula inválida (un campo desconocido, el mismo campo en `add` y en `subtract`, las dos listas vacías, o un `value` que no es objeto) hace que en esa corrida las entradas `available` **no se escriban** —HubSpot conserva el último valor— y que quede un documento en `SyncWarnings` con `code: 'warehouse_available_formula_invalid'` y el motivo en `details.reason`; nunca cae al default, porque escribiría un número plausible pero distinto del que el tenant pidió. Una bodega en `excludedWarehouses` sigue saliendo en `0` con cualquier fórmula. Sólo aplica a SAP Business One; en S/4HANA el eje equivalente es `stockType`. El camino de precios de line items la lee con `getValue`, así que si el documento no existe lo crea con el default en el primer webhook: un tenant puede "tener" la clave sin que nadie la haya insertado.
{ key: 'warehouseAvailableFormula', value: { add: ['InStock', 'Ordered'], subtract: ['Committed'] } }
{ key: 'warehouseAvailableFormula', value: { add: ['InStock'], subtract: ['Committed'] } }
```

- [ ] **Step 2: Ajuste a la entrada de `fieldsWareHouseHS`**

En la línea 83, reemplazar el fragmento

```
`'available'` (el default, y lo que aplica a toda config que no declare `metric`) es `InStock - Committed + Ordered`, o sea que cuenta lo pedido a proveedor como disponible;
```

por

```
`'available'` (el default, y lo que aplica a toda config que no declare `metric`) es la fórmula de `warehouseAvailableFormula` (por defecto `InStock - Committed + Ordered`, o sea que cuenta lo pedido a proveedor como disponible);
```

- [ ] **Step 3: Suite completa del repo**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]'
```

Esperado: todas verdes salvo las 5 suites del baseline listadas en Global Constraints. Si aparece una roja fuera de esas cinco, es de este cambio: revisar antes de seguir. Anotar en el mensaje del commit el conteo (`N suites, 5 rojas preexistentes`).

- [ ] **Step 4: Commit**

```bash
git add configuration_examples.md
git commit -m "docs: warehouseAvailableFormula en el catalogo de configuraciones

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Después del plan (no es código)

1. Push de la rama y PR a mano (no hay `gh`; ver `memory/pr-workflow-no-gh-cli.md`). Título sugerido: `feat: fórmula de disponible por bodega configurable por tenant (B1)`.
2. Con el deploy hecho, insertar por Compass en `Configurations` de cada tenant (una vez, y **después** del deploy, porque antes la clave no la lee nadie):
   - `sap_integration_distelsa`, `sap_integration_amc`, `sap_integration_printer`:
     `{ "key": "warehouseAvailableFormula", "value": { "add": ["InStock", "Ordered"], "subtract": ["Committed"] }, "userUpdated": "admin" }`
   - `sap_integration_noelito`:
     `{ "key": "warehouseAvailableFormula", "value": { "add": ["InStock"], "subtract": ["Committed"] }, "userUpdated": "admin" }`
3. Prueba manual en Noelito: `POST /sap-sync/run` con sólo la config de productos activa (ver `memory/sap-sync-manual-testing-workflow.md`), y comparar una bodega con `Ordered > 0` antes/después: la columna debe bajar exactamente en `Ordered`. Después, revisar que `SyncWarnings` no tenga ningún `warehouse_available_formula_invalid` para ese `syncLogId`.
