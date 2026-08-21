# Métrica de stock por bodega configurable en SAP Business One

Fecha: 2026-08-20
Aplica sólo a: SAP Business One (Service Layer). S/4HANA no se toca.

## El problema

Hoy la strategy de B1 tiene **una sola** forma de convertir una bodega en un número, y está
cableada en `b1-item-warehouse.strategy.js:35`:

```js
export function getWarehouseAvailableStock(warehouse) {
  const inStock = Number(warehouse?.InStock ?? 0);
  const committed = Number(warehouse?.Committed ?? 0);
  const ordered = Number(warehouse?.Ordered ?? 0);

  return inStock - committed + ordered;
}
```

`buildB1WarehouseStockProperties` (`b1-item-warehouse.strategy.js:117`) la aplica a cada entrada de
`fieldsWareHouseHS`, así que cada propiedad de HubSpot recibe siempre esa resta-suma. Eso es lo que
quieren dos de los cuatro tenants y no es lo que quieren los otros dos:

| Tenant | Qué quiere en HubSpot |
|---|---|
| `sap_integration_distelsa` | Una columna por bodega con `InStock - Committed + Ordered` — lo de hoy |
| `sap_integration_noelito` | Lo mismo |
| `sap_integration_amc` | Tres columnas por bodega: `InStock`, `Committed` y `Ordered` por separado, más una cuarta acumulativa |
| `sap_integration_printer` | Una columna por bodega, y sólo con `InStock`. Las otras dos no le interesan |

Los tres valores ya vienen en el payload, no hace falta ninguna llamada nueva a SAP: la strategy de
B1 lee `ItemWarehouseInfoCollection` que viaja embebida en el propio Item.

```json
{ "WarehouseCode": "B09", "InStock": 66.0, "Committed": 0.0, "Ordered": 0.0, "ItemCode": "P27020056" }
```

## Lo que se cambia

Cada entrada de `fieldsWareHouseHS` gana un campo `metric` opcional. Una entrada sigue siendo
**una** propiedad de HubSpot; lo único nuevo es que la entrada declara **qué número** lleva.

| `metric` | Valor escrito en la propiedad |
|---|---|
| ausente, o `"available"` | `InStock - Committed + Ordered` (el comportamiento actual) |
| `"inStock"` | el `InStock` crudo de esa bodega |
| `"committed"` | el `Committed` crudo |
| `"ordered"` | el `Ordered` crudo |

La comparación es por `trim()` + minúsculas, así que `"InStock"`, `"instock"` e `"inStock"` son la
misma métrica. Sirve para que el cliente pueda escribir el nombre tal como lo ve en el JSON de SAP.

Si AMC quiere tres números de la bodega `A01`, pone tres entradas con el mismo `valueSAP: "A01"` y
`value` distinto. No hay forma de que una entrada produzca dos propiedades.

### Métrica desconocida: se descarta la entrada y se registra un `SyncWarning`

Una `metric` que no esté en la tabla hace que la entrada se descarte y que se escriba **un documento
en la colección `SyncWarnings`** por propiedad mal configurada. La propiedad **no se escribe** en
HubSpot.

No cae de vuelta a `available` a propósito. Un typo como `"inStok"` produciría un número plausible
pero equivocado en una columna de inventario, y eso nadie lo detecta mirando; una columna vacía sí.

`SyncWarnings` es el mecanismo que ya existe para esto: tiene modelo
(`src/infrastructure/database/models/tenant/SyncWarning.js`), port
(`sync-warning-repository.port.js`), repositorio (`MongooseSyncWarningRepository`) y cinco use-cases
que lo inyectan con el mismo patrón de dependencia opcional. Ventajas sobre empujar al array
`errors` del `SyncLog`: queda atado a la corrida por `syncLogId` **sin** marcarla como `errored`, y
no mezcla "config mal escrita" con "este registro falló al enviarse a HubSpot", que es lo que ese
array significa hoy.

El documento que se escribe:

