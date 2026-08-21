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

### Métrica desconocida: se descarta la entrada, con log de error

Una `metric` que no esté en la tabla hace que la entrada se descarte en `normalizeB1WarehouseFields`
y se loguee un error con el nombre de la propiedad y el valor recibido. La propiedad **no se
escribe**.

No cae de vuelta a `available` a propósito. Un typo como `"inStok"` produciría un número plausible
pero equivocado en HubSpot, y un número equivocado en una columna de inventario es peor que una
columna vacía: nadie lo detecta mirando. Es el mismo criterio que ya rige para los FieldMappings del
cliente — el error se hace visible, no se adivina qué quiso decir.

### Sólo B1

`S4PlantStorageLocationStrategy` no lee `metric` y no cambia. Su eje equivalente ya existe y es
`stockType` por field (`s4-plant-storage-location.strategy.js:105`), que decide qué tipos de stock se
suman en esa propiedad. Las dos strategies siguen cumpliendo el mismo
`WarehouseStockStrategyPort` sin que el port cambie.

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
| **No hay migración ni script de creación de propiedades** | Alcance decidido: backend más documentación de config. Las configs y las propiedades del portal las crea quien hace el onboarding de cada tenant |

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Una entrada por bodega con un mapa `metrics: { inStock: 'a01_instock', committed: 'a01_committed' }`** | Reduce la config de AMC de ~54 filas a ~18, pero obliga al normalizador a aceptar dos formas de entrada (`value` plano y mapa) y a la UI admin a tener un control compuesto nuevo. El ahorro es de filas de config, que se escriben una vez; el costo es permanente y está en el código |
| **`metrics: ['inStock','committed','ordered']` a nivel de tenant, con nombres de propiedad derivados por sufijo** | Es la config más corta, pero obliga a que las propiedades del portal se llamen exactamente según la convención, y no deja que una bodega lleve tres métricas y otra sólo una. Printer y AMC no podrían convivir con reglas distintas por bodega |
| **Una strategy nueva, `b1_ItemWarehouseColumns`** | Duplicaría normalización de fields, exclusiones y construcción de propiedades para cambiar una sola línea: qué número sale de cada bodega. Y no cubre a Printer, que quiere columnas separadas pero sólo una de las tres |
| **`metric` como lista sumable (`['inStock','ordered']`)** | Nadie lo pidió. Si algún día hace falta, `available` ya cubre el único combinado que existe hoy |

El campo `metric` por entrada gana porque es el calco del eje que la strategy hermana de S/4 ya
tiene (`stockType` por field): el mismo lugar en la config, la misma granularidad, ninguna strategy
nueva, y cada propiedad de HubSpot declarada con su nombre real en vez de derivada de una convención.

## Cambios en el código

Dos archivos del dominio. Nada más.

### `src/domain/warehouses/warehouse-stock-strategy.constants.js`

Agregar, junto a `STOCK_TYPE_ALL` (línea 26) que es el constante análogo del lado S/4:

```js
// Qué número de una bodega de B1 va a la propiedad de HubSpot. Es el eje
// equivalente a STOCK_TYPE_ALL/stockType del lado S/4: uno por field, no por
// tenant, para que un tenant pueda pedir tres columnas de una bodega y una de otra.
export const B1_STOCK_METRICS = Object.freeze({
  // InStock - Committed + Ordered. El comportamiento historico y el default:
  // ninguna config existente declara metric, y ninguna debe cambiar.
  AVAILABLE: 'available',
  IN_STOCK: 'inStock',
  COMMITTED: 'committed',
  ORDERED: 'ordered',
});

export const DEFAULT_B1_STOCK_METRIC = B1_STOCK_METRICS.AVAILABLE;
```

Y sumar ambos al `export default` del final (línea 33), que lista todas las constantes del módulo.

### `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`

1. `getWarehouseAvailableStock` (línea 35) **no se toca**. Pasa a ser la implementación de la métrica
   `available`, y sigue exportada con el mismo nombre para que `warehouseStock.js:18` y los tests
   actuales no cambien.

2. Nueva `normalizeB1StockMetric(raw)`: `undefined`/`null`/`''` → `DEFAULT_B1_STOCK_METRIC`;
   si no, `trim()` + minúsculas comparado contra los valores de `B1_STOCK_METRICS` en minúsculas,
   devolviendo el valor canónico; cualquier otra cosa → `null`.

3. Nueva `getWarehouseMetricValue(warehouse, metric)`: para `available` delega en
   `getWarehouseAvailableStock`; para las otras tres devuelve `Number(warehouse?.<Campo> ?? 0)`, con
   el mismo `?? 0` que ya usa la fórmula actual, de modo que un `warehouse` `undefined` o un campo
   ausente dan `0`.

