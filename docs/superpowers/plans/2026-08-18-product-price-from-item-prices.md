# Precio de producto desde `ItemPrices` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la config `productSyncStrategy` pueda declarar que el precio de un producto sale de la fila de `ItemPrices` cuyo `PriceList` coincide con la config `priceList` del tenant, en vez de quedar en `0.0`.

**Architecture:** Un servicio de dominio puro resuelve el precio; `OneToOneProductStrategy` lo llama una vez por corrida y adjunta el número bajo `rawSapData._resolvedProductPrice`; `product.handler.preprocess()` lo escribe en los campos de `fieldsPricesHS` en vez de cerarlos. Mismo contrato que ya usan `_warehouseStock`, `BATCH_EXPIRY_KEY` y `_resolvedDiscount`: alguien resuelve y adjunta bajo `rawSapData`, y `preprocess` traduce a propiedades de HubSpot.

**Tech Stack:** Node.js ESM, Jest (con `NODE_OPTIONS=--experimental-vm-modules`), Mongoose, arquitectura hexagonal con alias `#domain/*`, `#shared/*`, `#infrastructure/*`.

**Spec:** [2026-08-18-product-price-from-item-prices-design.md](../specs/2026-08-18-product-price-from-item-prices-design.md)

## Global Constraints

- **Ningún tenant sin la llave `requirePrice.source` cambia de comportamiento.** Hay un tenant productivo con `{ requirePrice: {value:false, field:''}, requireCost: {flag:true, field:'hs_cost_of_goods_sold'} }`. Ese documento no se migra. `source` ausente ⇒ ruta de ejecución idéntica a la de hoy.
- **Solo se implementa `onMissingPrice: "SET_ZERO"`.** `SKIP_PRODUCT` y `THROW_ERROR` se aceptan en la config para que su forma quede estable, pero caen a `SET_ZERO` con un `warn`.
- **El precio se selecciona solo por `PriceList`.** Nada de match por moneda (SAP devuelve `QTZ`, no el ISO `GTQ`).
- **Un `Price` de `0` cuenta como "sin precio".** En B1, una lista sin tarifa cargada trae `0.0`, no `null`.
- **Nada puede tumbar la corrida de productos.** Una config rota o faltante ⇒ log + precios en `0`; nombre y stock igual llegan a HubSpot. Mismo criterio que los enrichers (`WarehouseStockEnrichmentAdapter.js:89-93`).
- **No se toca:** `oneToMany_Product`, el `$select`, el `.env`, `requireCost`, ni la propiedad estándar `price` de HubSpot.
- **Rama de trabajo:** `feat/product-price-from-item-prices`, creada en el checkout principal (`C:\Users\ale_1\OneDrive\Escritorio\Proyectos\SAP`). **No usar worktrees**: un worktree nace del último commit y dejaría fuera los archivos que el usuario tiene modificados sin commitear.
- **Comando de tests** (acota a las suites tocadas y excluye los worktrees viejos que ensucian la corrida):
  ```bash
  NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="productPriceSource|productSyncStrategy|product\.handler"
  ```
  Pasar rutas como argumentos posicionales **no** acota: Jest las trata como regex contra la ruta absoluta y hacen match también en `.claude/worktrees/`.
- **Baseline de la suite antes de empezar:** `6 failed, 160 passed, 166 total` (12 tests rojos). Suites ya rojas: `tests/integration/internalTenant.test.js`, `tests/unit/application/sendMappedItemsToHubspot.test.js`, `tests/unit/application/syncLineItemPrices.test.js`, `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js`, `tests/unit/serviceLayerService.test.js`. **Volver a medirlo en el paso 0 antes de tocar nada** y no atribuirle a este cambio nada que ya estuviera rojo.

---

## Task 0: Rama y baseline

**Files:** ninguno (solo git y medición).

- [ ] **Step 1: Crear la rama en el checkout principal**

```bash
git checkout -b feat/product-price-from-item-prices
```

- [ ] **Step 2: Medir el baseline de la suite ANTES de tocar código**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees
```

Anotar el resultado. Se espera `6 failed, 160 passed, 166 total`. Si el número difiere del que dice **Global Constraints**, anotar el nuevo baseline y usar **ese** como referencia — el working tree tiene cambios sin commitear del usuario que pueden haber avanzado.

---

## Task 1: Servicio de dominio que resuelve el precio

Resuelve el precio desde `ItemPrices` sin tocar Mongo ni HubSpot. Es la única pieza con lógica de negocio real, así que va primero y se prueba sola.

**Files:**
- Modify: `src/domain/products/product-sync-strategy.constants.js` (agregar al final, no tocar lo existente)
- Create: `src/domain/products/product-price-source.service.js`
- Test: `tests/unit/domain/productPriceSource.test.js`

**Interfaces:**
- Consumes: `selectPriceListRow(itemPrices, priceList)` de `#domain/prices/price-currency.service.js` (devuelve la fila con `Number(row.PriceList) === priceList`, o `null`); `normalizeNumber(value, fallback)` y `toNonEmptyString(value)` de `#shared/utils/string.utils.js`.
- Produces:
  - `PRODUCT_PRICE_SOURCES` = `{ MAPPED: 'mapped', ITEM_PRICES: 'itemPrices' }`
  - `DEFAULT_PRODUCT_PRICE_SOURCE` = `'mapped'`
  - `DEFAULT_PRODUCT_PRICE_FIELD` = `'Price'`
  - `RESOLVED_PRODUCT_PRICE_KEY` = `'_resolvedProductPrice'`
  - `normalizeProductPriceSource(requirePrice, { logger })` → `{ from: string, priceField: string, onMissingPrice: string }`
  - `resolveProductPriceFromItemPrices({ itemPrices, priceList, priceField })` → `{ row: object, price: number } | null`

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/domain/productPriceSource.test.js`:

```js
import {
  normalizeProductPriceSource,
  resolveProductPriceFromItemPrices,
} from '../../../src/domain/products/product-price-source.service.js';
import {
  DEFAULT_PRODUCT_PRICE_SOURCE,
  PRODUCT_PRICE_SOURCES,
  PRODUCT_SYNC_ON_MISSING_PRICE,
} from '../../../src/domain/products/product-sync-strategy.constants.js';