| Campo | Valor |
|---|---|
| `code` | `'warehouse_metric_invalid'` |
| `objectType` | `'product'` |
| `message` | `Warehouse stock metric not supported: "<lo recibido>"` |
| `details` | `{ propertyName, warehouseCode, metric: <lo recibido>, validMetrics: [...] }` |
| `syncLogId`, `clientConfigId` | los de la corrida |
| `sapId` | `null` — la config es del tenant, no de un producto |

Es **una vez por corrida y por entrada mal configurada**, no una por producto: la normalización de
`fieldsWareHouseHS` ocurre una sola vez en `WarehouseStockEnrichmentAdapter.enrich`, antes del bucle
de registros. Con 60 entradas y 3 mal escritas, son 3 documentos por corrida.

`MongooseSyncWarningRepository.record` ya está escrito para no tirar nunca (`try/catch` que resuelve
`null`), así que un fallo al escribir el aviso no puede abortar el sync.

### Sólo B1

`S4PlantStorageLocationStrategy` no lee `metric` y no cambia. Su eje equivalente ya existe y es
`stockType` por field (`s4-plant-storage-location.strategy.js:105`), que decide qué tipos de stock se
suman en esa propiedad. Las dos strategies siguen cumpliendo el mismo `WarehouseStockStrategyPort`
sin que el port cambie.

## Lo que NO se cambia, a propósito

| Decisión | Por qué |
|---|---|
| **La cuarta columna acumulativa de AMC no la calcula el código** | Decisión del dueño del proyecto: se resuelve con una propiedad calculada en HubSpot. Riesgo asumido, del lado del portal: es una fórmula que suma ~18 propiedades y se rompe en silencio si alguien renombra una |
| **La fórmula `available` sigue sumando `Ordered`** | O sea que cuenta stock entrante (órdenes de compra) como disponible. Es lo que Distelsa y Noelito tienen hoy en producción; cambiar la semántica sin que el cliente lo pida sería cambiarle los números sin aviso |
| **Distelsa y Noelito no cambian ni un documento en Mongo** | Sin `metric`, el comportamiento es el actual bit por bit. Ninguna config existente se migra |
| **No se agrega redondeo** | Las métricas crudas no hacen aritmética, así que no generan el ruido de punto flotante que sí motivó `QUANTITY_DECIMALS` en S/4 (`warehouse-stock-strategy.constants.js:31`). Y `available` sigue sin redondear, como hoy, para no mover valores existentes |
| **Bodega en `excludedWarehouses` → `0` en cualquier métrica** | La exclusión sigue ganando sobre lo que reporte SAP (`b1-item-warehouse.strategy.js:112`). Cero en `committed` es semánticamente raro, pero la exclusión significa "esta bodega no existe para HubSpot", y eso aplica igual a las cuatro métricas |
| **El fallback que deduce la bodega del nombre de la propiedad queda intacto** | `resolveWarehouseCodeFromPropertyName` (`b1-item-warehouse.strategy.js:10`) sólo actúa cuando falta `valueSAP`, y sólo matchea `^(\w+)_stock$`. Una entrada sin `valueSAP` llamada `a01_instock` se descarta — exactamente como hoy se descarta cualquier nombre que no termine en `_stock` |
| **`getAvailableStockForB1Warehouse` / `getAvailableStockForWarehouse` quedan como están** | Verificado: no tienen ningún consumidor en producción, sólo tests. La `metric` es puramente proyección a propiedades de HubSpot y no toca ninguna validación de disponibilidad en pedidos ni en transferencias de inventario |
| **No hay migración ni script que cree propiedades en HubSpot** | El JSON de config se entrega como archivo (ver más abajo) y lo aplica quien hace el onboarding; las propiedades del portal las crea el dueño del proyecto a mano |
| **El `SyncLog` no cambia de esquema ni de estado** | Una config mal escrita no vuelve `errored` una corrida que sí sincronizó todo lo demás. El aviso vive en `SyncWarnings`, atado por `syncLogId` |

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Una entrada por bodega con un mapa `metrics: { inStock: 'a01_instock', committed: 'a01_committed' }`** | Reduce la config de AMC de 60 filas a 20, pero obliga al normalizador a aceptar dos formas de entrada (`value` plano y mapa) y a la UI admin a tener un control compuesto nuevo. El ahorro es de filas de config, que se escriben una vez; el costo es permanente y está en el código |
| **`metrics: ['inStock','committed','ordered']` a nivel de tenant, con nombres de propiedad derivados por sufijo** | Es la config más corta, pero obliga a que las propiedades del portal se llamen exactamente según la convención, y no deja que una bodega lleve tres métricas y otra sólo una. Printer y AMC no podrían convivir con reglas distintas por bodega |
| **Una strategy nueva, `b1_ItemWarehouseColumns`** | Duplicaría normalización de fields, exclusiones y construcción de propiedades para cambiar una sola línea: qué número sale de cada bodega. Y no cubre a Printer, que quiere columnas separadas pero sólo una de las tres |
| **`metric` como lista sumable (`['inStock','ordered']`)** | Nadie lo pidió. Si algún día hace falta, `available` ya cubre el único combinado que existe hoy |
| **Métrica inválida → `console.error` y nada más** | Fue el diseño inicial y el dueño del proyecto lo rechazó: un log se pierde. El aviso tiene que quedar en una colección consultable |
| **Métrica inválida → cae a `available`** | Escribe un número plausible pero equivocado en una columna de inventario. Peor que no escribir nada, porque nadie lo detecta |
| **Métrica inválida → aborta la corrida** | Una config mal escrita en una bodega de 54 dejaría al tenant sin sincronizar nombre y precio de ningún producto. El resto de los enrichers ya está escrito para degradar, no para abortar |

