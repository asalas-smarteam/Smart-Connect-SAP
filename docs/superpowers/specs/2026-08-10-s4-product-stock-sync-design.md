# Sincronización de productos y stock por bodega para SAP S/4HANA

Fecha: 2026-08-10

## Problema

Multiquímica (kickoff 2026-07-02) corre sobre SAP S/4HANA, no sobre Business One. El pipeline
de sincronización de productos ya soporta el transporte OData de S/4 (`S4GatewayTransport`,
`s4ODataService`, `SapSyncDataAdapter`), pero dos cosas lo dejan inutilizable para productos:

1. **`MappingSyncRepository.ensureDefaultMappings` siembra mappings de B1 en cada corrida**,
   sin mirar el flavor del tenant (`ItemCode`, `ItemName`, `QuantityOnStock`, `Price`). Como el
   índice único de `FieldMapping` es `{hubspotCredentialId, objectType, sourceContext,
   sourceField}` y no incluye `targetField`, estos se insertan *además* de cualquier mapping S/4
   que el tenant tenga, y el `$select` que arma `s4ODataQueryBuilder` termina incluyendo campos
   que no existen en `A_Product` → el Gateway responde 400.
2. **El stock no viene embebido en el producto.** En B1, `ItemWarehouseInfoCollection` viaja
   dentro de cada `Item` del Service Layer. En S/4, `A_Product` no tiene ningún campo de stock:
   vive en un servicio OData aparte (`API_MATERIAL_STOCK_SRV`), indexado por Centro (`Plant`) +
   Almacén (`StorageLocation`) — dos niveles que B1 no tiene, y donde el mismo código de almacén
   se repite entre centros distintos.

Verificado en vivo contra el S/4 de QA de Multiquímica: `A_Product` tiene 8080 productos y no
trae el nombre (vive en `to_Description`, con dos filas ES/EN por producto). El stock vive en
`A_MatlStkInAcctMod`: 10125 filas con cantidad > 0, repartidas en 7 centros (MQGT, HFDO, CPDO,
MQDO, DPDO, TMDO, GPDO), con `InventoryStockType` observados `01`/`02`/`04`/`07` y
`StorageLocation` (0008, 0401, 0500…) que se repite entre centros.

## Objetivo

Que un ClientConfig de producto en modo `S4_ODATA` cargue a HubSpot: nombre del producto,
precio en 0 (ya funciona sin cambios), y stock por bodega — usando el mismo modelo de
configuración por tenant que ya usan los clientes B1 (`fieldsWareHouseHS`,
`excludedWarehouses`, `fieldsPricesHS`, `productSyncStrategy`), sin que ningún cliente B1
existente cambie de comportamiento.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Mappings de producto | Ningún default en código para S/4; sólo documentos `FieldMapping` insertados en la DB del tenant | El ingeniero de la integración controla esto config-por-config; un default en código puede sembrar campos que no existen en el Gateway de un tenant distinto |
| Resolución de bodega | Strategy (`warehouseStockStrategy` en `Configuration`), no una implementación fija | Cada cliente organiza sus bodegas distinto — Multiquímica es Centro+Almacén, otro cliente S/4 podría ser sólo Centro, o algo propio |
| Compatibilidad con B1 | La estrategia B1 (`b1_ItemWarehouse`) es el default cuando no hay configuración — ningún tenant existente necesita tocar nada | `DEFAULT_WAREHOUSE_STOCK_STRATEGY` apunta a la lógica ya en producción, sólo movida de lugar |
| Dónde vive el stock resuelto | `rawSapData._warehouseStock`, adjunto por un enricher antes del envío a HubSpot | Mismo patrón que `S4ContactEnrichmentAdapter` (`_s4Contacts`): enriquecimiento inyectado, falla en silencio, no bloquea el sync |
| Alcance del fetch de stock | Una llamada por Centro configurado, trayendo todo el stock de ese centro e indexándolo en memoria | 8080 productos vs 10125 filas de stock hacen inviable filtrar por material (URL con miles de OR, o miles de requests) |
| Configuración final | Se documentan todos los `Configuration`/`FieldMapping`/`SapCredentials` a insertar; no se escribe nada en Mongo desde este trabajo | El ingeniero borra y crea manualmente, para mantener control total sobre qué queda activo |

## Arquitectura

```
SyncSapConfigToHubspot.execute()
  └─ mapRecords()                         (FieldMapping de la DB, sin defaults de código para S4)
  └─ s4ContactEnricher.enrich()            (ya existe, sin cambios)
  └─ warehouseStockEnricher.enrich()       (NUEVO)
       ├─ WarehouseStockConfigRepository.getConfig()   -> { strategyName, fields, exclusions }
       ├─ WarehouseStockStrategyFactory.getStrategy(strategyName)
       │    ├─ B1ItemWarehouseStrategy      (requiresRemoteFetch: false, lee rawSapData directo)
       │    └─ S4PlantStorageLocationStrategy (requiresRemoteFetch: true)
       ├─ si requiresRemoteFetch(): S4StockResolver.fetchStockRows(targets) -> strategy.buildIndex(rows)
       └─ por record: rawSapData._warehouseStock = strategy.buildProperties({record, index, fields})
  └─ sendMappedRecords() -> product.handler.preprocess()
       └─ si rawSapData tiene la clave _warehouseStock -> la usa tal cual
       └─ si no -> ruta B1 actual sin cambios (compatibilidad para tenants sin la config nueva
          y para llamadas directas a preprocess() en tests)
```