// Payload real del tenant sap_integration_printer: la lista 1 tiene tarifa y
// de la 3 en adelante vienen en 0.0 con Currency null.
const ITEM_PRICES = [
  { PriceList: 1, Price: 36.607143, Currency: 'QTZ', AdditionalPrice1: 12.5, AdditionalCurrency1: 'USD' },
  { PriceList: 2, Price: 36.607143, Currency: 'QTZ', AdditionalPrice1: 0.0, AdditionalCurrency1: null },
  { PriceList: 3, Price: 0.0, Currency: null, AdditionalPrice1: 0.0, AdditionalCurrency1: null },
];

describe('normalizeProductPriceSource', () => {
  it('cae a mapped cuando requirePrice no trae source (tenant productivo)', () => {
    const result = normalizeProductPriceSource({ value: false, field: '' });

    expect(result.from).toBe(DEFAULT_PRODUCT_PRICE_SOURCE);
    expect(result.from).toBe(PRODUCT_PRICE_SOURCES.MAPPED);
  });

  it('cae a mapped cuando requirePrice es undefined', () => {
    expect(normalizeProductPriceSource(undefined).from).toBe(PRODUCT_PRICE_SOURCES.MAPPED);
  });

  it('lee from: itemPrices con sus defaults', () => {
    const result = normalizeProductPriceSource({
      value: false,
      field: '',
      source: { from: 'itemPrices' },
    });

    expect(result).toEqual({
      from: PRODUCT_PRICE_SOURCES.ITEM_PRICES,
      priceField: 'Price',
      onMissingPrice: PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO,
    });
  });

  it('respeta un priceField alterno', () => {
    const result = normalizeProductPriceSource({
      source: { from: 'itemPrices', priceField: 'AdditionalPrice1' },
    });

    expect(result.priceField).toBe('AdditionalPrice1');
  });

  it('cae a mapped y avisa cuando from no es soportado', () => {
    const logger = { warn: jest.fn() };

    const result = normalizeProductPriceSource({ source: { from: 'inventado' } }, { logger });

    expect(result.from).toBe(PRODUCT_PRICE_SOURCES.MAPPED);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('cae a SET_ZERO y avisa cuando onMissingPrice no esta implementado', () => {
    const logger = { warn: jest.fn() };

    const result = normalizeProductPriceSource(
      { source: { from: 'itemPrices', onMissingPrice: 'SKIP_PRODUCT' } },
      { logger }
    );

    expect(result.onMissingPrice).toBe(PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('resolveProductPriceFromItemPrices', () => {
  it('toma el Price de la fila cuyo PriceList coincide', () => {
    const result = resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: 1 });

    expect(result.price).toBe(36.607143);
    expect(result.row.PriceList).toBe(1);
  });

  it('acepta PriceList como string, porque SAP y Mongo mezclan tipos', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: '2' }).price)
      .toBe(36.607143);
  });

  it('devuelve null cuando la lista existe pero su Price es 0 (sin tarifa cargada)', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: 3 })).toBeNull();
  });

  it('devuelve null cuando no hay fila para la lista pedida', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: 9 })).toBeNull();
  });

  it('toma la columna alterna cuando se pide priceField', () => {
    const result = resolveProductPriceFromItemPrices({
      itemPrices: ITEM_PRICES,
      priceList: 1,
      priceField: 'AdditionalPrice1',
    });

    expect(result.price).toBe(12.5);
  });

  it('no revienta con ItemPrices ausente, vacio o no-array', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: undefined, priceList: 1 })).toBeNull();
    expect(resolveProductPriceFromItemPrices({ itemPrices: [], priceList: 1 })).toBeNull();
    expect(resolveProductPriceFromItemPrices({ itemPrices: 'nope', priceList: 1 })).toBeNull();
  });

  it('devuelve null cuando no hay lista de precios', () => {
    expect(resolveProductPriceFromItemPrices({ itemPrices: ITEM_PRICES, priceList: null })).toBeNull();
  });
});
```

> El archivo usa `jest.fn()`. Este proyecto es ESM: agregar `import { jest } from '@jest/globals';` como primera línea, igual que [productSyncStrategy.test.js:1](../../../tests/unit/domain/productSyncStrategy.test.js).

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="productPriceSource"
```

