# Fórmula de disponible por bodega configurable por tenant (SAP Business One)

Fecha: 2026-09-01
Aplica sólo a: SAP Business One (Service Layer). S/4HANA no se toca.
Antecedente directo: `docs/superpowers/specs/2026-08-20-b1-warehouse-stock-metric-design.md` (métrica
por entrada de `fieldsWareHouseHS`). Este spec cambia **qué significa** la métrica `available`; no
cambia cómo se elige la métrica.

## El problema

La métrica `available` —el default de toda entrada de `fieldsWareHouseHS` que no declara `metric`—
tiene **una sola** fórmula, cableada en
`src/domain/warehouses/strategies/b1-item-warehouse.strategy.js:47`:

```js
export function getWarehouseAvailableStock(warehouse) {
  const inStock = Number(warehouse?.InStock ?? 0);
  const committed = Number(warehouse?.Committed ?? 0);
  const ordered = Number(warehouse?.Ordered ?? 0);

  return inStock - committed + ordered;
}
```

Esa fórmula cuenta lo pedido a proveedor (`Ordered`) como disponible. Es lo que quieren algunos
tenants y no lo que quiere Noelito, que necesita `InStock - Committed`. Los tres números ya vienen en
el payload de B1 (`ItemWarehouseInfoCollection`, embebido en el Item), así que no hace falta ninguna
llamada nueva a SAP: es sólo decidir qué se suma y qué se resta.

| Tenant | Fórmula de `available` |
|---|---|
| `sap_integration_noelito` | `InStock - Committed` |
| `sap_integration_distelsa`, `sap_integration_amc`, `sap_integration_printer` | `InStock - Committed + Ordered` (lo de hoy) |

`getWarehouseAvailableStock` alimenta **dos caminos** que tienen que recibir el mismo cambio, o las
columnas de producto y las de line item divergen:

1. **Sync de productos**: `WarehouseStockEnrichmentAdapter` →
   `B1ItemWarehouseStrategy.buildProperties` (`b1-item-warehouse.strategy.js:218`) →
   `buildB1WarehouseStockProperties` (`:148`) → `getWarehouseMetricValue` (`:76`) → la fórmula.
2. **Precios de line items y fallback de `product.handler`**:
   `SyncLineItemPrices.js:283` y `SyncDealLineItemPricesByPriceList.js:189` →
   `TenantLineItemPriceConfigRepository.resolveWarehouseStockProperties` (`:220`) →
   `warehouseStock.js:41` (`getHubspotWarehouseStockPropertiesForTenant`) →
   `buildB1WarehouseStockProperties`. El mismo wrapper lo usa `product.handler.js:46`
   (`buildPreprocessContext`) y `:72-79` (el fallback cuando el enricher no corrió).

## Lo que se cambia

### La config

Un documento nuevo en la colección `Configurations` de cada tenant:

```json
{
  "key": "warehouseAvailableFormula",
  "value": { "add": ["InStock", "Ordered"], "subtract": ["Committed"] }
}
```

`available` pasa a significar: la suma de los campos de `add` menos la suma de los campos de
`subtract`, leídos de la bodega tal como vienen en `ItemWarehouseInfoCollection`, con el mismo
`Number(x ?? 0)` de hoy (bodega ausente o campo ausente → `0`).

Reglas de normalización, aplicadas con `trim()` y sin distinguir mayúsculas, devolviendo la forma
canónica (`InStock`, `Committed`, `Ordered`):

| Entrada | Resultado |
|---|---|
| Documento ausente, `value: null` o `undefined` | Default `{ add: ['InStock', 'Ordered'], subtract: ['Committed'] }` |
| `add` o `subtract` ausentes | Se tratan como lista vacía |
| Nombres repetidos dentro de una misma lista | Se colapsan a uno |
| `value` no es objeto plano (string, array, número) | **Inválida** |
| `add` o `subtract` presentes pero no son array | **Inválida** |
| Un nombre que no es `InStock`, `Committed` ni `Ordered` (ej. `"InStok"`, `"MinimalStock"`) | **Inválida** |
| El mismo campo en `add` y en `subtract` | **Inválida** (se anula solo; es un error de tipeo, no una intención) |
| Las dos listas vacías | **Inválida** (una fórmula que siempre da `0` no es lo que nadie quiere) |