La estrategia B1 no se reimplementa: la lógica pura que hoy vive en
`src/infrastructure/hubspot/warehouseStock.js` (cálculo de disponible, normalización de
`fieldsWareHouseHS`, fallback `*_stock`) se mueve a
`src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`, arreglando dos bugs
preexistentes de paso (optional chaining faltante y comparación de `WarehouseCode` sin
normalizar en un solo lado). `warehouseStock.js` pasa a ser un wrapper delgado que reexporta
esas funciones para no romper ningún import existente (`product.handler.js`,
`tests/unit/warehouseStock.test.js`).

## Componentes

### 1. `src/domain/warehouses/warehouse-stock-strategy.constants.js` — nuevo

```js
export const WAREHOUSE_STOCK_CONFIG_KEY = 'warehouseStockStrategy';
export const WAREHOUSE_STOCK_STRATEGIES = Object.freeze({
  B1_ITEM_WAREHOUSE: 'b1_ItemWarehouse',
  S4_PLANT_STORAGE_LOCATION: 's4_PlantStorageLocation',
});
export const DEFAULT_WAREHOUSE_STOCK_STRATEGY = WAREHOUSE_STOCK_STRATEGIES.B1_ITEM_WAREHOUSE;
export const WAREHOUSE_STOCK_KEY = '_warehouseStock';
export const STOCK_TYPE_ALL = '*';
export const QUANTITY_DECIMALS = 3;
```

### 2. `src/application/ports/sap/warehouse-stock-strategy.port.js` — nuevo

Puerto uniforme (`createPort`, mismo mecanismo que `ProductSyncStrategyConfigPort`):
`normalizeFields`, `normalizeExclusions`, `requiresRemoteFetch`, `buildQueryTargets`,
`buildIndex`, `buildProperties`.

### 3. `src/domain/warehouses/warehouse-stock-strategy.factory.js` — nuevo

Copia estructural de `ProductSyncStrategyFactory`: `getStrategy(name)` con `Object.hasOwn`,
`logger.error?.()` listando `validStrategies`, y `throw` si el nombre no existe.

### 4. `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js` — nuevo

`requiresRemoteFetch() -> false`. Envuelve las funciones puras movidas de `warehouseStock.js`.
`buildProperties({record, fields})` lee `record.rawSapData.ItemWarehouseInfoCollection`
directamente (ignora `index`), respeta `excludedWarehouses` (nuevo: hasta ahora esta key era
letra muerta en B1 — con esta refactorización queda funcional también ahí).

### 5. `src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js` — nuevo

`requiresRemoteFetch() -> true`. `valueSAP: "MQGT/0008"` → `{plant, storageLocation}`;
`"DPDO/*"`/`"DPDO"` → centro completo; `stockType` opcional (ausente → `['01']`, string, array,
o `'*'`). `buildIndex` suma duplicados por lote/proveedor, descarta
`InventorySpecialStockType` no vacío y bodegas excluidas, redondea a 3 decimales.
`buildQueryTargets` agrupa por centro.

### 6. `src/infrastructure/sap/products/S4StockResolver.js` — nuevo

Espejo de `S4ContactResolver`: una llamada `fetchAll` por centro configurado
(`$select=Material,Plant,StorageLocation,InventorySpecialStockType,InventoryStockType,
MatlWrhsStkQtyInMatlBaseUnit`, `$filter` con `Plant eq 'X'` y, si el centro no es comodín, un
grupo OR de `StorageLocation`), nunca una llamada por producto.

### 7. `src/infrastructure/config/WarehouseStockConfigRepository.js` — nuevo

Espejo de `MappingFallbackConfigRepository`: nunca lanza. Lee `warehouseStockStrategy`,
`fieldsWareHouseHS`, `excludedWarehouses` con `Configuration.findOne({key}).lean()` directo,
sin upsert (para no crear documentos vacíos por accidente en tenants que no los tengan).

### 8. `src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js` — nuevo

Igual forma que `S4ContactEnrichmentAdapter`: `enrich({mappedRecords, objectType,
tenantModels})`. No-op fuera de `objectType === 'product'`. Resuelve estrategia + config; si la
estrategia no requiere fetch remoto, deja el índice vacío (la estrategia B1 lee `rawSapData`
directo); si lo requiere, construye `S4StockResolver` sobre `createSapTransport({sapFlavor: S4,
config})`. Adjunta `rawSapData[WAREHOUSE_STOCK_KEY]` **siempre** (incluso `{}`), para que la
rama nueva de `product.handler.js` nunca dependa de un valor "truthy" — un objeto `{}` es una
señal válida de "no hay bodegas configuradas", distinta de "la clave no existe".