Esperado: FAIL — `Cannot find module '.../product-price-source.service.js'`.

- [ ] **Step 3: Agregar las constantes**

Al final de `src/domain/products/product-sync-strategy.constants.js`, **sin tocar nada de lo que ya está**:

```js
// De donde sale el precio de un producto en la strategy oneToOne.
// 'mapped' = del campo de cabecera que puso el FieldMapping (comportamiento
// historico: requirePrice.value decide conservar-o-cerar). 'itemPrices' = de la
// fila de ItemPrices cuyo PriceList coincide con la config priceList del tenant.
// El default es 'mapped' a proposito: un tenant sin la llave `source` no cambia
// de comportamiento.
export const PRODUCT_PRICE_SOURCES = Object.freeze({
  MAPPED: 'mapped',
  ITEM_PRICES: 'itemPrices',
});

export const DEFAULT_PRODUCT_PRICE_SOURCE = PRODUCT_PRICE_SOURCES.MAPPED;

export const DEFAULT_PRODUCT_PRICE_FIELD = 'Price';

// Llave bajo la que la strategy adjunta el precio ya resuelto (un numero), para
// que product.handler.js lo escriba en los campos de fieldsPricesHS en vez de
// ponerlos en 0. Mismo contrato que WAREHOUSE_STOCK_KEY y BATCH_EXPIRY_KEY:
// alguien resuelve y adjunta bajo rawSapData, preprocess traduce a propiedades.
export const RESOLVED_PRODUCT_PRICE_KEY = '_resolvedProductPrice';
```

- [ ] **Step 4: Escribir el servicio**

Crear `src/domain/products/product-price-source.service.js`:

```js
import { selectPriceListRow } from '#domain/prices/price-currency.service.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';
import {
  DEFAULT_PRODUCT_PRICE_FIELD,
  DEFAULT_PRODUCT_PRICE_SOURCE,
  DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE,
  PRODUCT_PRICE_SOURCES,
  PRODUCT_SYNC_ON_MISSING_PRICE,
} from './product-sync-strategy.constants.js';

// Normaliza requirePrice.source. Ausente, vacio o con un valor desconocido =>
// 'mapped', que es la ruta historica. Esto es lo que garantiza que el tenant
// productivo (sin la llave `source`) no cambie de comportamiento.
export function normalizeProductPriceSource(requirePrice, { logger = null } = {}) {
  const source = requirePrice?.source;
  const rawFrom = toNonEmptyString(source?.from);
  const from = Object.values(PRODUCT_PRICE_SOURCES).includes(rawFrom)
    ? rawFrom
    : DEFAULT_PRODUCT_PRICE_SOURCE;

  if (rawFrom && from !== rawFrom) {
    logger?.warn?.({
      msg: 'requirePrice.source.from no soportado; se usa el default',
      from: rawFrom,
      fallback: DEFAULT_PRODUCT_PRICE_SOURCE,
      supported: Object.values(PRODUCT_PRICE_SOURCES),
    });
  }

  // Solo SET_ZERO esta implementado. SKIP_PRODUCT y THROW_ERROR se aceptan en la
  // config para que su forma quede estable, pero caen a SET_ZERO con aviso:
  // saltarse un producto exigiria filtrar records antes del envio, y abortar la
  // corrida exigiria decidir el efecto sobre el SyncLog.
  const rawOnMissing = toNonEmptyString(source?.onMissingPrice);
  const onMissingPrice = rawOnMissing === PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO
    ? PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO
    : DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE;

  if (rawOnMissing && rawOnMissing !== onMissingPrice) {
    logger?.warn?.({
      msg: 'requirePrice.source.onMissingPrice todavia no esta implementado; se usa SET_ZERO',
      onMissingPrice: rawOnMissing,
      fallback: DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE,
    });
  }

  return {
    from,
    priceField: toNonEmptyString(source?.priceField) || DEFAULT_PRODUCT_PRICE_FIELD,
    onMissingPrice,
  };
}

// Devuelve { row, price } o null. null significa "no hay precio para esta
// lista", que el llamador traduce a SET_ZERO.
//
// Un Price de 0 cuenta como SIN precio, no como precio cero: en B1 una lista de
// precios sin tarifa cargada para el articulo trae 0.0 con Currency null (ver
// las listas 3..10 del payload del tenant). Devolver 0 como si fuera un precio
// valido escribiria un cero "confirmado" en HubSpot y taparia el caso a revisar.
export function resolveProductPriceFromItemPrices({
  itemPrices,
  priceList,
  priceField = DEFAULT_PRODUCT_PRICE_FIELD,
}) {
  const row = selectPriceListRow(itemPrices, priceList);

  if (!row) {
    return null;
  }

  const price = normalizeNumber(row[priceField], null);

  if (price === null || price <= 0) {
    return null;
  }

  return { row, price };
}

export default { normalizeProductPriceSource, resolveProductPriceFromItemPrices };
```

