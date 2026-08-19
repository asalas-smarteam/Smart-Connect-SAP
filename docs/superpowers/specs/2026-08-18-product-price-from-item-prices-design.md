# Precio de producto tomado de `ItemPrices` según la lista de precios configurada

Fecha: 2026-08-18

## Problema

El sync de productos de SAP a HubSpot escribe **siempre `0.0`** en los campos de precio, salvo
que el record llegue marcado. El zeroing es incondicional en
[product.handler.js:106](../../../src/infrastructure/hubspot/handlers/product.handler.js) y solo
lo cortocircuita la guarda de la línea 102:

```js
if (item?.rawSapData?.selectedPrice || item?.rawSapData?.[KEEP_MAPPED_PRICE_FLAG]) {
  return;
}

priceFields.forEach((field) => {
  item.properties[field] = 0.0;
});
```

Hoy hay exactamente dos maneras de poner esa marca:

- `selectedPrice` lo pone la strategy `oneToMany_Product`, que **expande un producto en N
  productos de HubSpot** (uno por lista de precios), en
  [one-to-many-product.strategy.js:249](../../../src/domain/products/strategies/one-to-many-product.strategy.js).
  No sirve: este tenant quiere un producto, no uno por lista.
- `keepMappedPrice` lo pone `oneToOne_Product` cuando `requirePrice.value` es truthy
  ([one-to-one-product.strategy.js:53](../../../src/domain/products/strategies/one-to-one-product.strategy.js)),
  y significa "conservá lo que el FieldMapping ya puso en la propiedad". Tampoco sirve **por sí
  solo**: presupone que el precio viene en un campo de cabecera de la entidad SAP, y el precio de
  este tenant vive dentro del array `ItemPrices` de `/b1s/v2/Items`, en la fila cuyo `PriceList`
  coincide con el default del tenant.

El resolver de mapeos no puede expresar ese filtro. Cuando un path llega a un array toma el
elemento `[0]` a ciegas ([mappingValueResolver.service.js:44](../../../src/application/services/mappingValueResolver.service.js)),
y con `mappingFallback.enabled` activo (`scanCollections`, línea 42) escanea hasta el primer valor
no vacío — o sea, se traería el precio de **cualquier** lista. Un mapeo `ItemPrices.Price` no es
una solución, es una coincidencia posicional.

El tenant afectado es `sap_integration_printer` (Guatemala, SAP B1). Su documento
`productSyncStrategy` **no existe**, así que hoy resuelve al default `oneToOne_Product`
([ProductSyncStrategyConfigRepository.js:15](../../../src/infrastructure/config/ProductSyncStrategyConfigRepository.js))
con `requirePrice` en `undefined` → todos sus productos nacen en `hs_price_gtq = 0`.

## Objetivo

Que la config pueda declarar **de dónde sale el precio de un producto**: del campo de cabecera
mapeado (comportamiento actual) o de la fila de `ItemPrices` que corresponde a la lista de precios
del tenant. Sin tocar el comportamiento de ningún tenant que no declare la opción nueva.

## Restricción dura: hay un tenant productivo usando esta config

Existe otro tenant en producción con este documento:

```json
{
  "key": "productSyncStrategy",
  "value": {
    "strategy": "oneToOne_Product",
    "requirePrice": { "value": false, "field": "" },
    "requireCost": { "flag": true, "field": "hs_cost_of_goods_sold" }
  }
}
```

**Ese documento no se migra y no cambia de significado.** La opción nueva es una llave opcional
anidada; ausente ⇒ la ruta de ejecución es idéntica a la de hoy. Cualquier diseño que exija tocar
ese documento queda descartado.

## Evidencia verificada en el código (2026-08-18)

Todo lo de abajo se confirmó leyendo los archivos, no por inferencia.

**`ItemPrices` ya llega a `rawSapData`; el fetch no se toca.** El `$select` del Service Layer se
arma con los `sourceField` de los mapeos que no tengan `includeInServiceLayerSelect: false`
([serviceLayerUrlBuilder.js:36](../../../src/infrastructure/sap/serviceLayerUrlBuilder.js)) **más**
los campos del env por objectType. En `.env:44`:

```
PRODUCT_ADD_FIELDS_URL_SAP=ItemWarehouseInfoCollection,ItemPrices
```

**Los helpers de dominio para seleccionar la fila ya existen y están testeados.**