Sólo los tres campos de stock son válidos a propósito. `ItemWarehouseInfoCollection` trae más números
(`MinimalStock`, `MaximalStock`, `StandardAveragePrice`, `Counted`…) pero ninguno es stock
disponible, y abrir la lista sólo agranda el espacio de configs plausibles-pero-equivocadas.

### Fórmula inválida: las `available` no se escriben y queda un `SyncWarning`

Misma regla que ya se decidió para una `metric` inválida en el spec del 2026-08-20, y por la misma
razón: **nunca escribir un número plausible pero equivocado en una columna de inventario**, porque
nadie lo detecta mirando. Una columna que dejó de actualizarse sí se nota.

Con la fórmula inválida, en esa corrida:

- Las entradas de `fieldsWareHouseHS` con métrica `available` (explícita o por default) **no se
  emiten**. HubSpot conserva el último valor sincronizado; no se vacía nada.
- Las entradas `inStock`, `committed` y `ordered` se escriben normal: no dependen de la fórmula.
- Una bodega en `excludedWarehouses` sigue saliendo en `0` en cualquier métrica, incluida `available`.
  La exclusión significa "esta bodega no existe para HubSpot" y eso no depende de cómo se calcule
  el disponible.
- Se escribe **un** documento en `SyncWarnings` por corrida (no uno por producto ni por entrada):

| Campo | Valor |
|---|---|
| `code` | `'warehouse_available_formula_invalid'` |
| `objectType` | `'product'` |
| `message` | `Warehouse available formula invalid: <reason>` |
| `details` | `{ raw: <lo recibido>, reason, validFields: ['InStock', 'Committed', 'Ordered'] }` |
| `syncLogId`, `clientConfigId` | los de la corrida |
| `sapId` | `null` — la config es del tenant, no de un producto |

`reason` es una de: `not_an_object`, `add_not_an_array`, `subtract_not_an_array`,
`unknown_field:<nombre>`, `field_in_both_lists:<nombre>`, `empty_formula`.

En el camino de line items (`warehouseStock.js`) **no se escribe `SyncWarning`**: ese wrapper es un
módulo sin inyección de dependencias y el webhook no tiene `syncLogId`. Ahí una fórmula inválida deja
sólo `console.error` y omite las `available`. El aviso consultable lo produce el sync de productos,
que corre periódicamente sobre la misma config, así que la config mal escrita igual queda registrada.
(El schema de `SyncWarning` tiene `syncLogId` con `default: null`, así que si algún día se quiere
registrar también desde el webhook no hay que tocar el modelo; hoy no se hace para no convertir el
wrapper en algo que hay que cablear.)

### Todo tenant nace con el default

`ensureTenantConfigurations` (`src/infrastructure/tenants/tenantProvisioning.js:88`) siembra el
documento con `$setOnInsert` + `upsert: true`, igual que las otras nueve claves que ya siembra. Un
tenant nuevo ve la clave en el admin desde el primer día con el cálculo actual, y cambiarla es editar
ese documento.

### Tenants existentes: sin migración, JSON pegable

Los cuatro tenants de producción no tienen el documento y **nada cambia para ellos hasta que se
inserte**: ausente = default, que es bit por bit lo que reciben hoy. Los documentos, para insertar por
Compass en `Configurations` de cada tenant:

`sap_integration_distelsa`, `sap_integration_amc`, `sap_integration_printer` (el default, para que
la clave sea visible y editable):

```json
{ "key": "warehouseAvailableFormula", "value": { "add": ["InStock", "Ordered"], "subtract": ["Committed"] }, "userUpdated": "admin" }
```

`sap_integration_noelito` (el único cuyos números cambian):