- [ ] **Step 5: Correr el test y verificar que pasa**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="productPriceSource"
```

Esperado: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain/products/product-price-source.service.js src/domain/products/product-sync-strategy.constants.js tests/unit/domain/productPriceSource.test.js
git commit -m "feat: add product price source resolver for ItemPrices by price list"
```

---

## Task 2: `preprocess` escribe el precio resuelto en vez de cerarlo

Independiente de la strategy: el handler solo lee una llave de `rawSapData`. Se puede revisar y aceptar por separado.

**Files:**
- Modify: `src/infrastructure/hubspot/handlers/product.handler.js` (import nuevo + rama antes del zeroing de la línea 106)
- Test: `tests/unit/product.handler.test.js` (agregar un `describe`)

**Interfaces:**
- Consumes: `RESOLVED_PRODUCT_PRICE_KEY` de Task 1.
- Produces: nada nuevo; cambia el comportamiento de `preprocess({ item, tenantModels, preprocessContext })`.

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `tests/unit/product.handler.test.js`, dentro del `describe('product.handler preprocess', ...)` de nivel superior (justo antes de su llave de cierre):

```js
  describe('_resolvedProductPrice puesto por OneToOneProductStrategy', () => {
    function buildTenantModels(priceFields) {
      return {
        Configuration: {
          findOneAndUpdate: jest.fn().mockResolvedValue({
            key: 'fieldsPricesHS',
            value: priceFields,
            userUpdated: 'admin',
          }),
        },
      };
    }

    it('escribe el precio resuelto en el campo de precio en vez de 0', async () => {
      const item = {
        properties: {},
        rawSapData: { _warehouseStock: {}, _resolvedProductPrice: 36.607143 },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties.hs_price_gtq).toBe(36.607143);
    });

    it('escribe el mismo precio en todos los campos de fieldsPricesHS', async () => {
      const item = {
        properties: {},
        rawSapData: { _warehouseStock: {}, _resolvedProductPrice: 36.607143 },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq', 'hs_price_usd']) });

      expect(item.properties.hs_price_gtq).toBe(36.607143);
      expect(item.properties.hs_price_usd).toBe(36.607143);
    });

    it('gana sobre selectedPrice: la guarda de selectedPrice no puede cortar antes', async () => {
      const item = {
        properties: {},
        rawSapData: {
          _warehouseStock: {},
          _resolvedProductPrice: 36.607143,
          selectedPrice: { PriceList: 1, Price: 36.607143 },
        },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties.hs_price_gtq).toBe(36.607143);
    });

    it('sigue cerando cuando la llave no esta (regresion del comportamiento actual)', async () => {
      const item = { properties: {}, rawSapData: { _warehouseStock: {} } };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties.hs_price_gtq).toBe(0);
    });

    it('cera cuando la llave viene en null o NaN, que es la ruta SET_ZERO', async () => {
      const withNull = { properties: {}, rawSapData: { _warehouseStock: {}, _resolvedProductPrice: null } };
      const withNaN = { properties: {}, rawSapData: { _warehouseStock: {}, _resolvedProductPrice: Number.NaN } };

      await preprocess({ item: withNull, tenantModels: buildTenantModels(['hs_price_gtq']) });
      await preprocess({ item: withNaN, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(withNull.properties.hs_price_gtq).toBe(0);
      expect(withNaN.properties.hs_price_gtq).toBe(0);
    });

    it('no interfiere con el stock por bodega ni con los lotes', async () => {
      const item = {
        properties: {},
        rawSapData: {
          _resolvedProductPrice: 36.607143,
          _warehouseStock: { gt00_onhand: 12 },
          [BATCH_EXPIRY_KEY]: { lotes_vigentes: 3 },
        },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties).toEqual({
        gt00_onhand: 12,
        lotes_vigentes: 3,
        hs_price_gtq: 36.607143,
      });
    });
  });
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="product\.handler"
```

Esperado: FAIL — `hs_price_gtq` sale `0` donde se espera `36.607143`.

- [ ] **Step 3: Implementar**

En `src/infrastructure/hubspot/handlers/product.handler.js`, extender el import de la línea 3:

```js
import {
  KEEP_MAPPED_PRICE_FLAG,
  RESOLVED_PRODUCT_PRICE_KEY,
} from '#domain/products/product-sync-strategy.constants.js';
```

Y reemplazar el bloque final de `preprocess` (hoy líneas 102-108) por:

```js
  // Va ANTES de la guarda de selectedPrice a proposito: la strategy setea las
  // dos llaves, y si la guarda corriera primero haria `return` sin escribir
  // nunca el precio. selectedPrice es la fila cruda de ItemPrices; esta llave es
  // el numero ya elegido segun priceField, que es lo unico que preprocess puede
  // escribir sin volver a decidir.
  const resolvedProductPrice = rawSapData?.[RESOLVED_PRODUCT_PRICE_KEY];

  if (Number.isFinite(resolvedProductPrice)) {
    priceFields.forEach((field) => {
      item.properties[field] = resolvedProductPrice;
    });
    return;
  }

  if (item?.rawSapData?.selectedPrice || item?.rawSapData?.[KEEP_MAPPED_PRICE_FLAG]) {
    return;
  }

  priceFields.forEach((field) => {
    item.properties[field] = 0.0;
  });
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="product\.handler"
```