| Función | Ruta | Qué hace |
|---|---|---|
| `selectPriceListRow(itemPrices, priceList)` | [price-currency.service.js:3](../../../src/domain/prices/price-currency.service.js) | devuelve la fila con `Number(row.PriceList) === priceList`, o `null` |
| `getPriceForCurrency(row, currency)` | [price-currency.service.js:18](../../../src/domain/prices/price-currency.service.js) | recorre `Price/Currency`, `AdditionalPrice1/2` y devuelve el primer par cuya moneda calza **y** cuyo precio es `> 0` |
| `resolvePriceListFromConfigValue(value, {currency})` | [price-list-config.service.js:9](../../../src/domain/prices/price-list-config.service.js) | lee el mapa `{default, GTQ, ...}`; sin moneda usa `default` |
| `resolveTenantPriceList({tenantModels, currency})` | [TenantLineItemPriceConfigRepository.js:80](../../../src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js) | lee la config `priceList` y valida; **lanza** si falta o es inválida |

**`PRODUCT_SYNC_ON_MISSING_PRICE` está declarado y nadie lo lee.**
[product-sync-strategy.constants.js:14](../../../src/domain/products/product-sync-strategy.constants.js)
define `SET_ZERO` / `SKIP_PRODUCT` / `THROW_ERROR` y `DEFAULT_...ON_MISSING_PRICE = SET_ZERO`, pero
un grep en `src/` y `tests/` no encuentra ni un consumidor. Es código muerto que este trabajo puede
empezar a usar.

**La costura strategy → `preprocess` funciona: el record es el mismo objeto.** La strategy corre en
`sendMappedRecords` ([SyncSapConfigToHubspot.js:419](../../../src/application/use-cases/SyncSapConfigToHubspot.js)),
llama a `hubspotSyncTarget.send({ mappedRecords })`, y ambos caminos de producto pasan cada record
tal cual a `handler.preprocess({ item, ... })`:

- secuencial: [SendMappedItemsToHubspot.js:280](../../../src/application/use-cases/SendMappedItemsToHubspot.js)
- por lotes (`hubspotBatchSize > 1`): [SendMappedItemsToHubspot.js:531](../../../src/application/use-cases/SendMappedItemsToHubspot.js)

Lo que la strategy escriba en `record.rawSapData` lo ve `preprocess`. **Los dos caminos hay que
verificarlos en la prueba manual**, porque solo uno se ejercita según `hubspotBatchSize`.

**`fieldsPricesHS` ya es la fuente de verdad de los campos de precio.** `preprocess` lo lee vía
`buildPreprocessContext` (una vez por corrida, no por item) en
[product.handler.js:48](../../../src/infrastructure/hubspot/handlers/product.handler.js); default
`['hs_price_usd']`. Para este tenant queda `["hs_price_gtq"]`.

**`requirePrice.field` no se lee en ninguna parte.** La strategy solo consume `requirePrice?.value`
([one-to-one-product.strategy.js:53](../../../src/domain/products/strategies/one-to-one-product.strategy.js)).
Es decorativo; se conserva por consistencia con el tenant productivo.

## Diseño

### La config

```json
{
  "key": "productSyncStrategy",
  "value": {
    "strategy": "oneToOne_Product",
    "requirePrice": {
      "value": false,
      "field": "",
      "source": {
        "from": "itemPrices",
        "priceField": "Price",
        "onMissingPrice": "SET_ZERO"
      }
    },
    "requireCost": { "flag": false, "field": "" }
  }
}
```

- **`source` ausente, o `from: "mapped"`** ⇒ ruta de hoy, byte por byte. `requirePrice.value`
  sigue decidiendo conservar-o-cerar. Esto es lo que protege al tenant productivo.
- **`from: "itemPrices"`** ⇒ se resuelve el precio desde `rawSapData.ItemPrices`, tomando la fila
  cuyo `PriceList` es el `default` de la config `priceList` del tenant.
- **`priceField`** (default `"Price"`) permite a otro tenant tomar `AdditionalPrice1` en lugar del
  precio base.
- **`onMissingPrice`** solo se implementa en `SET_ZERO` (ver no-objetivos).

`requirePrice.value` se queda en `false` y **eso es correcto, no una inconsistencia**: las dos
llaves responden preguntas distintas. `value` = "conservá lo que el FieldMapping puso"; `source` =
"resolvé el precio desde acá". Cuando `source.from` es `itemPrices` la resolución gana, porque el
mecanismo con el que se marca el record (`selectedPrice`) ya cortocircuita el zeroing en
[product.handler.js:102](../../../src/infrastructure/hubspot/handlers/product.handler.js) sin
necesidad de `keepMappedPrice`.