4. `resolveWarehouseField` (línea 19) resuelve además la métrica. Si `normalizeB1StockMetric`
   devuelve `null`, la función devuelve `null` y el field se descarta; el log de error se emite en
   `normalizeB1WarehouseFields`, que es donde ya está el bucle sobre las entradas.

   El logger entra como **segundo argumento opcional** de `normalizeB1WarehouseFields(value,
   { logger = console } = {})`, no como parámetro de constructor de `B1ItemWarehouseStrategy`.
   `normalizeFields(rawValue)` sigue llamándola con un solo argumento y cae en el `console` por
   defecto, igual que hace `WarehouseStockConfigRepository:44`. Así no hay parámetro nuevo que
   cablear en `src/composition/sap-sync.composition.js` — y por lo tanto no hay parámetro nuevo que
   pueda quedar sin cablear con los tests en verde. El test espía `console.error`.

5. La clave de dedupe (línea 59) pasa de `` `${warehouseCode}:${propertyName.toLowerCase()}` `` a
   `` `${warehouseCode}:${metric}:${propertyName.toLowerCase()}` ``. Para toda config existente
   `metric` es la constante `available`, así que la clave es equivalente y el comportamiento no se
   mueve; lo que habilita es que la misma bodega aparezca tres veces con métricas distintas.

6. `buildB1WarehouseStockProperties` (línea 117) cambia
   `getWarehouseAvailableStock(warehousesByCode.get(warehouseCode))` por
   `getWarehouseMetricValue(warehousesByCode.get(warehouseCode), field.metric)`. La rama de exclusión
   (línea 112) queda igual: sigue escribiendo `0` antes de mirar la métrica.

### Lo que no se toca

`src/infrastructure/hubspot/warehouseStock.js`, `src/infrastructure/hubspot/handlers/product.handler.js`,
`src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js`,
`src/infrastructure/config/WarehouseStockConfigRepository.js`,
`warehouse-stock-strategy.factory.js` y `warehouse-stock-strategy.port.js`: **cero cambios**. El
contrato de salida sigue siendo un `{ propertyName: number }` plano, que es todo lo que
`product.handler.js:70` sabe leer.

## Config por tenant

La escribe el onboarding, a mano en Mongo. No hay migración.

### `sap_integration_distelsa` y `sap_integration_noelito`

Nada. Su `fieldsWareHouseHS` actual sigue significando lo mismo.

### `sap_integration_printer` — sólo `InStock`

```json
{
  "key": "fieldsWareHouseHS",
  "value": [
    { "label": "Bodega A01", "value": "a01_stock", "valueSAP": "A01", "metric": "inStock" },
    { "label": "Bodega A02", "value": "a02_stock", "valueSAP": "A02", "metric": "inStock" }
  ]
}
```

### `sap_integration_amc` — tres columnas por bodega

Tres entradas por bodega, con el mismo `valueSAP` y `value` distintos:

```json
{
  "key": "fieldsWareHouseHS",
  "value": [
    { "label": "A01 en stock",     "value": "a01_instock",   "valueSAP": "A01", "metric": "inStock" },
    { "label": "A01 comprometido", "value": "a01_committed", "valueSAP": "A01", "metric": "committed" },
    { "label": "A01 solicitado",   "value": "a01_ordered",   "valueSAP": "A01", "metric": "ordered" },
    { "label": "A02 en stock",     "value": "a02_instock",   "valueSAP": "A02", "metric": "inStock" },
    { "label": "A02 comprometido", "value": "a02_committed", "valueSAP": "A02", "metric": "committed" },
    { "label": "A02 solicitado",   "value": "a02_ordered",   "valueSAP": "A02", "metric": "ordered" }
  ]
}
```

Con las 18 bodegas del producto `P27020056` (`A01`, `A02`, `B01`–`B15`, `PA`) son 54 entradas y 54
propiedades numéricas en el portal. **Las 54 tienen que existir en HubSpot antes del primer sync**:
una propiedad inexistente hace fallar el lote de 100 completo en `batchCreateProducts`.

La cuarta columna acumulativa de AMC es una propiedad calculada del portal que suma las 18
`*_instock`. No sale de este código.

## Tests

TDD: cada test rojo antes de la implementación que lo pone verde.

### `getWarehouseMetricValue` (nuevo, en `tests/unit/domain/b1ItemWarehouseStrategy.test.js`)

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
- Entrada con `metric: 'inStok'` → **descartada**, y `logger.error` llamado con el `propertyName` y
  el valor recibido.
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

### Regresión: los tests actuales pasan sin modificarse

`tests/unit/domain/b1ItemWarehouseStrategy.test.js` (141 líneas) y `tests/unit/warehouseStock.test.js`
tienen que pasar **sin editar una sola línea**. Es la prueba de que ninguna config existente cambia
de significado.

Correr jest **desde el checkout principal**, no desde la raíz del proyecto con los worktrees
incluidos, o la suite se infla de ~160 a ~620 suites y aparecen fallos que no son de esta rama.

## Documentación

Agregar a `configuration_examples.md` la entrada de `fieldsWareHouseHS` con el formato del catálogo
(descripción en prosa más ejemplo), cubriendo: las cuatro métricas y su default, que sin `metric` el
comportamiento es el histórico, que una métrica inválida descarta la entrada, que la exclusión gana
con `0` en cualquier métrica, que `metric` es exclusivo de B1 (en S/4 el eje es `stockType`), y que
las propiedades tienen que existir en el portal antes del primer sync.