El campo `metric` por entrada gana porque es el calco del eje que la strategy hermana de S/4 ya
tiene (`stockType` por field): el mismo lugar en la config, la misma granularidad, ninguna strategy
nueva, y cada propiedad de HubSpot declarada con su nombre real en vez de derivada de una convención.

## Cambios en el código

Cinco archivos. Los dos primeros son el comportamiento; los tres siguientes son el cableado del
aviso.

### 1. `src/domain/warehouses/warehouse-stock-strategy.constants.js`

Agregar, junto a `STOCK_TYPE_ALL` (línea 26) que es la constante análoga del lado S/4:

```js
// Qué número de una bodega de B1 va a la propiedad de HubSpot. Es el eje
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
// fieldsWareHouseHS declara una metric que no existe.
export const WAREHOUSE_METRIC_INVALID_WARNING = 'warehouse_metric_invalid';
```

Y sumar los tres al `export default` del final (línea 33), que lista todas las constantes del módulo.

### 2. `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`

1. `getWarehouseAvailableStock` (línea 35) **no se toca**. Pasa a ser la implementación de la métrica
   `available`, y sigue exportada con el mismo nombre para que `warehouseStock.js:18` y los tests
   actuales no cambien.

2. Nueva `normalizeB1StockMetric(raw)`: `undefined`/`null`/`''` → `DEFAULT_B1_STOCK_METRIC`; si no,
   `trim()` + minúsculas comparado contra los valores de `B1_STOCK_METRICS` en minúsculas,
   devolviendo el valor canónico; cualquier otra cosa → `null`.

3. Nueva `getWarehouseMetricValue(warehouse, metric)`: para `available` delega en
   `getWarehouseAvailableStock`; para las otras tres devuelve `Number(warehouse?.<Campo> ?? 0)`, con
   el mismo `?? 0` que ya usa la fórmula actual, de modo que un `warehouse` `undefined` o un campo
   ausente dan `0`.

4. `resolveWarehouseField` (línea 19) resuelve además la métrica y devuelve `null` si es inválida,
   con lo que el field se descarta.