Config del tenant que acompaña a esto (ya existe, no se toca):

```json
{ "key": "priceList", "value": { "default": 1, "C$": 1 } }
{ "key": "fieldsPricesHS", "value": ["hs_price_gtq"] }
```

> La llave `C$` (símbolo del córdoba nicaragüense) en un tenant de Guatemala parece copy-paste de
> otro cliente. Es inocua —solo se lee cuando alguien pasa una moneda explícita, y ningún flujo de
> productos lo hace— pero conviene confirmarla con el cliente y borrarla si nadie la puso a propósito.

### Dónde vive la lógica

**El precio se resuelve en `OneToOneProductStrategy`, no en un enricher nuevo.** Razones:

1. `requirePrice` ya es asunto de esa strategy, y ya tiene `strategyConfig` en la mano — un
   enricher obligaría a leer `productSyncStrategy` una segunda vez.
2. La strategy ya hace exactamente este tipo de marcado por record: `markRecordToKeepMappedPrice`
   en [one-to-one-product.strategy.js:6](../../../src/domain/products/strategies/one-to-one-product.strategy.js).
3. Mantiene la política de precio en un solo archivo en vez de partirla entre strategy y adapter.

La strategy recibe por constructor un repositorio de config (mismo patrón con el que ya recibe
`hubspotSyncTarget`) para poder leer `priceList`. El cálculo en sí va en un **servicio de dominio
puro y sin Mongo**, para que sea testeable sin base de datos.

### Flujo resuelto

1. `sendMappedRecords` obtiene `strategyConfig` y despacha a la strategy
   ([SyncSapConfigToHubspot.js:419](../../../src/application/use-cases/SyncSapConfigToHubspot.js)).
   Sin cambios.
2. `OneToOneProductStrategy.execute()` detecta `requirePrice.source.from === 'itemPrices'`. Si no
   lo es, sigue el camino actual y termina.
3. Lee la lista de precios **una vez por corrida** (no por producto).
4. Por cada record: `selectPriceListRow(record.rawSapData.ItemPrices, priceList)` → toma
   `row[priceField]` → normaliza con `normalizeNumber`
   ([string.utils.js:6](../../../src/shared/utils/string.utils.js)).
5. Si hay número válido `> 0`: setea `record.rawSapData.selectedPrice = row` **y**
   `record.rawSapData[RESOLVED_PRODUCT_PRICE_KEY] = precio`.
6. Si no hay fila, o el precio es `0`/`null`: **no** setea nada. El record cae al zeroing existente
   = `SET_ZERO`.
7. `product.handler.preprocess()` gana una rama antes del zeroing: si `rawSapData` tiene la llave
   `RESOLVED_PRODUCT_PRICE_KEY` con un número finito, lo escribe en **todos** los campos de
   `priceFields` y retorna.

El paso 5 setea las dos llaves a propósito: `selectedPrice` porque es la guarda que ya existe y
otros consumidores podrían leerla, y la llave nueva porque `selectedPrice` es la *fila* cruda y
`preprocess` necesita el *número* ya elegido según `priceField` — no puede volver a decidir.

### Por qué `preprocess` escribe y no la strategy

Consistencia con los tres precedentes del repo: `_warehouseStock`, `BATCH_EXPIRY_KEY` y el
descuento resuelto (`_resolvedDiscount`) todos siguen el mismo contrato — **alguien resuelve y
adjunta bajo `rawSapData`; `preprocess` traduce a propiedades de HubSpot**. Ver
[product.handler.js:66-100](../../../src/infrastructure/hubspot/handlers/product.handler.js) y el
comentario del puerto en
[sap-record-enricher.port.js](../../../src/application/ports/sap/sap-record-enricher.port.js)
("Mutates mappedRecords in place (attaching data under rawSapData)"). Además `preprocess` ya es
dueño de `fieldsPricesHS`; si la strategy escribiera en `properties` habría dos lugares leyendo esa
config.

## Alternativas descartadas

**1. Mapeo `ItemPrices.Price → hs_price_gtq` + `requirePrice.value: true`. Cero desarrollo.**
Descartada por frágil. Funciona *de casualidad* con los datos de muestra porque la fila `[0]` de
`ItemPrices` resulta ser `PriceList 1`; el resolver toma `current[0]` sin mirar `PriceList`
([mappingValueResolver.service.js:44](../../../src/application/services/mappingValueResolver.service.js)).
Peor: si el tenant activa `mappingFallback.enabled`, `scanCollections` (línea 42) escanea hasta el
primer valor no vacío, así que un artículo con `PriceList 1` en `0.0` se llevaría el precio de otra
lista sin ningún aviso. Es un bug latente disfrazado de config.

