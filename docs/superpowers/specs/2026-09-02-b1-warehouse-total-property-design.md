# Propiedad total de todas las bodegas (SAP Business One)

Fecha: 2026-09-02
Aplica sólo a: SAP Business One (Service Layer). S/4HANA no se toca.
Antecedente directo: `docs/superpowers/specs/2026-08-20-b1-warehouse-stock-metric-design.md`
(métrica por entrada de `fieldsWareHouseHS`) y
`docs/superpowers/specs/2026-09-01-b1-warehouse-available-formula-design.md` (qué significa
`available`). Este spec **revierte una decisión** del primero.

## El problema

El spec del 2026-08-20 decidió, en su tabla "Lo que NO se cambia, a propósito", que la columna
acumulativa **no la calcula el código**: se resolvía con una propiedad calculada del portal que
sumara las `*_instock`. Esa salida no existe: **HubSpot no permite propiedades calculadas sobre
productos, ni workflows de productos.** El total no se puede resolver del lado del portal, así que
lo tiene que calcular esta integración.

El caso concreto es `sap_integration_printer`: 70 entradas en `fieldsWareHouseHS`, todas
`metric: "inStock"`, y una columna más que sume las 70.

Los tres números ya vienen embebidos en el Item (`ItemWarehouseInfoCollection`), igual que para las
columnas por bodega: no hay ninguna llamada nueva a SAP. Es sólo decidir qué bodegas entran a la
suma.

## Lo que se cambia

### La config: una entrada más, sin clave nueva

El total se declara **dentro de `fieldsWareHouseHS`**, como una entrada más, con `valueSAP: "*"`:

```json
{
  "label": "Total todas las bodegas",
  "value": "total_onhand",
  "valueSAP": "*",
  "metric": "inStock"
}
```

`*` en `valueSAP` significa "esta entrada no es una bodega, es el total de las bodegas declaradas en
esta misma config". Es el mismo comodín que el lado S/4 ya entiende en `stockType` y en el
`StorageLocation` de `valueSAP` (`STOCK_TYPE_ALL`), reusado en otro eje.

Consecuencias de que sea una entrada y no una clave nueva:

- No hay documento nuevo en `Configurations`, ni lectura nueva a Mongo, ni cambio en
  `ensureTenantConfigurations`: ningún tenant existente nace ni se migra con nada.
- La entrada conserva exactamente la forma `{ label, value, valueSAP, metric }`, así que la UI admin
  que edita `fieldsWareHouseHS` no cambia.
- `metric` sigue siendo por entrada, así que el total elige su propio número: `inStock` suma
  existencias crudas, `available` suma aplicando `warehouseAvailableFormula` bodega por bodega y
  después totaliza. Se pueden tener los dos a la vez, con dos entradas `*` y `value` distintos.
- Los tres caminos que ya consumen `fieldsWareHouseHS` lo obtienen sin tocarse: el sync de productos
  (vía `WarehouseStockEnrichmentAdapter` → `strategy.buildProperties`), el fallback B1 de
  `product.handler.js`, y el sync de precios de line items
  (`TenantLineItemPriceConfigRepository.getHubspotWarehouseStockPropertiesForTenant`).

### El total suma las bodegas declaradas, no todo lo que reporte SAP

Decisión del dueño del proyecto. El conjunto que se suma son los `warehouseCode` distintos de las
entradas **que no son el comodín**, menos las de `excludedWarehouses`. O sea, exactamente el mismo
conjunto que produce las columnas.

Por qué así y no "todas las bodegas de `ItemWarehouseInfoCollection`":

- **El total cuadra con la suma de las columnas.** Un vendedor que sume a mano las columnas que ve
  en HubSpot llega al mismo número, y si no llega, hay un bug — es auditable desde el portal. Con el
  otro criterio el total sería siempre mayor sin ninguna forma de explicar la diferencia desde
  HubSpot.
- **Una bodega nueva en SAP no entra sola.** Con el otro criterio, cualquier bodega que alguien cree
  en B1 —una de tránsito, una de prueba— se sumaría al inventario publicado sin que nadie lo
  autorice.
- **`excludedWarehouses` sigue significando lo mismo:** la bodega sale en `0` en su columna y
  tampoco entra al total, así que la exclusión no se puede evadir por el total.

Corolario de la definición: un total **sin ninguna bodega declarada da `0`**, no el inventario
entero. Y una bodega declarada en tres entradas (una por métrica) aporta al total **una sola vez**:
el conjunto es de códigos de bodega, no de entradas.

### El total se redondea a 3 decimales; las columnas no

Es el único número de B1 que se redondea, con el mismo `QUANTITY_DECIMALS` y el mismo `roundQuantity`
que la strategy de S/4. Sumar decenas de cantidades que SAP manda como texto arrastra ruido de punto
flotante (`10.1 + 0.2 + 7 === 17.299999999999997`), y una propiedad que cambia sola en cada corrida
hace ver movido un inventario quieto — y dispara todo lo que HubSpot cuelgue de "propiedad
modificada". Las columnas por bodega **siguen sin redondear**, porque redondearlas movería valores
que ya están en producción; el spec del 2026-08-20 lo rechazó por esa razón y sigue vigente. Un
número nuevo no tiene ese problema.

### Fórmula inválida: el total `available` tampoco se escribe

Misma regla que ya rige las columnas `available` (spec del 2026-09-01): con
`warehouseAvailableFormula` inválida, un total con `metric: "available"` **se omite** —HubSpot
conserva el último valor— y un total con métrica cruda se escribe normalmente. No cae al default:
escribiría un número plausible pero distinto del que el tenant pidió, y en una columna de inventario
eso nadie lo detecta mirando.