5. **Cómo salen las entradas inválidas del dominio.** `normalizeB1WarehouseFields` gana un segundo
   argumento opcional:

   ```js
   export function normalizeB1WarehouseFields(value, { onInvalidMetric } = {}) { ... }
   ```

   Cuando una entrada trae una métrica que no existe, llama
   `onInvalidMetric?.({ propertyName, warehouseCode, metric })` y sigue con la siguiente. La firma
   de un solo argumento **sigue funcionando igual**, así que `warehouseStock.js:21` y los tests
   actuales no cambian.

   `B1ItemWarehouseStrategy.normalizeFields(rawValue, options)` pasa `options` por transparencia.
   `S4PlantStorageLocationStrategy.normalizeFields(rawValue)` ignora el segundo argumento y no
   cambia; `WarehouseStockStrategyPort` tampoco, porque sólo declara nombres de método.

   Se eligió el callback por sobre las dos alternativas: cambiar el retorno a
   `{ fields, invalid }` rompería a todos los llamadores y a los tests que son la prueba de
   regresión, y una segunda función `collectB1InvalidMetricFields(value)` parsearía la misma entrada
   dos veces con dos implementaciones que pueden divergir.

6. La clave de dedupe (línea 59) pasa de `` `${warehouseCode}:${propertyName.toLowerCase()}` `` a
   `` `${warehouseCode}:${metric}:${propertyName.toLowerCase()}` ``. Para toda config existente
   `metric` es la constante `available`, así que la clave es equivalente y el comportamiento no se
   mueve; lo que habilita es que la misma bodega aparezca tres veces con métricas distintas.

7. `buildB1WarehouseStockProperties` (línea 117) cambia
   `getWarehouseAvailableStock(warehousesByCode.get(warehouseCode))` por
   `getWarehouseMetricValue(warehousesByCode.get(warehouseCode), field.metric)`. La rama de exclusión
   (línea 112) queda igual: sigue escribiendo `0` antes de mirar la métrica.

### 3. `src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js`

- Constructor: nuevo `syncWarningRepository = null`, con el mismo patrón de dependencia opcional que
  usan `SendMappedItemsToHubspot.js:81` y otros cuatro use-cases (guarda
  `typeof this.syncWarningRepository?.record !== 'function'` antes de usarlo).
- `enrich({ mappedRecords, objectType, tenantModels, clientConfigId = null, syncLogId = null })`:
  dos parámetros nuevos, ambos con default, así que ningún llamador existente se rompe.
- Al normalizar los fields, pasa `onInvalidMetric` para juntar las entradas inválidas, y después
  escribe un `SyncWarning` por cada una con el `code`, `message` y `details` de la tabla de arriba.
- El `logger.error` sigue existiendo además del `SyncWarning`: el aviso en Mongo es para el dueño del
  proyecto, el log es para depurar la corrida. No es duplicación de la fuente de verdad porque el log
  no se consulta como registro.

### 4. `src/application/use-cases/SyncSapConfigToHubspot.js`

La llamada al enricher de bodegas (línea 213) pasa los dos datos nuevos, que ya están en scope:
`clientConfigId` (línea 54) y `syncLog?.id ?? syncLog?._id ?? null` (el mismo cálculo que ya hace la
línea 250 para `sendMappedRecords`). Nada más cambia en este archivo.

### 5. `src/composition/sap-sync.composition.js`

`WarehouseStockEnrichmentAdapter` se construye en las líneas 119-124 **sin** repositorio de avisos, y
este archivo hoy no importa `MongooseSyncWarningRepository` en absoluto (el que lo hace es
`hubspot-sync.composition.js:68`). Hay que agregar el import y la clave
`syncWarningRepository: new MongooseSyncWarningRepository()` a ese constructor.

**Este es el punto de fallo silencioso del cambio**: si la clave no se agrega, todo el resto funciona,
todos los tests unitarios pasan, y el aviso simplemente nunca se escribe en producción. Por eso el
plan incluye un test de composición que afirme la clave exacta, no un `expect.any(Object)`.

### Lo que no se toca