**2. `requirePrice.value: true` + un `source` que reinterpreta ese `true`.**
Descartada porque cambia el significado de `value` para todos. El tenant productivo tiene
`value: false` y `requireCost.flag: true`; cualquier reinterpretación obliga a auditar y migrar su
documento. La llave nueva anidada no toca nada.

**3. Un enricher nuevo (`ProductPriceEnrichmentAdapter`) al lado de los otros cuatro.**
Es la alternativa más defendible y la que descarté por poco. A favor: cuatro precedentes idénticos
y cero dependencias nuevas en la capa de dominio. En contra: leería `productSyncStrategy` una
segunda vez (el use-case ya la lee en `sendMappedRecords`), agregaría un archivo de adapter + una
constante + un cable de composición, y partiría la política de precio entre dos archivos cuando
`requirePrice` ya vive en la strategy. **Si al ejecutar aparece un problema de capas que no vi,
esta es la ruta de respaldo** y no invalida nada del resto del spec: cambia quién setea las llaves,
no las llaves ni la rama de `preprocess`.

**4. Matchear por moneda con `getPriceForCurrency`.**
Descartada para v1. El precio se selecciona **solo por `PriceList`**, decidido explícitamente con
el cliente. Motivo concreto: SAP devuelve `"Currency": "QTZ"` (código del maestro de monedas de
B1), no el ISO `GTQ`, así que un match por moneda contra `hs_price_gtq` nunca calzaría sin un mapa
de traducción. Ese mapa **ya existe** para el flujo de line items —
`lineItemPriceStrategy.currencyCodes` con forma `{ "GTQ": "QTZ", "USD": "USD" }`, usado en
[SyncDealLineItemPricesByPriceList.js:105](../../../src/application/use-cases/SyncDealLineItemPricesByPriceList.js) —
y es la extensión natural el día que un tenant tenga precios multi-moneda en un solo producto.
**No hay que cambiar `QTZ` en SAP**: es el código del maestro de monedas de B1 y tocarlo afectaría
todos los documentos del ERP.

**5. Escribir también en la propiedad estándar `price` de HubSpot.**
Fuera de alcance por decisión del cliente: solo `hs_price_gtq`. Queda anotado como deuda que el
mapeo `Price → price` de este tenant apunta a un campo de cabecera que **no existe** en `Items` de
B1 y además está en `includeInServiceLayerSelect: false`, así que `price` resuelve `null` en cada
corrida.

## No objetivos

- **`SKIP_PRODUCT` y `THROW_ERROR` no se implementan.** Solo `SET_ZERO`. Saltarse un producto exige
  filtrar records antes del envío, y hoy ni el use-case ni la strategy tienen ese paso; abortar la
  corrida exige decidir el efecto sobre el `SyncLog`. La llave `onMissingPrice` se acepta y se
  **valida** contra `PRODUCT_SYNC_ON_MISSING_PRICE` para que la forma del config quede estable, y
  cualquier valor distinto de `SET_ZERO` cae a `SET_ZERO` con un `warn`. Se implementan cuando un
  tenant los pida.
- No se toca `oneToMany_Product`.
- No se toca el `$select` ni el `.env`.
- No se toca el costo (`requireCost`) — este tenant va en `{ flag: false, field: "" }`.
- No se implementa selección por moneda (ver alternativa 4).

## Archivos

