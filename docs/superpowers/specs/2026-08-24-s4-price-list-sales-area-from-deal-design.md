# Área de ventas y lista de precios tomadas del negocio (S/4)

Fecha: 2026-08-24
Aplica sólo a: SAP S/4HANA. El flujo de Business One no se toca.
Tenant que lo motiva: `sap_integration_multiquimica`
Reemplaza la decisión de área de: `2026-08-18-s4-price-list-line-item-webhook-design.md`

## El problema

Hoy el webhook de precios de S/4 decide el área de ventas a partir de las áreas que el **cliente**
tiene en SAP, y la config del tenant sólo desempata cuando hay más de una
(`SyncS4LineItemPricesByPriceList.js:91`, `chooseSalesAreaRow`):

- una sola área → se usa esa y la config no interviene
- varias áreas → tiene que coincidir con `s4PriceList.salesArea`, si no falla
- ninguna área → cae al `s4PriceList.salesArea` de la config (agregado el 2026-08-24)

Eso no alcanza, y los datos del S/4 de Multiquímica explican por qué. Verificado en vivo el
2026-08-24 contra `A_CustomerSalesArea` (8974 filas, división `SC` en todas):

| Hecho verificado | Número |
|---|---|
| Clientes con **más de un** área de ventas | 492 de 1209 en la muestra |
| Clientes con **listas distintas** entre sus áreas | 259 |
| Clientes con más de una fila en el **mismo** org/canal | **0** |
| Valores distintos de `Division` en las 16 combinaciones org/canal | **1** (siempre `SC`) |

O sea: `Customer + SalesOrganization + DistributionChannel` identifica **una sola** fila, y por lo
tanto una sola `PriceListType`. Lo que falta no es más lógica de desempate: es que alguien diga en
qué organización de ventas se está cotizando. Eso lo sabe el asesor, no SAP.

Caso de referencia (BP `100061`, CARY INDUSTRIAL, SA):

```
CPDO/01/SC → ZD    DPDO/01/SC → ZC    GPDO/01/SC → ZD
MQDO/01/SC → ZD    TMDO/01/SC → ZC
```

Y la lista cambia el precio: material `10000453` en DPDO/01 vale **1.95 USD/KG** en ZC
(registro `0000111922`) y **2.05 USD/KG** en ZD (registro `0000111924`), las dos vigentes hoy.

## Lo que se cambia

El negocio de HubSpot pasa a declarar el área de ventas. El webhook la lee del deal y con eso
consulta **una sola fila** de `A_CustomerSalesArea`.

### Propiedades nuevas en el negocio (las crea el cliente en su portal)

| Label | Key en HubSpot | Campo de SAP |
|---|---|---|
| Organización | `sales_organization` | `SalesOrganization` |
| Canal de distribución | `distribution_channel` | `DistributionChannel` |

Son obligatorias al crear el negocio. La moneda **no** se agrega: se usa la nativa
`deal_currency_code`.

`Division` no se pide. Es `SC` en las 8974 filas del sistema y no entra al `$filter` de las
condiciones (`S4PriceListClient.js:74`, `buildValidityFilter`), así que pedirla sería un campo
obligatorio más sin ningún efecto. Si algún día aparece una segunda división, el código lo detecta:
ver "Más de una fila" abajo.

### El flujo nuevo

1. `preparePayload` lee el deal, que hoy ya se trae completo
   (`s4PriceListLineItemPriceWebhook.service.js:206`). Se le agregan las tres propiedades al
   `properties` del GET: `sales_organization`, `distribution_channel`, `deal_currency_code`.
2. Las tres viajan en el payload que se le pasa al caso de uso
   (`s4PriceListLineItemPriceWebhook.service.js:234`), junto a `dealId`, `customer` y `lineItems`.
3. El caso de uso filtra las áreas del cliente por org+canal en vez de desempatar por config.
4. La `PriceListType` de esa fila es la lista del cliente. Todo lo de abajo (resolución 502 →
   default → 501/504) queda igual.