`src/infrastructure/hubspot/warehouseStock.js`,
`src/infrastructure/hubspot/handlers/product.handler.js`,
`src/infrastructure/config/WarehouseStockConfigRepository.js`,
`warehouse-stock-strategy.factory.js`, `warehouse-stock-strategy.port.js`,
`sync-warning-repository.port.js`, `MongooseSyncWarningRepository.js` y el esquema de `SyncWarning`:
**cero cambios**. El contrato de salida del enricher sigue siendo un `{ propertyName: number }`
plano, que es todo lo que `product.handler.js:70` sabe leer.

## Config por tenant

No hay migración: el JSON se entrega como archivo y lo aplica quien hace el onboarding.

### `sap_integration_distelsa` y `sap_integration_noelito`

Nada. Su `fieldsWareHouseHS` actual sigue significando lo mismo.

### `sap_integration_amc` — `amc_warehouse_fields.json` en la raíz del repo

Documento `Configuration` completo, listo para insertar, con 60 entradas: las 20 bodegas reales de AMC por las 3
métricas. Convención de nombres `<codigo en minusculas>_<metrica>`:

```json
{
  "key": "fieldsWareHouseHS",
  "value": [
    { "label": "CENTRAL En stock",     "value": "a0002_instock",   "valueSAP": "ALM-0002", "metric": "inStock" },
    { "label": "CENTRAL Comprometido", "value": "a0002_committed", "valueSAP": "ALM-0002", "metric": "committed" },
    { "label": "CENTRAL Solicitado",   "value": "a0002_ordered",   "valueSAP": "ALM-0002", "metric": "ordered" }
  ]
}
```

Las 20 bodegas son `ALM-0001`–`ALM-0018` más `ALM-9998` (INSUMOS) y `ALM-9999` (PROVEEDURIA),
tomadas del `fieldsWareHouseHS` real de AMC, entregado por el dueño del proyecto el 2026-08-21.

**Corrección de una versión anterior de este spec:** el archivo se generó primero con 18
bodegas `A01`/`A02`/`B01`–`B15`/`PA`, sacadas del payload del producto `P27020056`. Esas **no**
eran las bodegas de AMC. El riesgo estaba marcado acá mismo y se confirmó; el archivo actual
sale del catálogo real.

Las 60 propiedades numéricas tienen que existir en el portal **antes** del primer sync, y tienen que
existir **en dos tipos de objeto, no uno**: la misma config alimenta tanto el sync de productos como
el de precios de line items (`SyncLineItemPrices.js:274` →
`TenantLineItemPriceConfigRepository.js:186` (`getHubspotWarehouseStockPropertiesForTenant`) →
`HubspotLineItemPriceClient.js:69`, donde el resultado se derrama con spread dentro de `properties`
de **cada line item**, y también en `:90` dentro del payload de productos). El modo de fallo es
distinto en cada camino: en productos, una propiedad inexistente hace fallar el lote de 100 completo
en `batchCreateProducts`; en precios, el siguiente webhook de line items manda las 60 propiedades
nuevas dentro de cada line item y, si no existen **como propiedades de line item** en el portal,
HubSpot responde 400 y el lote entero de actualización de precios falla — no queda una columna
vacía, queda el precio del negocio sin actualizar. Las propiedades actuales de AMC (`*_stock`) ya
existen como line item porque ese camino ya venía corriendo; los nombres nuevos (`a0002_instock`,
`a0002_committed`, `a0002_ordered`, etc.) no, y hay que crearlos ahí también antes de aplicar esta config.

La cuarta columna acumulativa de AMC es una propiedad calculada del portal que suma las 20
`*_instock`. No sale de este código.

### Rollout: renombrar deja las columnas viejas congeladas

AMC hoy tiene 20 columnas tipo `a0002_stock`. Al reemplazar su `fieldsWareHouseHS` por
`amc_warehouse_fields.json`, que usa `a0002_instock`/`a0002_committed`/`a0002_ordered`, la
propiedad `a0002_stock` deja de aparecer en el payload. HubSpot no vacía una propiedad que dejó de recibir:
conserva el último valor sincronizado. Un vendedor que filtre o reportee por la columna vieja ve el
inventario del día del cambio, para siempre, sin ninguna señal de que está muerta — el mismo tipo de
daño que ya se rechazó arriba para una `metric` inválida (un número plausible pero equivocado que
nadie detecta mirando), sólo que aquí es por el lado de los nombres, no del valor.