Esperado: PASS. Los tests que ya existían en el archivo deben seguir verdes — especialmente `sets all configured HubSpot price fields to zero` y `preserves SAP-mapped price fields when the keepMappedPrice flag is set`, que son la regresión del comportamiento actual.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/handlers/product.handler.js tests/unit/product.handler.test.js
git commit -m "feat: write the resolved product price into the HubSpot price fields"
```

---

## Task 3: `OneToOneProductStrategy` resuelve la lista y anota los records

Incluye el cableado de composición: la strategy no sirve sin el repositorio inyectado, así que ambos van en el mismo commit y bajo la misma revisión.

**Files:**
- Modify: `src/domain/products/strategies/one-to-one-product.strategy.js`
- Modify: `src/composition/sap-sync.composition.js:68` (el `new OneToOneProductStrategy({...})`)
- Test: `tests/unit/domain/productSyncStrategy.test.js` (agregar tests al `describe('OneToOneProductStrategy', ...)`)

**Interfaces:**
- Consumes: `normalizeProductPriceSource`, `resolveProductPriceFromItemPrices`, `PRODUCT_PRICE_SOURCES`, `RESOLVED_PRODUCT_PRICE_KEY` de Task 1; `resolveTenantPriceList({ tenantModels, currency })` de `TenantLineItemPriceConfigRepository` ([:80](../../../src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js)) — **lanza** cuando falta la config `priceList` o su formato es inválido.
- Produces: `new OneToOneProductStrategy({ hubspotSyncTarget, priceListConfigRepository, logger })`. `priceListConfigRepository` es opcional (default `null`).

- [ ] **Step 1: Escribir los tests que fallan**

Agregar dentro del `describe('OneToOneProductStrategy', ...)` existente en `tests/unit/domain/productSyncStrategy.test.js`. Ese `describe` ya tiene un helper `buildStrategy()`; **no lo modifiques** — agregá uno propio para no romper los tests que ya lo usan:

```js
  function buildStrategyWithPriceList({ priceList = 1, throws = false } = {}) {
    const hubspotSyncTarget = {
      send: jest.fn().mockResolvedValue({ sent: 1, failed: 0, created: 1 }),
    };
    const priceListConfigRepository = {
      resolveTenantPriceList: jest.fn(throws
        ? () => { throw new Error('Configuration priceList must be a currency map'); }
        : async () => priceList),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const strategy = new OneToOneProductStrategy({
      hubspotSyncTarget,
      priceListConfigRepository,
      logger,
    });

    return { hubspotSyncTarget, priceListConfigRepository, strategy, logger };
  }

  function buildProductRecord(itemPrices) {
    return {
      properties: { hs_sku: 'SKU-1' },
      rawSapData: { ItemCode: 'SKU-1', ItemPrices: itemPrices },
    };
  }

  const ITEM_PRICES = [
    { PriceList: 1, Price: 36.607143, Currency: 'QTZ' },
    { PriceList: 2, Price: 50, Currency: 'QTZ' },
    { PriceList: 3, Price: 0.0, Currency: null },
  ];

  const ITEM_PRICES_CONFIG = {
    strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
    requirePrice: { value: false, field: '', source: { from: 'itemPrices' } },
  };

  it('anota el precio de la lista configurada en cada record', async () => {
    const { hubspotSyncTarget, strategy } = buildStrategyWithPriceList({ priceList: 1 });

    await strategy.execute({
      mappedRecords: [buildProductRecord(ITEM_PRICES)],
      config: {},
      objectType: 'product',
      tenantContext: { tenantModels: {} },
      credentials: {},
      strategyConfig: ITEM_PRICES_CONFIG,
    });

    const sentRecords = hubspotSyncTarget.send.mock.calls[0][0].mappedRecords;
    expect(sentRecords[0].rawSapData[RESOLVED_PRODUCT_PRICE_KEY]).toBe(36.607143);
    expect(sentRecords[0].rawSapData.selectedPrice.PriceList).toBe(1);
  });

  it('no anota nada cuando la lista configurada no tiene tarifa', async () => {
    const { hubspotSyncTarget, strategy } = buildStrategyWithPriceList({ priceList: 3 });

    await strategy.execute({
      mappedRecords: [buildProductRecord(ITEM_PRICES)],
      config: {},
      objectType: 'product',
      tenantContext: { tenantModels: {} },
      credentials: {},
      strategyConfig: ITEM_PRICES_CONFIG,
    });

    const sentRecords = hubspotSyncTarget.send.mock.calls[0][0].mappedRecords;
    expect(sentRecords[0].rawSapData).not.toHaveProperty(RESOLVED_PRODUCT_PRICE_KEY);
  });

  it('lee la config priceList una sola vez para N productos', async () => {
    const { priceListConfigRepository, strategy } = buildStrategyWithPriceList({ priceList: 1 });

    await strategy.execute({
      mappedRecords: [
        buildProductRecord(ITEM_PRICES),
        buildProductRecord(ITEM_PRICES),
        buildProductRecord(ITEM_PRICES),
      ],
      config: {},
      objectType: 'product',
      tenantContext: { tenantModels: {} },
      credentials: {},
      strategyConfig: ITEM_PRICES_CONFIG,
    });

    expect(priceListConfigRepository.resolveTenantPriceList).toHaveBeenCalledTimes(1);
  });

  it('sigue enviando los productos cuando resolveTenantPriceList lanza', async () => {
    const { hubspotSyncTarget, strategy, logger } = buildStrategyWithPriceList({ throws: true });

    const result = await strategy.execute({
      mappedRecords: [buildProductRecord(ITEM_PRICES)],
      config: {},
      objectType: 'product',
      tenantContext: { tenantModels: {} },
      credentials: {},
      strategyConfig: ITEM_PRICES_CONFIG,
    });

    expect(result.failed).toBe(0);
    expect(hubspotSyncTarget.send).toHaveBeenCalled();
    const sentRecords = hubspotSyncTarget.send.mock.calls[0][0].mappedRecords;
    expect(sentRecords[0].rawSapData).not.toHaveProperty(RESOLVED_PRODUCT_PRICE_KEY);
    expect(logger.error).toHaveBeenCalled();
  });

  it('avisa y sigue cuando pide itemPrices sin repositorio inyectado', async () => {
    const hubspotSyncTarget = { send: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }) };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const strategy = new OneToOneProductStrategy({ hubspotSyncTarget, logger });

    await strategy.execute({
      mappedRecords: [buildProductRecord(ITEM_PRICES)],
      config: {},
      objectType: 'product',
      tenantContext: { tenantModels: {} },
      credentials: {},
      strategyConfig: ITEM_PRICES_CONFIG,
    });

    expect(logger.warn).toHaveBeenCalled();
    const sentRecords = hubspotSyncTarget.send.mock.calls[0][0].mappedRecords;
    expect(sentRecords[0].rawSapData).not.toHaveProperty(RESOLVED_PRODUCT_PRICE_KEY);
  });

  // REGRESION DEL TENANT PRODUCTIVO. Este test es el que no se puede omitir.
  it('deja intacto al tenant productivo que no declara source', async () => {
    const { hubspotSyncTarget, priceListConfigRepository, strategy } = buildStrategyWithPriceList();

    await strategy.execute({
      mappedRecords: [
        {
          properties: { hs_sku: 'SKU-1', hs_price_nio: 0, hs_cost_of_goods_sold: 150 },
          rawSapData: { ItemCode: 'SKU-1', ItemPrices: ITEM_PRICES },
        },
      ],
      config: {},
      objectType: 'product',
      tenantContext: { tenantModels: {} },
      credentials: {},
      strategyConfig: {
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
        requirePrice: { value: false, field: '' },
        requireCost: { flag: true, field: 'hs_cost_of_goods_sold' },
      },
    });

    const sentRecords = hubspotSyncTarget.send.mock.calls[0][0].mappedRecords;
    // Ni se lee la config priceList, ni se anota nada, ni se marca keepMappedPrice.
    expect(priceListConfigRepository.resolveTenantPriceList).not.toHaveBeenCalled();
    expect(sentRecords[0].rawSapData).not.toHaveProperty(RESOLVED_PRODUCT_PRICE_KEY);
    expect(sentRecords[0].rawSapData).not.toHaveProperty('selectedPrice');
    expect(sentRecords[0].rawSapData).not.toHaveProperty(KEEP_MAPPED_PRICE_FLAG);
    // Y el campo de costo sigue llegando, que es lo que ese tenant necesita.
    expect(sentRecords[0].properties.hs_cost_of_goods_sold).toBe(150);
  });