### 9. `src/application/ports/sap/sap-record-enricher.port.js` — nuevo

Cubre tanto el enricher nuevo como el `S4ContactEnrichmentAdapter` existente (que hoy se
inyecta sin `assertPort`).

## Lo que no cambia

- `S4GatewayTransport`, `s4ODataQueryBuilder`, `s4ODataService`, `SapSyncDataAdapter`: el
  transporte S/4 ya funciona, no se toca.
- Los precios en 0: `product.handler.js` ya los pone a partir de `fieldsPricesHS` y
  `productSyncStrategy.requirePrice`, sin relación con este trabajo. Sólo hacen falta los
  documentos de `Configuration`.
- El comportamiento de un tenant B1 sin la `Configuration` `warehouseStockStrategy`: usa el
  default `b1_ItemWarehouse`, que reproduce exactamente `warehouseStock.js` de hoy.
- `OneToOneProductStrategy`, `SendMappedItemsToHubspot`, `masterClientConfigs.seed.js`.

## Manejo de errores

- `WarehouseStockConfigRepository` nunca lanza; ante un fallo de lectura, `getConfig()` devuelve
  la estrategia default sin fields ni exclusiones.
- `WarehouseStockEnrichmentAdapter.enrich` envuelve todo en `try/catch`: si el resolver o la
  estrategia fallan, se loguea con `logger.error` y el sync de productos continúa sin stock
  (nunca sin nombre/precio).
- `WarehouseStockStrategyFactory.getStrategy` **sí lanza** para un nombre de estrategia
  desconocido — un error de configuración explícito, no algo para tragar en silencio, porque
  el adapter ya está dentro de su propio `try/catch` y degradar aquí ocultaría un typo en la
  config del tenant.

## Testing

**Nuevos** (`tests/unit/domain/`, `tests/unit/infrastructure/`):
- `s4PlantStorageLocationStrategy.test.js`: parseo de `valueSAP`, las 4 formas de `stockType`,
  dedupe por `propertyName`, suma de duplicados, descarte por `InventorySpecialStockType` y por
  exclusión, **regresión de que `0008` en `MQGT` y en `MQDO` no se mezclan**, agrupación de
  `buildQueryTargets` por centro.
- `b1ItemWarehouseStrategy.test.js`: paridad exacta con `warehouseStock.js` hoy (`InStock -
  Committed + Ordered`, fallback `*_stock`, bodega ausente → 0), más los dos bugs corregidos.
- `warehouseStockStrategyFactory.test.js`: estrategia desconocida lanza con `validStrategies`.
- `s4StockResolver.test.js`: `fetchAll` llamado una vez por centro (no-N+1), `$filter`/`$select`
  exactos.
- `warehouseStockEnrichmentAdapter.test.js`: no-op en `company`; B1 no dispara fetch remoto;
  setea `{}` sin fields; error del resolver tragado con `logger.error`.

**Extendidos**:
- `tests/unit/product.handler.test.js`: con `_warehouseStock` poblado, la ruta B1 no lo pisa
  con ceros; con `{}`, no escribe nada; sin la clave, comportamiento idéntico al actual.
- `tests/unit/infrastructure/mappingSyncRepository.test.js`: tenant `sapFlavor: 'S4'` →
  `ensureDefaultMappings('product')` no crea ninguna fila; tenant B1 → las 4 de siempre.
- `tests/unit/warehouseStock.test.js`: sigue pasando sin cambios de expectativas (regresión).

## Verificación

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest
```

Línea base conocida: 6 suites / 12 tests fallando de antes (`sendMappedItemsToHubspot`,
`lineItemPriceWebhook.service`, `syncLineItemPrices`, `serviceLayerService`, `serviceLayerFlow`,
`integration/internalTenant`). Cualquier otra suite en rojo es regresión.

**End to end** (una vez que el ingeniero inserte manualmente las configuraciones documentadas en
[2026-08-10-s4-product-stock-sync-configs.md](2026-08-10-s4-product-stock-sync-configs.md)):
dejar sólo el ClientConfig `Obtener Productos S4` activo, `POST /sap-sync/run` con
`{"tenantID": "<tenantKey>"}`, y confirmar en HubSpot que un producto conocido trae `hs_sku`,
`name` en español, `price = 0` y las propiedades `*_stock` configuradas con números — más un
segundo run idéntico que reporte `skipped ≈ total` (idempotencia).

## Fuera de alcance

- Stock "en pedido/en camino" desde órdenes de compra.
- Lote y fecha de vencimiento (`API_BATCH_SRV`).
- Listas de precios reales (`API_SLSPRICINGCONDITIONRECORD_SRV`, filtro `ZPR0` sin resolver).
- Escrituras hacia S/4 (los webhooks siguen siendo 100% B1).
- UI de administración para editar `warehouseStockStrategy`.