## Lo que NO se cambia, a propósito

| Decisión | Por qué |
|---|---|
| **`normalizeB1WarehouseFields` no se toca ni una línea** | `String('*').toUpperCase()` es `'*'`, así que el comodín atraviesa la normalización tal cual y la clave de dedupe (`warehouseCode:metric:propertyName`) ya deja convivir dos totales con métricas distintas. Cero riesgo de regresión en la normalización de las 70 entradas reales |
| **Una entrada total sin `valueSAP` se descarta** | El fallback que deduce la bodega del nombre sólo matchea `^(\w+)_stock$`, así que `total_onhand` sin `valueSAP` se cae — no hay forma de crear un total por accidente al nombrar una propiedad |
| **S/4HANA no se toca** | Su eje equivalente es `stockType`, y nadie pidió el total ahí. Un `valueSAP: "*"` en un tenant S/4 parsea como una planta llamada `*`, que no existe: la propiedad sale en `0`, no revienta |
| **`excludedWarehouses` sigue sin aplicarse en el camino de line items** | Ese camino pasa `exclusions: []` desde antes de esta feature (documentado en el spec del 2026-09-01). El total de ese camino hereda lo mismo: suma las declaradas sin quitar las excluidas. No se corrige acá para no cambiar de paso el comportamiento de las columnas |
| **No hay script que cree la propiedad en HubSpot** | Igual que las columnas: las crea a mano quien hace el onboarding, en **producto y en line item** |

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Una clave de config nueva (`warehouseTotalProperties`)** | Un documento más por tenant, una lectura más a Mongo, un normalizador más, provisioning y catálogo tocados — todo para expresar algo que la entrada de `fieldsWareHouseHS` ya expresa con el mismo vocabulario (`value` + `metric`). Y separaría en dos lugares una config que se lee y se edita junta |
| **`"total": true` o `"allWarehouses": true` en la entrada** | Agrega una forma de entrada nueva que la UI admin tendría que aprender a editar. `valueSAP: "*"` conserva la forma exacta de las otras 70 entradas y reusa un comodín que ya existe en el proyecto |
| **Sumar todas las bodegas de `ItemWarehouseInfoCollection`** | El total deja de cuadrar con las columnas y deja de ser auditable desde HubSpot; una bodega nueva en SAP entra al inventario publicado sin autorización. Ver arriba |
| **Que el total ignore `excludedWarehouses`** | Volvería la exclusión evadible: la bodega sale `0` en su columna pero sigue sumando en el total, o sea que el número excluido se publica igual, sólo escondido |
| **Redondear también las columnas por bodega** | Movería valores que ya están en producción en Distelsa, Noelito y AMC. Ya se rechazó el 2026-08-20 por la misma razón |
| **Resolverlo con una propiedad calculada del portal** | Era la decisión del 2026-08-20 y no es implementable: HubSpot no tiene propiedades calculadas ni workflows sobre productos |

## Cambios en el código

### 1. `src/domain/warehouses/warehouse-stock-strategy.constants.js`

`WAREHOUSE_CODE_ALL`, derivada de `STOCK_TYPE_ALL` (no un literal `'*'` aparte, que podría divergir),
y sumada al `export default`.

### 2. `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js`

Dos helpers privados y una rama en el builder:

- `roundQuantity(value)` — gemelo del de la strategy S/4.
- `collectDeclaredWarehouseCodes(warehouseFields, excludedSet)` — el `Set` de códigos declarados, sin
  el comodín y sin las excluidas.
- En `buildB1WarehouseStockProperties`, una rama para `warehouseCode === WAREHOUSE_CODE_ALL`, ubicada
  **después** de los dos guards que ya existían: así un `*` en `excludedWarehouses` apaga el total
  dejándolo en `0`, y una fórmula inválida omite el total `available` igual que omite las columnas.
  El `Set` se arma una sola vez por llamada y sólo si hay alguna entrada total.

Nada más. `normalizeB1WarehouseFields`, la strategy S/4, el port, el enricher, el repositorio de
config, `warehouseStock.js`, `product.handler.js` y el provisioning quedan intactos.

## Tests

En `tests/unit/domain/b1ItemWarehouseStrategy.test.js`, un `describe` nuevo (13 casos): el comodín es
el mismo `'*'` que S/4; la normalización lo conserva y no lo toma por bodega; una entrada total sin
`valueSAP` se descarta; suma sólo las declaradas (con el payload real de `P27020056`, que trae 18
bodegas y sólo 3 con stock); el total **cuadra con la suma de las columnas emitidas**; una bodega con
tres columnas aporta una vez; una excluida sale `0` y no entra; `available` aplica la fórmula del
tenant; una fórmula inválida omite el total `available` y conserva el crudo; el redondeo a 3
decimales (con el assert de que la suma cruda **no** da el número redondeado); un total sin bodegas
da `0`; `*` en `excludedWarehouses` lo apaga; y el recorrido de punta a punta por la strategy desde
la config cruda.

## Documentación y rollout

- `configuration_examples.md`: el detalle de `fieldsWareHouseHS` describe la entrada `*` y el ejemplo
  la incluye.
- `printer_warehouse_fields.json`: 71 entradas, la última es el total en `total_onhand`.
- **Antes de aplicar la config**, hay que crear `total_onhand` en el portal como propiedad numérica
  **de producto y de line item**. Si falta en producto, `batchCreateProducts` falla el lote de 100
  entero; si falta en line item, el siguiente webhook de precios manda la propiedad dentro de cada
  line item, HubSpot responde 400 y el negocio queda con el precio viejo.