```

Extender el import del tope del archivo de tests para traer `RESOLVED_PRODUCT_PRICE_KEY`:

```js
import {
  KEEP_MAPPED_PRICE_FLAG,
  PRODUCT_SYNC_STRATEGIES,
  RESOLVED_PRODUCT_PRICE_KEY,
} from '../../../src/domain/products/product-sync-strategy.constants.js';
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="productSyncStrategy"
```

Esperado: FAIL — los records salen sin `_resolvedProductPrice`.

- [ ] **Step 3: Implementar la strategy**

En `src/domain/products/strategies/one-to-one-product.strategy.js`, extender el import del tope:

```js
import {
  KEEP_MAPPED_PRICE_FLAG,
  PRODUCT_PRICE_SOURCES,
  PRODUCT_SYNC_STRATEGIES,
  RESOLVED_PRODUCT_PRICE_KEY,
} from '../product-sync-strategy.constants.js';
import {
  normalizeProductPriceSource,
  resolveProductPriceFromItemPrices,
} from '../product-price-source.service.js';
```

Agregar esta función junto a las otras helpers del archivo (después de `applyPriceAndCostConfig`):

```js
// Adjunta el precio resuelto bajo rawSapData. Setea las DOS llaves a proposito:
// selectedPrice porque es la guarda que ya existe en product.handler.js y otros
// consumidores podrian leerla, y RESOLVED_PRODUCT_PRICE_KEY porque selectedPrice
// es la fila cruda y el handler necesita el numero ya elegido segun priceField.
// Si no hay precio para la lista devuelve el record intacto: el handler lo cera,
// que es el comportamiento SET_ZERO.
function applyResolvedItemPrice(record, { priceList, priceField }) {
  const resolved = resolveProductPriceFromItemPrices({
    itemPrices: record?.rawSapData?.ItemPrices,
    priceList,
    priceField,
  });

  if (!resolved) {
    return record;
  }

  return {
    ...record,
    rawSapData: {
      ...(record?.rawSapData ?? {}),
      selectedPrice: resolved.row,
      [RESOLVED_PRODUCT_PRICE_KEY]: resolved.price,
    },
  };
}
```

Cambiar el constructor:

```js
  constructor({ hubspotSyncTarget, priceListConfigRepository = null, logger = console }) {
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.priceListConfigRepository = priceListConfigRepository;
    this.logger = logger;
  }