```json
{ "key": "warehouseAvailableFormula", "value": { "add": ["InStock"], "subtract": ["Committed"] }, "userUpdated": "admin" }
```

Detalle a saber: el camino de line items lee la clave con `tenantConfigurationService.getValue`, que
**crea el documento con el default la primera vez que falta** (`tenantConfiguration.service.js`,
`findOneAndUpdate` con `$setOnInsert`), igual que ya hace con `fieldsWareHouseHS`. O sea que aunque no
se inserte nada, el doc con el default aparece solo tras el primer webhook de precios del tenant. Es
inofensivo (el default es lo de hoy), pero explica por qué un tenant puede "ya tener" la clave sin que
nadie la haya insertado. El camino del sync de productos (`WarehouseStockConfigRepository`) sigue
leyendo con `findOne` sin upsert, como hasta ahora.

## Lo que NO se cambia, a propósito

| Decisión | Por qué |
|---|---|
| **S/4HANA no lee la clave** | Su eje de "qué stock cuenta" ya existe y es `stockType` por entrada (`s4-plant-storage-location.strategy.js`). No tiene `InStock/Committed/Ordered`. `S4PlantStorageLocationStrategy` implementa el método nuevo del port devolviendo `undefined` sin llamar el callback e ignora el argumento en `buildProperties`, igual que hoy ignora `metric` |
| **`metric` por entrada no cambia** | `inStock`, `committed` y `ordered` siguen siendo el campo crudo. La fórmula sólo define `available` |
| **La fórmula es por tenant, no por entrada** | Nadie pidió que dos bodegas del mismo tenant calculen disponible distinto. Si algún día hace falta, una entrada puede declarar `metric` cruda hoy mismo |
| **`excludedWarehouses` gana con `0`** | Como hasta ahora, en cualquier métrica y con cualquier fórmula |
| **`getWarehouseAvailableStock(warehouse)` con un solo argumento sigue dando lo de hoy** | El segundo parámetro tiene default. Ningún test ni llamador existente cambia |
| **`getAvailableStockForB1Warehouse` / `getAvailableStockForWarehouse` quedan con el default** | Verificado en el spec anterior: sin consumidores en producción, sólo tests. No vale cablearles la fórmula |
| **El schema de `SyncWarning` no cambia** | Los campos que hacen falta ya existen |
| **`WAREHOUSE_STOCK_CONFIG_KEY` (`warehouseStockStrategy`) no absorbe la fórmula** | Ver alternativas descartadas |
| **No hay script de migración** | Cuatro inserts de una línea, por tenant, como manda la regla del repo para migraciones. El JSON está arriba |

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Expresión de texto: `"InStock - Committed + Ordered"`** | Más legible en Compass, pero obliga a escribir y testear un mini-parser, y los errores (`InStok`, un `*` colado, doble signo) son menos obvios de validar y de reportar que "este nombre no está en la lista" |
| **Mapa con signo: `{ "InStock": 1, "Committed": -1 }`** | Compacto, pero `1/-1` se lee peor que `add/subtract`, y admite pesos (`0.5`, `2`) que nadie pidió y que habría que decidir si rechazar |
| **Meter la fórmula dentro de `warehouseStockStrategy`: `{ strategy, availableFormula }`** | Ese documento hoy no existe en ningún tenant B1 (todos usan el default por ausencia), así que "nacer con el default" obligaría a sembrar también `strategy`, y editar la fórmula en el admin pasaría a tocar un documento que decide algo mucho más grande. Una clave propia es más visible y más difícil de romper por accidente |
| **Fórmula inválida → cae al default con `SyncWarning`** | La corrida queda completa, pero el tenant recibe durante ese tiempo un número que no pidió, y nadie lo nota mirando. Es exactamente lo que se rechazó para `metric` inválida |
| **Fórmula inválida → aborta la corrida de productos** | Una clave mal escrita dejaría al tenant sin sincronizar nombre y precio de ningún producto. El resto de los enrichers está escrito para degradar, no abortar |
| **Fórmula inválida → sólo `console.error`** | Rechazado ya en el spec anterior: un log se pierde. El aviso tiene que quedar en una colección consultable |
| **Sin default en código: doc ausente = inválido** | Fuerza a que el documento exista, pero rompe a los cuatro tenants el día del deploy hasta que se inserte |
| **Script `scripts/seed-warehouse-available-formula.mjs` para los cuatro tenants** | Código nuevo para cuatro inserts de una línea; Noelito igual habría que editarlo a mano después |
| **Permitir cualquier campo numérico de `ItemWarehouseInfoCollection`** | Agranda el espacio de configs plausibles-pero-equivocadas sin ningún caso de uso |