### La consulta a SAP se hace más específica

`fetchCustomerSalesAreas` (`S4PriceListClient.js:134`) hoy filtra sólo por `Customer`. Pasa a
aceptar org y canal y filtrarlos en SAP:

```
$filter=Customer eq '100061' and SalesOrganization eq 'CPDO' and DistributionChannel eq '01'
```

Con eso la respuesta trae 0 o 1 fila y el desempate desaparece del código. **No** se filtra por
`Division` ni por `Currency`: la división no discrimina, y la moneda es un atributo de la fila
(DPDO/01 tiene 640 clientes en USD y 1505 en DOP — filtrar por la moneda del negocio descartaría
filas válidas).

### Los tres casos, y qué hace cada uno

| Caso | Qué hace |
|---|---|
| **1 fila** | Usa su `PriceListType`. Si viene vacía (72 clientes en DPDO/01 la tienen vacía), cae al default de esa org/canal. |
| **0 filas** — el cliente no está en esa área, o no existe en SAP | Error: nota en el negocio y precios en 0. Ver abajo. |
| **Más de 1 fila** | Error explícito pidiendo la división. No debería pasar (hoy es imposible), pero si SAP cambia hay que enterarse, no elegir al azar. |

### Caso 0 filas: nota en el negocio y precios en 0

Decisión del cliente (2026-08-24): cuando el cliente no está registrado en el área que dice el
negocio — o no existe en SAP — **no se cotiza con el default**. Se escribe `price: 0` en todas las
líneas del negocio, `amount: 0` en el negocio, y la nota explica por qué.

> **Precios de SAP: el cliente no está registrado en esta área de ventas**
> Cliente SAP: 100061 · Organización: MQGT · Canal: 01
> Las áreas de ventas que este cliente tiene en SAP son: CPDO/01, DPDO/01, GPDO/01, MQDO/01, TMDO/01.
> Los precios de las líneas se pusieron en 0. Corregí la organización de ventas del negocio, o pedí
> que se registre el cliente en esta área en SAP.

Esto **sobrescribe** precios que puedan estar bien de una corrida anterior. Es a propósito: un 0 es
obviamente inválido y frena la cotización, mientras un precio viejo al lado de un área equivocada se
cotiza sin que nadie lo note. La nota lleva la lista de áreas reales del cliente porque es lo único
que le dice al asesor qué poner — y para armarla hace falta una segunda consulta, sin el filtro de
org/canal, que sólo se hace en este camino de error.

En la práctica sobrescribe poco: la propiedad que se toca es la **nativa `price` del line item**
(`HubspotLineItemPriceClient.js:60`), y el único que la escribe es este webhook. El sync de productos
escribe en los campos de `fieldsPricesHS` — para este tenant `["hs_price_usd"]`, que es también el
default de `product.handler.js:16` — y **nunca** toca la `price` nativa del producto. Como HubSpot
siembra el `price` de una línea nueva desde la `price` nativa del producto, las líneas nacen en 0.
El único caso donde el 0 pisa algo válido es cuando una corrida anterior de este mismo webhook ya
había escrito un precio y después cambió la organización del negocio, que es exactamente cuando se
quiere el 0.

`fieldsPricesHS` **no** participa de este flujo: el webhook escribe `price` sin leer esa config. Si
en algún momento se quiere que también escriba `hs_price_usd` en la línea, es un cambio aparte — hoy
esa propiedad existe en productos, no en line items.

Ojo con el orden: los 0 se escriben **antes** de lanzar el error, por el mismo camino que las
escrituras normales (`updateLineItems` + `updateDealAmount`), para que queden en el audit del evento.

### Caso campos vacíos: error, sin fallback

Decisión del cliente: todos los negocios se crean desde la plataforma, así que los campos van a
estar siempre. Los negocios viejos van a dar error y la nota le dice al asesor que los complete.