Dos salidas al aplicar la config nueva, a decidir con el dueño del proyecto antes del rollout:
archivar o borrar `a01_stock` y las demás columnas viejas en el portal, o dejarlas vivas agregando
una entrada más por bodega con `metric: "available"` (mismo `value` que hoy, mismo `valueSAP`) para
que sigan recibiendo el número histórico en paralelo a las tres columnas nuevas.

### `sap_integration_printer` — sólo `InStock`

Su cambio es agregar `"metric": "inStock"` a cada entrada que ya tiene, conservando `value` y
`valueSAP`:

```json
{ "label": "Bodega A01", "value": "a01_stock", "valueSAP": "A01", "metric": "inStock" }
```

No se entrega archivo porque su lista de bodegas y sus nombres de propiedad actuales no están
verificados en este spec. Con las propiedades ya creadas en el portal, es una edición sobre la
config existente y no requiere crear ninguna propiedad nueva.

## Tests

TDD: cada test rojo antes de la implementación que lo pone verde.

### `getWarehouseMetricValue` (en `tests/unit/domain/b1ItemWarehouseStrategy.test.js`)

Con `{ InStock: 7, Committed: 1, Ordered: 2 }`: `available` → `8`, `inStock` → `7`,
`committed` → `1`, `ordered` → `2`.
Con `undefined` como warehouse: `0` en las cuatro métricas.
Con `{ InStock: 5 }` (campos faltantes): `committed` → `0`, `ordered` → `0`, `available` → `5`.

### `normalizeB1StockMetric`

`undefined` → `'available'`; `''` → `'available'`; `'InStock'`, `'instock'`, `' inStock '` →
`'inStock'`; `'inStok'` → `null`; `'total'` → `null`.

### `normalizeB1WarehouseFields`

- Entrada sin `metric` → un field con `metric: 'available'`.
- Entrada con `metric: 'InStock'` → un field con `metric: 'inStock'`.
- Entrada con `metric: 'inStok'` → **descartada**, y `onInvalidMetric` llamado una vez con
  `{ propertyName, warehouseCode, metric: 'inStok' }`.
- Sin pasar `onInvalidMetric`, una entrada inválida se descarta y **no** tira.
- Tres entradas con el mismo `valueSAP: 'A01'` y `value` distintos → **tres** fields.
- Dos entradas exactamente iguales (misma bodega, mismo `value`, misma métrica) → **una**.
- Dos entradas con el mismo `value` y métricas distintas → sobreviven las dos a la normalización (la
  clave de dedupe incluye la métrica); es config errónea del cliente y el `reduce` de
  `buildB1WarehouseStockProperties` deja ganar a la última, igual que hoy hace con dos bodegas
  apuntando a la misma propiedad.

### `buildB1WarehouseStockProperties` con el payload real

Fixture: el `ItemWarehouseInfoCollection` real de `P27020056` (18 bodegas; los valores no nulos son
`A02` con `InStock: 1`, `B09` con `InStock: 66`, `B12` con `Ordered: 1400`, y el resto en cero).

- **Perfil AMC**: `b09_instock` → `66`, `b09_committed` → `0`, `b09_ordered` → `0`,
  `b12_ordered` → `1400`, `b12_instock` → `0`, `a02_instock` → `1`.
- **Perfil Printer**: sólo entradas `inStock`; `b09_stock` → `66`, `b12_stock` → `0` (el `Ordered:
  1400` **no** entra), `a01_stock` → `0`.
- **Perfil legacy** (las mismas bodegas sin `metric`): `b09_stock` → `66`, `b12_stock` → `1400`
  (`0 - 0 + 1400`), `a02_stock` → `1`. Este es el caso que fija que Distelsa y Noelito no se mueven.