## Cambios en el código

Nueve archivos en ocho secciones. Los tres primeros son el comportamiento; el resto es el cableado en
los dos caminos, el port y el nacimiento del tenant. Las rutas y líneas están verificadas leyendo los
archivos en el commit `b20505e`.

### 1. `src/domain/warehouses/warehouse-stock-strategy.constants.js`

Agregar, junto a `WAREHOUSE_METRIC_INVALID_WARNING` (línea 46):

```js
// Documento por tenant ({ key: 'warehouseAvailableFormula', value: { add: [...],
// subtract: [...] } }) que define que significa la metrica `available` en B1:
// suma de los campos de add menos suma de los de subtract.
export const WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY = 'warehouseAvailableFormula';

// Los unicos campos de ItemWarehouseInfoCollection que pueden entrar en la
// formula. Los demas numeros del payload no son stock disponible.
export const B1_WAREHOUSE_STOCK_FIELDS = Object.freeze(['InStock', 'Committed', 'Ordered']);

// InStock - Committed + Ordered: el comportamiento historico. Documento ausente
// = esta formula, asi que ningun tenant existente cambia hasta que la edite.
export const DEFAULT_B1_AVAILABLE_FORMULA = Object.freeze({
  add: Object.freeze(['InStock', 'Ordered']),
  subtract: Object.freeze(['Committed']),
});

export const WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING = 'warehouse_available_formula_invalid';
```

Y sumar las cuatro al `export default` (línea 53).

### 2. `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`

1. Nueva `normalizeB1AvailableFormula(raw, { onInvalid } = {})`:
   - `raw` `undefined`/`null` → `DEFAULT_B1_AVAILABLE_FORMULA`.
   - Aplica la tabla de reglas de arriba. Devuelve `{ add: [...], subtract: [...] }` con nombres
     canónicos, o `null` tras llamar `onInvalid?.({ raw, reason })` con el primer motivo encontrado.
   - La firma de un argumento funciona igual (una inválida devuelve `null` sin tirar), como
     `normalizeB1WarehouseFields`.
   - Para resolver el nombre canónico se usa un `Map` minúscula → canónico construido desde
     `B1_WAREHOUSE_STOCK_FIELDS`, igual que `METRIC_BY_LOWERCASE` (línea 58).

2. `getWarehouseAvailableStock(warehouse, formula = DEFAULT_B1_AVAILABLE_FORMULA)` (línea 47):
   suma `Number(warehouse?.[field] ?? 0)` para cada campo de `formula.add` y resta lo mismo para
   `formula.subtract`. Con un solo argumento da exactamente lo de hoy.

3. `getWarehouseMetricValue(warehouse, metric = DEFAULT_B1_STOCK_METRIC, formula = DEFAULT_B1_AVAILABLE_FORMULA)`
   (línea 76): la rama `default` pasa `formula` a `getWarehouseAvailableStock`. Las otras tres ramas
   no cambian.