Por lo tanto **`s4PriceList.salesArea` se elimina de la config** y el fallback
`SALES_AREA_SOURCES.configuredDefault` que se agregó el 2026-08-24
(`SyncS4LineItemPricesByPriceList.js:19` y `:91`) se retira: ya no queda ningún camino que use un
área de config.

> **Precios de SAP: falta la organización de ventas**
> Este negocio no tiene Organización o Canal de distribución. Completá los dos campos y volvé a
> guardar una línea para recalcular los precios.

En este caso los precios **no** se tocan: sin área no se consultó nada en SAP, así que no hay nada
que afirmar sobre las líneas. Es la diferencia con el caso de 0 filas, donde sí se sabe que el área
declarada es incorrecta.

### El default de lista pasa a ser por org/canal

Verificado el 2026-08-24: la lista mayoritaria **cambia** según la combinación, así que un default
global es incorrecto en 11 de las 16 combinaciones.

| org/canal | Clientes | Lista mayoritaria | ZPR0 vigentes hoy |
|---|---|---|---|
| DPDO/01 | 2145 | ZC (910) | 397 |
| DPDO/02 | 214 | ZD (62) | 2 |
| CPDO/01 | 214 | ZD (155) | **0** |
| CPDO/02 | 72 | ZD (35) | **0** |
| GPDO/01 | 1370 | ZC (647) | 409 |
| GPDO/02 | 44 | ZA (17) | **0** |
| MQDO/01 | 118 | ZD (65) | 4 |
| MQDO/02 | 167 | ZD (53) | 1 |
| TMDO/01 | 1087 | ZC (482) | 96 |
| TMDO/02 | 18 | ZB (6) | **0** |
| MQGT/01 | 497 | ZC (193) | 4531 |
| MQGT/02 | 145 | ZA (39) | 4082 |
| HFDO/01 | 39 | ZD (15) | **0** |
| MPDO/01 | 41 | ZA (13) | **0** |
| MKDO/01 | 1946 | ZD (1274) | 1786 |
| MKDO/02 | 5 | ZD (3) | **0** |

La config `s4PriceList` (`TenantLineItemPriceConfigRepository.js:100`, `resolveS4PriceListConfig`)
queda así:

```json
{
  "conditionType": "ZPR0",
  "defaultPriceListType": "ZC",
  "defaultPriceListBySalesArea": {
    "DPDO/01": "ZC", "DPDO/02": "ZD",
    "CPDO/01": "ZD", "CPDO/02": "ZD",
    "GPDO/01": "ZC", "GPDO/02": "ZA",
    "MQDO/01": "ZD", "MQDO/02": "ZD",
    "TMDO/01": "ZC", "TMDO/02": "ZB",
    "MQGT/01": "ZC", "MQGT/02": "ZA",
    "HFDO/01": "ZD", "MPDO/01": "ZA",
    "MKDO/01": "ZD", "MKDO/02": "ZD"
  },
  "priceListProperty": null,
  "currencyProperty": null,
  "priceSourceProperty": null
}
```

- La clave es `"ORG/CANAL"` en mayúsculas, con el canal tal como viene de SAP (`"01"`, no `1`). El
  normalizador tiene que aceptar minúsculas y espacios y normalizarlos, porque esto lo escribe una
  persona a mano en Mongo.
- `defaultPriceListType` sigue siendo obligatorio y es el último recurso cuando el mapa no tiene la
  combinación. Sin él la config es inválida, igual que hoy.
- `salesArea` deja de leerse. Si queda en la config no molesta, pero el normalizador la ignora.

Esta tabla son los valores **mayoritarios de hoy**, calculados de los datos, no una decisión del
negocio. Se cargan así **para que el desarrollo y las pruebas funcionen**, y el cliente los confirma
o los cambia después (decidido el 2026-08-24). Cambiarlos es editar la Configuration, no tocar
código. El impacto es acotado: el default sólo se usa para clientes cuya `PriceListType` viene
vacía, y son 391 en todo el sistema.