```

Agregar este método a la clase:

```js
  // Lee la config priceList UNA vez por corrida, no por producto.
  // resolveTenantPriceList lanza cuando la config falta o su formato es
  // invalido; aca eso no puede tumbar la corrida. Si se dejara propagar, el
  // try/catch de execute() lo convertiria en failed: totalProducts y el tenant
  // perderia tambien nombre y stock, no solo el precio. Devolver null = caer a
  // SET_ZERO, mismo criterio que los enrichers.
  async resolvePriceList({ tenantContext, tenantId }) {
    if (typeof this.priceListConfigRepository?.resolveTenantPriceList !== 'function') {
      this.logger.warn?.({
        msg: 'requirePrice.source.from es itemPrices pero no hay priceListConfigRepository inyectado',
        tenantId,
      });
      return null;
    }

    try {
      return await this.priceListConfigRepository.resolveTenantPriceList({
        tenantModels: tenantContext?.tenantModels,
      });
    } catch (error) {
      this.logger.error?.({
        msg: 'No se pudo resolver la lista de precios del tenant; los precios quedan en 0',
        tenantId,
        error: error.message,
      });
      return null;
    }
  }
```

Y reemplazar el bloque de `execute()` que va desde `const requirePriceValue = ...` hasta el `this.logger.info?.({...})` (hoy líneas 53-73) por:

```js
    const requirePriceValue = strategyConfig.requirePrice?.value;
    const requireCostFlag = strategyConfig.requireCost?.flag;
    const costField = strategyConfig.requireCost?.field;
    const priceSource = normalizeProductPriceSource(strategyConfig.requirePrice, {
      logger: this.logger,
    });
    // null cubre los dos casos en los que no hay que resolver nada: la fuente es
    // 'mapped', o la config del tenant no se pudo leer.
    const resolvedPriceList = priceSource.from === PRODUCT_PRICE_SOURCES.ITEM_PRICES
      ? await this.resolvePriceList({ tenantContext, tenantId })
      : null;
    let productsWithoutPrice = 0;

    const recordsToSend = records.map((record) => {
      const base = applyPriceAndCostConfig(record, {
        keepMappedPrice: requirePriceValue,
        dropCostField: !requireCostFlag,
        costField,
      });

      if (resolvedPriceList === null) {
        return base;
      }

      const withPrice = applyResolvedItemPrice(base, {
        priceList: resolvedPriceList,
        priceField: priceSource.priceField,
      });

      if (withPrice === base) {
        productsWithoutPrice += 1;
      }

      return withPrice;
    });

    this.logger.info?.({
      msg: 'Starting product sync strategy',
      tenantId,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
      totalProducts,
      requirePrice: requirePriceValue,
      requireCost: requireCostFlag,
      costField,
      priceSource: priceSource.from,
      priceList: resolvedPriceList,
      productsWithoutPrice,
    });
```

- [ ] **Step 4: Cablear la composición**

En `src/composition/sap-sync.composition.js`, el `ProductSyncStrategyFactory` de la línea 67. Cambiar:

```js
    oneToOneProductStrategy: new OneToOneProductStrategy({
      hubspotSyncTarget,
      logger,
    }),
```

por:

```js
    oneToOneProductStrategy: new OneToOneProductStrategy({
      hubspotSyncTarget,
      priceListConfigRepository: new TenantLineItemPriceConfigRepository(),
      logger,
    }),
```

`TenantLineItemPriceConfigRepository` **ya está importado** en ese archivo (línea 42), así que no hay import nuevo que agregar.

- [ ] **Step 5: Verificar el cableado con grep, no confiando en los tests**

```bash
grep -n "priceListConfigRepository" src/composition/sap-sync.composition.js
```

Esperado: **una línea** dentro del `new OneToOneProductStrategy({...})`. Este paso no es ceremonia: en este repo ya pasó tres veces que un parámetro de constructor quedara sin cablear con toda la suite en verde, porque los tests inyectan el doble a mano y nunca tocan la composición.

- [ ] **Step 6: Correr los tests y verificar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="productPriceSource|productSyncStrategy|product\.handler"
```