4. `buildB1WarehouseStockProperties(warehouseItems, warehouseFields, exclusions, { availableFormula = DEFAULT_B1_AVAILABLE_FORMULA } = {})`
   (línea 148): cuarto parámetro opcional. Dentro del `reduce`, **después** de la rama de exclusión
   (que sigue escribiendo `0`) y **antes** de la línea 173:

   ```js
   // Formula invalida: la entrada `available` se omite en vez de escribir un
   // numero con la formula equivocada. Las metricas crudas no dependen de ella.
   // El `??` cubre un field armado a mano sin metric (forma historica), que
   // tambien es `available`.
   if (
     availableFormula === null
     && (field.metric ?? DEFAULT_B1_STOCK_METRIC) === B1_STOCK_METRICS.AVAILABLE
   ) {
     return acc;
   }
   ```

   Y la línea 173 pasa a `getWarehouseMetricValue(warehouse, field.metric, availableFormula)`.

5. `B1ItemWarehouseStrategy` (línea 194) gana:

   ```js
   normalizeAvailableFormula(rawValue, options) {
     return normalizeB1AvailableFormula(rawValue, options);
   }
   ```

   y `buildProperties({ record, fields, exclusions = [], availableFormula })` (línea 218) pasa
   `{ availableFormula }` como cuarto argumento a `buildB1WarehouseStockProperties`. Cuando el
   llamador no manda `availableFormula` (tests que construyen la strategy a mano), `undefined` cae al
   default del parámetro, así que nada existente cambia.

### 3. `src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js`

`S4PlantStorageLocationStrategy` (línea 261) gana un método que devuelve `undefined` y **no** llama
el callback:

```js
// La formula de disponible es un concepto de B1. En S/4 lo que cuenta lo
// decide stockType por entrada, asi que aca no hay nada que validar ni avisar.
normalizeAvailableFormula() {
  return undefined;
}
```

`buildProperties` (línea 282) no cambia: no destructura `availableFormula`, así que lo ignora.

### 4. `src/application/ports/sap/warehouse-stock-strategy.port.js`

Agregar `'normalizeAvailableFormula'` a `methods` (líneas 8-15). La composición **no** aplica
`assertPort` a las strategies (sólo al enricher, contra `SapRecordEnricherPort`); quienes verifican
el contrato son los dos tests "implements the WarehouseStockStrategyPort contract"
(`tests/unit/domain/b1ItemWarehouseStrategy.test.js:287` y
`tests/unit/domain/s4PlantStorageLocationStrategy.test.js:261`). Agregar el método al port sin
implementarlo en una de las dos strategies pone rojo el test de esa strategy, que es lo que se quiere.

### 5. `src/infrastructure/config/WarehouseStockConfigRepository.js`

- Importar `WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY`.
- El `Promise.all` (líneas 33-37) lee una cuarta clave y el retorno (línea 42) suma
  `rawAvailableFormula`. El fallback del `catch` (línea 48) suma `rawAvailableFormula: null`.
- Sigue leyendo con `findOne` sin upsert, como dice el comentario de la clase: este camino no crea
  documentos.

### 6. `src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js`

- Importar `WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING` y `B1_WAREHOUSE_STOCK_FIELDS`.
- Tras `getWarehouseStockConfig` (línea 56) destructurar también `rawAvailableFormula`.
- Junto a `normalizeFields` (línea 64):

  ```js
  let invalidFormula = null;
  const availableFormula = strategy.normalizeAvailableFormula(rawAvailableFormula, {
    onInvalid: (entry) => { invalidFormula = entry; },
  });
  ```

- Nuevo `recordInvalidFormulaWarning({ invalidFormula, tenantModels, clientConfigId, syncLogId })`,
  llamado junto a `recordInvalidMetricWarnings` (línea 69) y **antes** del `return` temprano de
  `fields.length === 0`, por la misma razón que ese método: si el tenant no tiene bodegas
  configuradas igual queremos el aviso. Mismo patrón: `logger.error` siempre; `record` sólo si
  `typeof this.syncWarningRepository?.record === 'function'`; `try/catch` alrededor de `record`
  para que un fallo al avisar no se lleve el enriquecimiento.
- `strategy.buildProperties` (línea 110) recibe `availableFormula` además de
  `record, index, fields, exclusions`.
- El `syncWarningRepository` ya está cableado en `sap-sync.composition.js:123`
  (`syncWarningRepository: new MongooseSyncWarningRepository()`), así que **la composición no
  cambia**. El test de composición existente ya afirma la clave.