| Archivo | Cambio |
|---|---|
| `src/domain/products/product-price-source.service.js` | **nuevo.** Servicio puro: normaliza `requirePrice.source` (`from`, `priceField`, `onMissingPrice` validado contra las constantes) y resuelve `{ row, price }` desde `ItemPrices` + `priceList` usando `selectPriceListRow`. Sin Mongo, sin logger obligatorio. |
| [product-sync-strategy.constants.js](../../../src/domain/products/product-sync-strategy.constants.js) | agregar `PRODUCT_PRICE_SOURCES` (`MAPPED` / `ITEM_PRICES`), `DEFAULT_PRODUCT_PRICE_SOURCE = MAPPED` y `RESOLVED_PRODUCT_PRICE_KEY`. No tocar lo existente. |
| [one-to-one-product.strategy.js](../../../src/domain/products/strategies/one-to-one-product.strategy.js) | constructor gana `priceListConfigRepository = null`. En `execute`, antes del `map` de la línea 56: si la fuente es `itemPrices`, resolver la lista **una vez** y anotar cada record. Log `info` por corrida con la lista usada y cuántos productos quedaron sin precio. |
| [product.handler.js](../../../src/infrastructure/hubspot/handlers/product.handler.js) | en `preprocess`, antes del zeroing de la línea 106: si `rawSapData` tiene `RESOLVED_PRODUCT_PRICE_KEY` con número finito, asignarlo a cada `priceFields` y `return`. |
| [sap-sync.composition.js](../../../src/composition/sap-sync.composition.js) | inyectar `priceListConfigRepository: new TenantLineItemPriceConfigRepository()` en el `new OneToOneProductStrategy({...})` de la línea 68. **Verificar con grep que la llave quedó escrita ahí**, no confiar en que los tests pasen. |

Un solo punto de wiring: todo pasa por `buildSyncSapConfigToHubspot()`
([sap-sync.composition.js:45](../../../src/composition/sap-sync.composition.js)), que es lo que
consumen tanto el job de BullMQ (`interfaces/jobs/sap-sync.job.js`) como el controller de
`POST /sap-sync/run` (`interfaces/http/controllers/sapSync.controller.js` vía `buildSapSyncAdmin`).
No hay una segunda composición que construya este use-case.

## Manejo de errores

`resolveTenantPriceList` **lanza** cuando falta la config `priceList` o su formato es inválido
([TenantLineItemPriceConfigRepository.js:80](../../../src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js)).
En el sync de productos eso no puede tumbar la corrida: hay que capturarlo, dejar un `error` en el
log y seguir con el camino actual (precios en `0`). Si no se captura, el `try/catch` de la strategy
lo convierte en `failed: totalProducts` y **el tenant pierde también nombre y stock**, no solo el
precio. Es el mismo criterio de los enrichers: "a broken config must not abort the product sync"
([WarehouseStockEnrichmentAdapter.js:89-93](../../../src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js)).

Ojo con `tenantConfigurationService.getValue`: en la ruta de miss hace un `findOneAndUpdate` con
`upsert: true` ([tenantConfiguration.service.js:32](../../../src/infrastructure/config/tenantConfiguration.service.js)),
o sea **crea el documento** con el default. Para `priceList` no aplica porque el tenant ya lo tiene,
pero no hay que agregar lecturas de config nuevas por esa vía sin pensarlo.

## Tests

TDD: cada test rojo antes de su implementación.