### La moneda del negocio: desempate y guardia

Los datos (verificados el 2026-08-24) contradicen el supuesto de que la moneda no puede diferir:

| org/canal | Condiciones vigentes | Monedas | Combinaciones material+lista con **dos** monedas |
|---|---|---|---|
| DPDO/01 | 397 | USD 200, DOP 136 | **0** |
| MQGT/01 | 4531 | USD 4530, GTQ 1 | **0** |
| MKDO/01 | 1786 | DOP 958, USD 828 | **97** (todas en defaults de producto, tablas 501/504) |

Dos conclusiones distintas:

1. **No se puede "buscar el precio en la moneda del negocio".** La entidad de vigencia
   (`A_SlsPrcgCndnRecdValidity`) no lleva moneda — la moneda vive en el registro de condición, que se
   trae después — y en DPDO/01 y MQGT/01 cada material+lista tiene exactamente una. Un negocio en USD
   sobre un material tarifado sólo en DOP no tiene alternativa que buscar: hay una condición y está
   en DOP.
2. **Donde hay varias, hoy se elige al azar.** Las 97 combinaciones de MKDO/01 tienen default de
   producto en USD y en DOP; `pickProductDefault` (`s4-price-resolution.service.js:46`) recorre las
   tablas 501 y 504 en orden explícito, pero dentro de una tabla toma el primer `find`, así que gana
   el que Gateway devuelva primero.

Por eso `resolveS4PriceForMaterial` (`s4-price-resolution.service.js:72`) recibe un `dealCurrency`
nuevo y lo usa en dos lugares:

- **Desempate:** entre candidatos que empatan en origen y tabla, gana el que tenga
  `conditionCurrency === dealCurrency`. Si ninguno la tiene, gana el primero **después de ordenar por
  `conditionRecord`** — para que el resultado sea reproducible aunque no coincida ninguna moneda.
- **Guardia:** si el candidato elegido tiene una moneda distinta a la del negocio, la línea **se
  saltea** con motivo `condition currency USD does not match the deal currency DOP` y aparece en la
  nota. No se escribe un número en una moneda que HubSpot va a mostrar como otra: el campo `price`
  del line item no lleva moneda propia, la hereda del negocio.

`dealCurrency` ausente (negocio sin `deal_currency_code`) desactiva las dos cosas y deja el
comportamiento de hoy: se escribe la condición tal cual. Es la única forma de no romper un negocio
por un campo que HubSpot puebla solo.

## Lo que NO se cambia

- La resolución 502 → default → 501/504 y el orden de las tablas de producto.
- El cálculo `rate / conditionQuantity`, el redondeo a 2 decimales y el no convertir unidades.
- El `amount` del negocio no se toca cuando hay monedas mezcladas entre líneas.
- El debounce, el índice de duplicados y la reclamación de intentos fallidos.
- El flujo de B1 (`lineItemPriceWebhook.service.js` y su caso de uso) — ni una línea.
- Las notas: se reusa `buildLineItemPriceNoteBody` (`lineItemPriceNote.service.js:75`) y
  `buildNotifyLineItemPriceOutcome`, agregando los motivos nuevos.

## Alternativas descartadas

**Poner la lista de precios en una propiedad de la empresa vía FieldMapping.** Se probó punta a punta
el 2026-08-24 y funciona: `sourceField: "to_Customer.to_CustomerSalesArea.PriceListType"` se
convierte en `$expand=to_Customer/to_CustomerSalesArea` (probado, 200; `to_CustomerSalesArea` directo
desde el BP da 404) y `resolveValueByPath` sabe recorrer la colección; con
`mappingCollectionPriority` se puede forzar qué área gana. Se descarta porque resuelve el problema
equivocado: la propiedad de la empresa es **una sola** y el cliente cotiza en varias organizaciones,
así que un cliente con ZD en CPDO y ZC en DPDO mostraría una y cobraría la otra. La decisión es del
negocio, no del cliente. Puede agregarse después como dato informativo, pero no puede ser la fuente.