### 7. `src/infrastructure/hubspot/warehouseStock.js` y `src/infrastructure/hubspot/handlers/product.handler.js`

`warehouseStock.js`:

- Importar `normalizeB1AvailableFormula` de la strategy y `WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY`,
  `DEFAULT_B1_AVAILABLE_FORMULA` de las constantes.
- Nueva `resolveHubspotAvailableFormula(tenantModels)`: `tenantConfigurationService.getValue(tenantModels, WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY, DEFAULT_B1_AVAILABLE_FORMULA)`
  y luego `normalizeB1AvailableFormula(value, { onInvalid: (entry) => console.error('Warehouse available formula invalid', entry) })`.
  Devuelve la fórmula normalizada o `null`.
- `buildHubspotWarehouseStockProperties(warehouseItems, warehouseFields, options)` (línea 34) pasa
  `options` como cuarto argumento a `buildB1WarehouseStockProperties` (las exclusiones siguen sin
  pasarse por este camino, como hoy).
- `getHubspotWarehouseStockPropertiesForTenant` (línea 41) lee fields y fórmula con `Promise.all` y
  pasa `{ availableFormula }`.

`product.handler.js`:

- `buildPreprocessContext` (línea 46) lee también `resolveHubspotAvailableFormula` en el mismo
  `Promise.all` y devuelve `{ warehouseFields, priceFields, availableFormula }` (línea 52).
- La rama de `preprocessContext?.warehouseFields` (línea 72) pasa
  `{ availableFormula: preprocessContext.availableFormula }` como tercer argumento a
  `buildHubspotWarehouseStockProperties`. Si un `preprocessContext` viejo no trae la clave,
  `undefined` cae al default.

`TenantLineItemPriceConfigRepository.resolveWarehouseStockProperties` (`:220`) no cambia: llama al
wrapper, que ya resuelve la fórmula por dentro.

### 8. `src/infrastructure/tenants/tenantProvisioning.js`

Importar `WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY` y `DEFAULT_B1_AVAILABLE_FORMULA` desde
`#domain/warehouses/warehouse-stock-strategy.constants.js` y agregar al final de
`ensureTenantConfigurations` (después del bloque de `REQUIRE_ADDRESS_CONFIG_KEY`, líneas 201-213) un
`updateOne` con la misma forma:

```js
// Sembrada con el calculo historico (InStock - Committed + Ordered). Se
// cambia editando el documento; nunca hay que crear la clave a mano.
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

Se copian los arrays porque la constante está congelada y Mongoose muta lo que recibe en algunos
caminos; un `Object.freeze` que llega a un `$setOnInsert` es un bug difícil de ver.

### Lo que no se toca

`warehouse-stock-strategy.factory.js`, `sap-sync.composition.js`, `SyncSapConfigToHubspot.js`,
`SyncLineItemPrices.js`, `SyncDealLineItemPricesByPriceList.js`,
`TenantLineItemPriceConfigRepository.js`, `line-item-price.port.js` (en `src/ports/`),
`sync-warning-repository.port.js`,
`MongooseSyncWarningRepository.js`, el schema de `SyncWarning`, `tenantConfiguration.service.js`:
**cero cambios**. El contrato de salida sigue siendo un `{ propertyName: number }` plano.

## Tests

TDD: cada test rojo antes de la implementación que lo pone verde. Correr jest **desde el checkout
principal** con el patrón de este repo (ver memoria `jest-picks-up-worktree-tests`), no con
`npm test`.

### `normalizeB1AvailableFormula` (en `tests/unit/domain/b1ItemWarehouseStrategy.test.js`)

- `undefined` y `null` → `{ add: ['InStock', 'Ordered'], subtract: ['Committed'] }`.
- `{ add: ['instock'], subtract: ['COMMITTED'] }` → `{ add: ['InStock'], subtract: ['Committed'] }`.
- `{ add: ['InStock', 'InStock'] }` → `{ add: ['InStock'], subtract: [] }` (duplicado colapsado,
  `subtract` ausente = vacío).
- `{ add: ['InStok'] }` → `null`, `onInvalid` llamado una vez con `reason: 'unknown_field:InStok'`.
- `{ add: ['InStock'], subtract: ['InStock'] }` → `null`, `reason: 'field_in_both_lists:InStock'`.
- `{ add: [], subtract: [] }` y `{}` → `null`, `reason: 'empty_formula'`.
- `'InStock - Committed'` (string) → `null`, `reason: 'not_an_object'`.
- `{ add: 'InStock' }` → `null`, `reason: 'add_not_an_array'`.
- Sin `onInvalid`, una inválida devuelve `null` y **no** tira.

### `getWarehouseAvailableStock`

Con `{ InStock: 7, Committed: 1, Ordered: 2 }`: sin fórmula → `8` (el test existente de la línea 15
queda intacto); fórmula Noelito `{ add: ['InStock'], subtract: ['Committed'] }` → `6`; `{ add:
['InStock'], subtract: [] }` → `7`; `{ add: ['Ordered'], subtract: ['InStock', 'Committed'] }` →
`-6`. Con `undefined` como bodega y fórmula Noelito → `0`.

### `getWarehouseMetricValue`

`available` con fórmula Noelito → `6`; `inStock`/`committed`/`ordered` con fórmula Noelito → `7`,
`1`, `2` (la fórmula no las toca). Los tests existentes (líneas 319-346) quedan intactos.

### `buildB1WarehouseStockProperties`

- Fixture de tres bodegas y tres entradas (`a01_stock` sin `metric`, `a01_instock` con `inStock`,
  `b09_stock` con `available` explícito):
  - Con fórmula Noelito → `a01_stock` y `b09_stock` usan `InStock - Committed`; `a01_instock` es el
    crudo.
  - Con `{ availableFormula: null }` → **sólo** `a01_instock` está en el resultado; `a01_stock` y
    `b09_stock` no existen como claves (ni `0` ni `undefined`).
  - Sin cuarto argumento → los mismos números que hoy (regresión del perfil legacy del spec anterior).
- Con `availableFormula: null` y `B09` en `excludedWarehouses` → `b09_stock: 0` **sí** está: la
  exclusión gana sobre la omisión.
- Field armado a mano sin `metric` (`{ warehouseCode, propertyName }`) y `availableFormula: null` →
  se omite igual que uno con `metric: 'available'`.

### Strategies

- `B1ItemWarehouseStrategy.normalizeAvailableFormula` delega y pasa `options`.
- `B1ItemWarehouseStrategy.buildProperties` con `availableFormula` Noelito sobre un `record` con
  `ItemWarehouseInfoCollection` → los números de Noelito; sin `availableFormula` → los de hoy.
- `S4PlantStorageLocationStrategy.normalizeAvailableFormula({ add: ['garbage'] }, { onInvalid })` →
  `undefined` y `onInvalid` **no** llamado (en `tests/unit/domain/s4PlantStorageLocationStrategy.test.js`).
- Los dos tests de contrato existentes (`b1ItemWarehouseStrategy.test.js:287`,
  `s4PlantStorageLocationStrategy.test.js:261`) siguen verdes con el método nuevo en el port.

### `WarehouseStockConfigRepository` (en `tests/unit/infrastructure/warehouseStockConfigRepository.test.js`)

- Lee `warehouseAvailableFormula` con `findOne({ key: 'warehouseAvailableFormula' })` y lo devuelve
  crudo como `rawAvailableFormula` (no normaliza: eso es de la strategy).
- Sin documento → `rawAvailableFormula: null`.
- El test existente "never upserts" (línea 39) sigue verde: cuatro `findOne`, cero `findOneAndUpdate`.
- El `catch` devuelve `rawAvailableFormula: null`.

### `WarehouseStockEnrichmentAdapter` (en `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`)

- Config con fórmula Noelito y una entrada `available` → `buildProperties` recibe
  `availableFormula: { add: ['InStock'], subtract: ['Committed'] }` y el número escrito es
  `InStock - Committed`.
- Fórmula inválida → `syncWarningRepository.record` llamado **una** vez con
  `code: 'warehouse_available_formula_invalid'`, `objectType: 'product'`, `sapId: null`, el
  `clientConfigId` y `syncLogId` recibidos, y `details.reason`. Con 3 registros sigue siendo 1
  llamada.
- Fórmula inválida **y** `fieldsWareHouseHS` vacío → el warning se registra igual (antes del return
  temprano).
- Fórmula inválida con una entrada `available` y una `inStock` → la `inStock` se escribe, la
  `available` no aparece.
- Fórmula inválida y métrica inválida a la vez → dos warnings con códigos distintos.
- Sin `syncWarningRepository` → no tira. `record` rechaza → no tira y las propiedades válidas se
  escriben.
- Tenant S/4 (strategy S4 mockeada devolviendo `undefined` en `normalizeAvailableFormula`) con un
  documento basura → `record` **no** se llama.

### `warehouseStock.js` (en `tests/unit/warehouseStock.test.js`)

- `getHubspotWarehouseStockPropertiesForTenant` con `tenantModels` cuyo `Configuration.findOne`
  devuelve la fórmula Noelito → `distelsa_stock` sale con `InStock - Committed`. Los seis tests
  existentes quedan intactos (leen sin documento de fórmula → default).
- `getValue` se llama con `('warehouseAvailableFormula', DEFAULT_B1_AVAILABLE_FORMULA)`.
- Fórmula inválida → las `available` no aparecen y `console.error` se llamó; no tira.

### `product.handler.js` (en `tests/unit/product.handler.test.js`)

- `buildPreprocessContext` devuelve `availableFormula`.
- `preprocess` con `preprocessContext.availableFormula` Noelito y sin `_warehouseStock` en
  `rawSapData` → las propiedades usan `InStock - Committed`.
- `preprocess` con `_warehouseStock` presente → lo usa tal cual (no recalcula), como hoy.

### `ensureTenantConfigurations` (en `tests/unit/infrastructure/tenantProvisioningBpKeys.test.js` o un archivo hermano)

Con el mismo patrón que los dos tests existentes: la llamada a `updateOne` con
`filter.key === 'warehouseAvailableFormula'` existe, `$setOnInsert.value` es
`{ add: ['InStock', 'Ordered'], subtract: ['Committed'] }`, `userUpdated: 'admin'`, y
`call[2]` es `{ upsert: true }`. Además `Object.isFrozen($setOnInsert.value.add) === false`.

### Regresión

Ningún número que Distelsa, AMC o Printer reciben hoy cambia: el default del parámetro es la fórmula
histórica en las cuatro funciones, y los tests que afirman números (`distelsa_stock: 8`,
`A01_stock: 8`, `b12_stock: 1400`, etc.) no se editan.

## Documentación

Agregar a `configuration_examples.md` la entrada `warehouseAvailableFormula` con el formato del
catálogo (prosa más ejemplo), cubriendo: qué significa `add`/`subtract`, los tres campos válidos, que
ausente = `InStock - Committed + Ordered`, que sólo define la métrica `available` (las crudas no la
leen), que una fórmula inválida omite las `available` de esa corrida y deja un `SyncWarning` con
`code: 'warehouse_available_formula_invalid'`, que la exclusión sigue ganando con `0`, que sólo aplica
a B1 (en S/4 el eje es `stockType`), y que el camino de line items la crea con el default al primer
uso si no existe. Ejemplo:

```json
{ "key": "warehouseAvailableFormula", "value": { "add": ["InStock"], "subtract": ["Committed"] } }
```

Y en la entrada existente de `fieldsWareHouseHS` (línea 83), reemplazar "`'available'` … es
`InStock - Committed + Ordered`" por "`'available'` … es la fórmula de `warehouseAvailableFormula`
(por defecto `InStock - Committed + Ordered`)".