**Dominio — `tests/unit/domain/productPriceSource.test.js` (nuevo)**
- `from: 'itemPrices'` con `priceList: 1` sobre el payload real → `36.607143`.
- `PriceList` configurada existe pero su `Price` es `0.0` → `null` (no `0`, para distinguir "sin
  precio" de "precio cero").
- no existe fila para la `PriceList` configurada → `null`.
- `ItemPrices` ausente / `[]` / no-array → `null`, sin lanzar.
- `priceField: 'AdditionalPrice1'` toma la columna alterna.
- `source` ausente y `from: 'mapped'` → la fuente normalizada es `mapped`.
- `onMissingPrice` con un valor no soportado → cae a `SET_ZERO`.
- `PriceList` como string `"1"` calza (SAP y Mongo mezclan tipos; `selectPriceListRow` normaliza).

**Strategy — extender [productSyncStrategy.test.js](../../../tests/unit/domain/productSyncStrategy.test.js)**
- con `source.from: 'itemPrices'`, cada record sale con `selectedPrice` y con la llave del precio
  resuelto.
- **regresión del tenant productivo**: `{ requirePrice: {value:false, field:''}, requireCost:
  {flag:true, field:'hs_cost_of_goods_sold'} }` sin `source` produce **exactamente** los mismos
  records que hoy — sin `selectedPrice`, sin la llave nueva, y con el campo de costo eliminado.
- el repositorio de `priceList` se consulta **una sola vez** para N productos.
- si `resolveTenantPriceList` lanza, la strategy sigue y manda los records (no `failed`).
- sin `priceListConfigRepository` inyectado y `from: 'itemPrices'` → no revienta, cae a la ruta
  actual con un `warn`.

**Handler — extender [product.handler.test.js](../../../tests/unit/product.handler.test.js)**
- con la llave del precio resuelto, `hs_price_gtq` queda en `36.607143` y **no** en `0`.
- con varios campos en `fieldsPricesHS`, todos reciben el mismo número.
- llave ausente → sigue poniendo `0.0` (regresión del comportamiento actual).
- llave presente con `null` / `NaN` → `0.0` (es la ruta `SET_ZERO`).
- la rama nueva no interfiere con `_warehouseStock`, `BATCH_EXPIRY_KEY` ni `_resolvedDiscount`.

**Comando** (desde la raíz, con el flag que exige el proyecto):

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees --testPathPatterns="productPriceSource|productSyncStrategy|product\.handler"
```

Ese comando está verificado: corre 3 suites del checkout principal. Dos trampas por las que pasé al
armarlo, para no repetirlas:

- **Pasar las rutas como argumentos posicionales no acota nada.** Jest las trata como regex contra
  la ruta absoluta, así que `tests/unit/product.handler.test.js` también hace match en
  `.claude/worktrees/*/tests/unit/product.handler.test.js`: el comando levanta 8 suites en vez de 2,
  y un fallo de un worktree se lee como fallo de este cambio. De ahí
  `--testPathIgnorePatterns=worktrees`.
- **`--testPathIgnorePatterns=worktrees` seguido de rutas posicionales se traga las rutas** y corre
  la suite completa (164 suites). Hay que usar `--testPathPatterns` con `=`, no posicionales.
  Y es `--testPathPatterns` en plural: `--testPathPattern` está deprecado y aborta con error de
  validación en la versión de jest del proyecto.

**Baseline de la suite antes de empezar (medido el 2026-08-18 sobre el working tree actual, que
tiene cambios sin commitear de trabajo anterior):** `6 failed, 160 passed, 166 total` — 12 tests
rojos. Las suites ya rojas son:

```
tests/integration/internalTenant.test.js
tests/unit/application/sendMappedItemsToHubspot.test.js
tests/unit/application/syncLineItemPrices.test.js
tests/unit/lineItemPriceWebhook.service.test.js
tests/unit/serviceLayerFlow.test.js
tests/unit/serviceLayerService.test.js
```

Dos de ellas —`sendMappedItemsToHubspot` y `serviceLayerFlow`— tocan archivos vecinos a este
trabajo, así que **conviene volver a medir el baseline antes del primer commit** y no atribuirle a
este cambio nada que ya estuviera rojo. Al terminar, esas seis deben seguir exactamente igual: ni
una más, ni un test rojo más.

## Prueba manual

`POST /sap-sync/run` con **solo** la config de productos de `sap_integration_printer` activa.

1. Insertar los cuatro documentos de config (`productSyncStrategy`, `fieldsPricesHS`,
   `fieldsWareHouseHS`, `excludedWarehouses`) y los seis FieldMappings nuevos.
2. Verificar en HubSpot que `hs_price_gtq` trae el precio de la lista 1 y no `0`.
3. Repetir con `hubspotBatchSize` en `1` y en `> 1`: son las dos rutas de `preprocess`
   ([SendMappedItemsToHubspot.js:280](../../../src/application/use-cases/SendMappedItemsToHubspot.js)
   y [:531](../../../src/application/use-cases/SendMappedItemsToHubspot.js)) y el spec toca la
   función que ambas llaman.
4. Buscar en `logs/app.log` la línea de la strategy con la lista usada y el conteo de productos sin
   precio; comparar contra un artículo que en SAP tenga `PriceList 1` en `0.0`.
5. Confirmar que un producto sin fila para la lista 1 queda en `0` y **no** rompe el lote de 100.

## Riesgos

- **El tenant productivo.** Mitigado por el test de regresión explícito y por el diseño
  (`source` ausente ⇒ misma ruta). Es la verificación que no se puede omitir.
- **Wiring silencioso.** Un parámetro de constructor puede quedar sin cablear en la composición y
  aun así tener toda la suite verde, porque los tests inyectan el doble a mano. Verificar con grep
  la llave literal en `sap-sync.composition.js`.
- **`hs_price_gtq` tiene que existir en el portal de HubSpot** antes de la primera corrida. Con
  `hubspotBatchSize > 1`, una propiedad inexistente hace fallar el lote de 100 completo, no el
  producto suelto.
- **Precisión decimal.** `36.6071430` llega con siete decimales. HubSpot los acepta, pero conviene
  confirmar con el cliente si esperan redondeo a dos; si sí, es un cambio en el servicio de dominio
  y un test más, no un rediseño.