**Pedir también `Division` en el negocio.** Es `SC` en las 8974 filas y no entra al filtro de
condiciones. Sería un campo obligatorio más, con cero efecto y un lugar más donde equivocarse.

**Filtrar `A_CustomerSalesArea` por `Currency`.** No es parte de la clave y es heterogéneo dentro de
un mismo org/canal (DPDO/01: 640 USD, 1505 DOP). Filtrar por la moneda del negocio descartaría la
fila correcta del cliente.

**Dejar `s4PriceList.salesArea` como fallback cuando los campos del deal vengan vacíos.** Descartada
por decisión del cliente: todos los negocios se crean desde la plataforma con los campos
obligatorios, y un fallback silencioso volvería a cotizar en un área que nadie eligió.

**Cotizar con el default cuando el cliente no está en el área del negocio.** Descartada por decisión
del cliente: prefiere precios en 0 y una nota, porque cotizar a un cliente en una organización donde
no está registrado es un problema comercial, no un hueco de datos.

## Riesgos y cosas que hay que avisarle al cliente

1. **Siete combinaciones org/canal no tienen ninguna condición ZPR0 vigente**: CPDO/01, CPDO/02,
   GPDO/02, TMDO/02, HFDO/01, MPDO/01, MKDO/02. Son 638 clientes. Todo negocio en esas combinaciones
   va a saltear el 100% de sus líneas por más que la lista sea correcta. Hay que decidir si esas
   organizaciones se ofrecen en el desplegable del negocio.
2. **`s4PriceList.salesArea` estaba en DPDO/01**, que tiene 2145 clientes pero sólo 397 condiciones
   vigentes, mientras MQGT tiene 8613 entre sus dos canales. Eso explica los dos materiales sin
   precio que aparecieron probando.
3. **Escribir 0 sobrescribe la `price` de la línea.** El riesgo es bajo porque nadie más escribe esa
   propiedad (el sync de productos usa `hs_price_usd`), así que sólo pisa un precio puesto por una
   corrida anterior de este mismo webhook. Igual conviene que el cliente lo sepa antes de que pase
   con un negocio real.
4. Si las propiedades del negocio se hacen desplegables, hay que cargarles las organizaciones y
   canales reales. Ojo con la trampa de las enumeraciones de HubSpot: si el portal guarda el label
   como value y SAP manda el código, el filtro sale vacío y no falla nada.

## Cómo se prueba

- **Unitario**, sobre el caso de uso: 1 fila / 0 filas / más de 1 fila; `PriceListType` vacía →
  default de la combinación; combinación ausente del mapa → `defaultPriceListType`; campos del deal
  vacíos → error con la nota y sin tocar precios; 0 filas → precios en 0 escritos antes del error;
  desempate por moneda con dos candidatos; guardia de moneda salteando la línea.
- **Unitario**, sobre el dominio: `resolveS4PriceForMaterial` con `dealCurrency` y dos defaults de
  producto en monedas distintas — tiene que dar el mismo resultado con el arreglo en cualquier orden.
- **Unitario**, sobre la config: `defaultPriceListBySalesArea` con claves en minúsculas, con canal
  numérico, ausente, y con `defaultPriceListType` faltante.
- **En vivo**, sin escribir: BP `100061` con `CPDO/01` → ZD, con `DPDO/01` → ZC, con `MQGT/01` → 0
  filas. BP `111667` con `MQGT/01` → ZA, con `DPDO/01` → 0 filas.
- **Desde HubSpot**, un negocio real: cliente `111667`, `sales_organization=MQGT`,
  `distribution_channel=01`, moneda USD, material `10000003` → 7.02 USD/KG.