Esperado: PASS. Los cuatro tests de `requirePrice`/`requireCost` que ya existían deben seguir verdes.

- [ ] **Step 7: Commit**

```bash
git add src/domain/products/strategies/one-to-one-product.strategy.js src/composition/sap-sync.composition.js tests/unit/domain/productSyncStrategy.test.js
git commit -m "feat: resolve the oneToOne product price from ItemPrices by price list"
```

---

## Task 4: Regresión completa y cierre

**Files:** ninguno (verificación e integración).

- [ ] **Step 1: Correr la suite completa y comparar contra el baseline**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees
```

Esperado: las **mismas 6 suites rojas** que en Task 0, ni una más, y **+25 tests verdes** respecto al baseline (13 de Task 1 + 6 de Task 2 + 6 de Task 3), o sea `1475 passed` si el baseline fue `1450 passed`. Si aparece una suite roja nueva, **es de este cambio**: arreglarla antes de seguir. Si el conteo de verdes no calza, contar los tests efectivamente escritos y explicar la diferencia — no ajustar el número de aquí para que cuadre.

- [ ] **Step 2: Revisar el diff completo**

```bash
git diff main...HEAD --stat
```

Esperado: **8 archivos**, ninguno más:

```
src/domain/products/product-sync-strategy.constants.js          (modificado)
src/domain/products/product-price-source.service.js             (nuevo)
src/domain/products/strategies/one-to-one-product.strategy.js   (modificado)
src/infrastructure/hubspot/handlers/product.handler.js          (modificado)
src/composition/sap-sync.composition.js                         (modificado)
tests/unit/domain/productPriceSource.test.js                    (nuevo)
tests/unit/domain/productSyncStrategy.test.js                   (modificado)
tests/unit/product.handler.test.js                              (modificado)
```

Nada de `.env`, nada de `docs/`, nada de `one-to-many-product.strategy.js`.

- [ ] **Step 3: Prueba manual contra el tenant**

Requiere que el usuario haya insertado en la DB del tenant `sap_integration_printer` los configs y mapeos entregados en esta sesión (`tema1-fieldmappings.json`, `tema2-fieldsPricesHS.json`, `tema3-warehouses.json`, `tema4-productSyncStrategy.json`).

1. Dejar activa **solo** la config de productos del tenant y lanzar `POST /sap-sync/run`.
2. Verificar en HubSpot que `hs_price_gtq` trae el precio de la lista 1 y no `0`.
3. Repetir con `hubspotBatchSize` en `1` y en `> 1`. **Son dos rutas distintas de `preprocess`** ([SendMappedItemsToHubspot.js:280](../../../src/application/use-cases/SendMappedItemsToHubspot.js) secuencial y [:531](../../../src/application/use-cases/SendMappedItemsToHubspot.js) por lotes) y este plan toca la función que ambas llaman.
4. Buscar en `logs/app.log` la línea `Starting product sync strategy` y confirmar `priceSource: 'itemPrices'`, `priceList: 1` y el conteo de `productsWithoutPrice`.
5. Confirmar que un artículo sin tarifa en la lista 1 queda en `0` y **no** rompe el lote de 100.

> `hs_price_gtq` tiene que existir en el portal de HubSpot antes de la primera corrida. Con `hubspotBatchSize > 1`, una propiedad inexistente hace fallar el lote de 100 completo, no el producto suelto.

- [ ] **Step 4: Push y PR**

```bash
git push -u origin feat/product-price-from-item-prices
```

No hay `gh` CLI ni extensión de GitHub en este entorno: dejar la rama pusheada y entregarle al usuario el título y el cuerpo del PR pegables, para que lo cree a mano.

---

## Notas de decisión que el ejecutor no debe revertir

- **La rama nueva de `preprocess` va ANTES de la guarda de `selectedPrice`.** La strategy setea las dos llaves; si la guarda corriera primero, haría `return` sin escribir nunca el precio. Hay un test que lo fija (`gana sobre selectedPrice`).
- **`requirePrice.value` se queda en `false` en la config del tenant y eso es correcto.** Las dos llaves responden preguntas distintas: `value` = "conservá lo que el FieldMapping puso"; `source` = "resolvé el precio desde acá".
- **Un `Price` de `0` devuelve `null`, no `0`.** Distinguir "sin tarifa cargada" de "precio cero confirmado" es lo que hace que el conteo `productsWithoutPrice` sirva para algo.
- **`requirePrice.field` no se lee en ninguna parte** ni antes ni después de este cambio. Es decorativo; se conserva por consistencia con el tenant productivo.
- Si al ejecutar aparece un problema de capas por inyectarle un repositorio a una clase de dominio, la **ruta de respaldo** es mover la resolución a un enricher (`ProductPriceEnrichmentAdapter`) llamado desde `SyncSapConfigToHubspot` junto a los otros cuatro. Cambia quién setea las llaves; **no** cambia las llaves ni la rama de `preprocess` (Task 1 y Task 2 quedan iguales). Ver la sección de alternativas del spec.