- Bodega configurada que no existe en el payload → `0`, en cualquier métrica.

### Exclusiones

Con `excludedWarehouses: ['B09']` y las tres entradas de `B09` configuradas: `b09_instock`,
`b09_committed` y `b09_ordered` los tres en `0`, aunque SAP reporte `InStock: 66`.

### `WarehouseStockEnrichmentAdapter` (en `tests/unit/infrastructure/warehouseStockEnrichmentAdapter.test.js`)

- Con dos entradas inválidas en la config → `syncWarningRepository.record` llamado **dos** veces, con
  `code: 'warehouse_metric_invalid'`, `objectType: 'product'`, el `clientConfigId` y el `syncLogId`
  recibidos, y `details` con el `propertyName` y la métrica recibida.
- **Una sola vez por entrada, no una por producto**: con 3 registros y 1 entrada inválida,
  `record` se llama 1 vez.
- Sin `syncWarningRepository` inyectado (el default `null`) → el enrich funciona igual y no tira.
- Si `record` rechaza → el enrich no tira y las propiedades de las entradas válidas se escriben
  igual.
- Config toda válida → `record` no se llama.

### Composición

En `tests/unit/composition/sapSyncComposition.test.js`: afirmar que el
`WarehouseStockEnrichmentAdapter` construido recibe **la clave** `syncWarningRepository` con un
objeto que tiene `record`. Con la clave exacta, no `expect.any(Object)` — el único modo de fallo de
este cambio que no rompe ningún otro test es que esa clave no se cablee.
`tests/unit/composition/propertiesFlagsEnricherWiring.test.js` es el precedente de cómo se afirma
el cableado de un enricher en este repo.

### Regresión: lo que de verdad pasó con los tests existentes

Los dos archivos **se editaron**, con autorización explícita del dueño del proyecto: el retorno de
`normalizeB1WarehouseFields` ganó la clave `metric` en cada field, y `toEqual` compara objetos por
sus claves exactas, así que cualquier assertion preexistente sobre esa forma dejó de matchear en
cuanto la clave nueva apareció.

- `tests/unit/domain/b1ItemWarehouseStrategy.test.js` creció de 141 a 347 líneas: cuatro `toEqual`
  preexistentes recibieron `metric: 'available'`, y el resto de las líneas nuevas son los tests que
  cubren el comportamiento agregado (`normalizeB1StockMetric`, `getWarehouseMetricValue`, los tres
  perfiles de `buildB1WarehouseStockProperties`, etc.), no ediciones sobre assertions viejas.
- `tests/unit/warehouseStock.test.js` cambió **exactamente 4 líneas**: las de las dos assertions que
  afirmaban la forma del field intermedio (`{ warehouseCode, propertyName }` →
  `{ warehouseCode, propertyName, metric: 'available' }`). Los cuatro tests de ese archivo que
  afirman **números** están intactos: `distelsa_stock: 8` + `exhibicion_stock: 2`; `A01_stock: 8` +
  `B10_stock: 2` + `C99_stock: 0`; los `toEqual([])` / `toEqual({})` de la entrada inválida; y
  `getAvailableStockForWarehouse` → `7`. Esa es la prueba de regresión real: ningún número que
  Distelsa o Noelito ya reciben en producción cambió.

Correr jest **desde el checkout principal**, no desde la raíz del proyecto con los worktrees
incluidos, o la suite se infla de ~160 a ~620 suites y aparecen fallos que no son de esta rama.

## Documentación

Agregar a `configuration_examples.md` la entrada de `fieldsWareHouseHS` con el formato del catálogo
(descripción en prosa más ejemplo), cubriendo: las cuatro métricas y su default, que sin `metric` el
comportamiento es el histórico, que una métrica inválida descarta la entrada y deja un `SyncWarning`
con `code: 'warehouse_metric_invalid'`, que la exclusión gana con `0` en cualquier métrica, que
`metric` es exclusivo de B1 (en S/4 el eje es `stockType`), y que las propiedades tienen que existir
en el portal antes del primer sync.
