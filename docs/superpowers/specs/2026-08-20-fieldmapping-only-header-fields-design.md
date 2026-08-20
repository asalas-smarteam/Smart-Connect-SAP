# La cabecera de SAP sale sólo del FieldMapping, en todos los flujos

Fecha: 2026-08-20
Continúa: `docs/superpowers/specs/2026-08-19-comments-numatcard-invoice-lineage-design.md`

## La regla

Palabras del dueño del proyecto, y es la regla completa:

> Si no viene en el payload de HS y no está en el FieldMapping, no se toma. Así para todos,
> incluyendo inventory transfer.
>
> El foco siempre es el FieldMapping. Si por error algún campo no viaja en el payload de HubSpot,
> entonces es un error que se debe corregir desde HubSpot.

La rama anterior aplicó esto a `Comments` y `NumAtCard` en dos de los tres flujos de documento.
Este spec cierra lo que quedó afuera.

## Estado medido, no supuesto

Medido en el Mongo y en los `WebhookEvents` de producción el 2026-08-20.

### Inventory transfer ya cumple la regla. No se toca.

`inventory-transfer-request-builder.service.js:9-15` tiene la regla escrita como regla de diseño y
la implementa:

> every field on the SAP payload comes from a FieldMapping. Nothing is hardcoded, nothing gets a
> code-side default, and no HubSpot property is read directly.

Con dos excepciones que **no pueden** ir por FieldMapping porque no vienen de una propiedad de
HubSpot: `CardCode` (lo resuelve la búsqueda/creación del socio de negocio) y `SalesPersonCode` (sale
de la colección `OwnerMapping`). Ese builder es el modelo que los otros dos deben alcanzar, no algo
a corregir. Sólo Printer usa ese flujo, y sus mapeos ya están.

### Lo que viola la regla

| Sitio | Violación |
|---|---|
| `ProcessHubspotWebhookEvent.js:312-316` | Cinco propiedades de HubSpot leídas por **nombre fijo en el código** |
| `buildOrderPayload` (`order-builder.service.js:355-402`) | Cinco parámetros que se aplican después del derrame y le ganan al mapeo |
| `buildQuotationPayload` (`order-builder.service.js:405`) | El parámetro `comments`, misma clase de override |
| `ProcessHubspotUpdateQuotation.js:104-108` | Lee `deal?.comments` literal, y **nunca llama a `mapHubspotToSapFields`**: ningún campo mapeado llega al PATCH |

Las cinco propiedades hardcodeadas son de **Noelito**, y estaban vivas:

| campo SAP | propiedad de HubSpot | presencia en sus eventos | ejemplo |
|---|---|---|---|
| `Comments` | `comments` | 13/30 | `llevar el dia de mañana` |
| `U_ACO_Telefono` | `numero_de_contacto_primario` | 29/30 | `+50583635946` |
| `U_ACO_Telefono2` | `numero_de_contacto_secundario` | 29/30 | el **texto** `"null"` |
| `Address` | `direccion_de_facturacion` | 29/30 | el **texto** `"null"` |
| `Address2` | `direccion_de_entrega` | 29/30 | `Jalapa contiguo al mercado` |

Noelito usa `createDeal` (102 eventos) y sus únicos mapeos en `deal`/`orders-quotations` eran
`PaymentGroupCode` y `CardName`. O sea que esas cinco líneas de código eran lo único que llevaba su
teléfono y su dirección de entrega a SAP. Borrarlas sin crear los mapeos primero le habría borrado
esos datos sin ningún error visible.

Printer no corría riesgo: mapea `Address <- address` y su payload trae `address`, no
`direccion_de_facturacion`, así que el parámetro hardcodeado le quedaba vacío y el `if (resolved)`
dejaba sobrevivir su mapeo. Funcionaba por casualidad, no por diseño.

### Prerrequisito, ya hecho

Las cinco filas de Noelito se cargaron en producción el 2026-08-20 y se verificaron contra la base:
7 filas en `deal`/`orders-quotations`, `ObjectId` bien tipados, `isActive: true`, y el filtro del
runtime (`activeOnly`) las lee todas.

Insertarlas por sí solo no cambió nada: los cinco campos llegan dos veces al payload —una por el
derrame y otra por el parámetro— y el parámetro gana con el mismo valor. Por eso el orden importaba:
**primero las filas, después el código.**

### El bug del texto `"null"`

`numero_de_contacto_secundario` y `direccion_de_facturacion` llegan como la cadena `"null"`, no como
`null`. `toNonEmptyString('null')` devuelve `'null'` porque es una cadena no vacía, y
`mapHubspotToSapFields` (`order-builder.service.js:20`) descarta `null`, `undefined` y `''` pero no
el texto. Así que hoy las órdenes de Noelito en SAP tienen `U_ACO_Telefono2: "null"` y
`Address: "null"` escritos literalmente. El bug sobrevive a cualquier camino que se elija para lo
anterior, porque está una capa más abajo.

## Diseño

Cuatro piezas independientes entre sí.

### 1. `buildOrderPayload` pierde sus cinco parámetros

Se borran de la firma `comments`, `U_ACO_Telefono`, `U_ACO_Telefono2`, `Address` y `Address2`, y con
ellos el bloque `optionalFields` (`order-builder.service.js:391-397`). En
`ProcessHubspotWebhookEvent.js:306-317` la llamada queda sin ninguna lectura de propiedad de HubSpot
por nombre. Todo entra por `pickMappedHeaderFields`.

Para Noelito el resultado es idéntico al de hoy en tres campos, y **mejor** en dos: `U_ACO_Telefono2`
y `Address` dejan de escribir el texto `"null"` en SAP una vez aplicada la pieza 4.

### 2. `buildQuotationPayload` pierde su parámetro `comments`

Esto **revierte** una decisión del spec anterior. Ahí se conservó con este argumento:

> `ProcessHubspotUpdateQuotation.js:106` lee `deal?.comments` directo para su PATCH, así que si crear
> cotización pasara a leer por mapeo y actualizar siguiera leyendo la propiedad literal, un tenant que
> mapee `Comments` a otra propiedad recibiría un valor al crear y otro al actualizar.

El argumento era correcto y ya no aplica: la pieza 3 mete el PATCH en el mismo mecanismo, así que
crear y actualizar vuelven a leer de la misma fuente. Los dos tenants que crean cotizaciones
(`distelsa`, `printer`) tienen la fila `Comments <- comments` activa.

### 3. `updateQuotation` pasa por el mapeo

Hoy es el único flujo que nunca llama a `mapHubspotToSapFields`. Pasa a hacerlo con
`mappings.dealOrdersQuotationsMappings` y a derramar el resultado en el PATCH, en lugar de leer
`deal?.comments`.

**El PATCH sólo lleva lo que el workflow mandó en ese evento.** No hace falta lógica extra para
lograrlo: `mapHubspotToSapFields` ya descarta `null`, `undefined` y `''`, así que una propiedad que
no viene no produce clave. La consecuencia buscada es que editar líneas en HubSpot no pise campos de
cabecera que un usuario haya corregido a mano en SAP, porque esos campos no viajan si no vinieron.

Se reutiliza `pickMappedHeaderFields`, que hoy es privado del módulo y hay que exportar. Motivo:
protege los campos reservados (`CardCode`, `DocumentLines`, `PaymentGroupCode`) de ser pisados por un
mapeo, y aplica la normalización de `DocumentSpecialLines`. El `documentLineCount` que necesita para
anclar esa colección sale de `lineUpdates.length`.

**Limitación deliberada:** `pickMappedHeaderFields` excluye `DocDueDate` del derrame, porque en los
tres builders lo resuelve `resolveDocDueDate`. En el PATCH eso significa que **la fecha de
vencimiento no se actualiza** aunque el tenant la tenga mapeada. Se acepta: mover la fecha de
vencimiento de un documento ya creado en SAP es una decisión distinta de sincronizar sus líneas, y
ningún tenant que use `updateQuotation` mapea `DocDueDate` hoy.

**Esta pieza cierra a medias un item que quedó abierto en la rama anterior.** Ahí se detectó que
`updateQuotation` nunca escribe `NumAtCard`, así que si el usuario llena la OC después de creada la
oferta, en SAP la oferta queda sin el campo y el pedido con él. El derrame hace que el PATCH lleve
`NumAtCard` cuando el mapeo existe **y** el evento trae la propiedad — pero no alcanza para cerrar el
desfase de Distelsa: según `docs/superpowers/specs/2026-08-19-comments-numatcard-invoice-lineage-design.md`,
el workflow de Distelsa manda la propiedad de la orden de compra recién en `convertQuotationToOrder`,
nunca en `updateQuotation`. Aunque Distelsa tenga su fila de `NumAtCard <- orden_de_compra`, sus
eventos de `updateQuotation` no traen esa propiedad, así que el PATCH no la lleva y el desfase sigue
igual. El PATCH llevaría `NumAtCard` sólo si el workflow además empieza a mandar esa propiedad en los
eventos de actualización, que hoy no hace.

### 4. El mapeador descarta los textos `"null"` y `"undefined"`, con rastro

`mapHubspotToSapFields` pasa a tratar las cadenas `'null'` y `'undefined'` (sin distinguir
mayúsculas, y después de recortar espacios) igual que el `null` real: no producen clave.

**Y deja un `warn`** con el campo de SAP y la propiedad de HubSpot involucradas. Esto es lo que
convierte el arreglo en algo alineado con la regla en vez de un parche silencioso: el valor sucio
viene de un workflow mal configurado, y el warn es lo que hace que alguien lo corrija en HubSpot,
que es donde se corrige. Descartarlo en silencio taparía la causa.

Para poder loguear, la firma pasa a `mapHubspotToSapFields(source, mappings, { logger } = {})`. El
tercer parámetro es **opcional a propósito**: hay 17 llamadores y sólo los de cabecera de negocio
necesitan pasar el logger. Los otros catorce quedan sin tocar.

**No** se cambia `toNonEmptyString`. Se consideró y se descartó: ver alternativas.

## Alcance por tenant

| tenant | qué le cambia |
|---|---|
| `noelito` | Sus cinco campos pasan del código al mapeo. **El valor no es el mismo:** el camino viejo pasaba por `toNonEmptyString` (`String(value ?? '').trim()`) y el nuevo manda el valor crudo, sin recortar y sin convertir a string. Un `Address2` escrito a mano con un espacio o salto de línea final ahora viaja con eso incluido. Además deja de escribir `"null"` en `U_ACO_Telefono2` y `Address`. |
| `printer` | Nada funcional. Sus `Address`/`Address2` ya venían del derrame de `pickMappedHeaderFields` desde antes de este spec (`fd6f66c`), que nunca pasó por `toNonEmptyString`: el valor ya era crudo, así que ahí sí no cambia nada. Sólo deja de existir el override que nunca se activaba. |
| `distelsa` | `updateQuotation` pasa a leer `Comments` por mapeo en vez de `toNonEmptyString(deal?.comments)`. **El valor no es el mismo** por el mismo motivo que Noelito: deja de recortarse. |
| `amc` | Nada. Medido, no supuesto: se sondearon sus `WebhookEvents` de producción (2 eventos) y ninguna de las propiedades involucradas (`comments`, `numero_de_contacto_primario`, `numero_de_contacto_secundario`, `direccion_de_facturacion`, `direccion_de_entrega`) está presente en `payload.deal`. Sus `ClientConfigs` además están inactivas. Ver "Antes de reactivar amc" más abajo. |

**Sobre "el valor no es el mismo":** el cambio es intencional y no se revierte — que el valor del cliente viaje tal cual es la decisión tomada (ver pieza 4 y alternativas descartadas). Falla ruidosamente si el valor crudo excede el ancho de una columna en SAP (Service Layer rechaza el documento completo), lo cual es preferible a un recorte silencioso que esconda el dato real que el cliente escribió.

### Antes de reactivar amc

`amc` usa el flujo `createDeal`. Los cinco parámetros eliminados de `buildOrderPayload` eran, para
`amc`, la única fuente de cabecera además de `CardCode`/`DocDueDate`/`DocumentLines`/
`SalesPersonCode` — no le pegan hoy porque sus `ClientConfigs` están inactivas y ninguna de esas
propiedades viaja en sus eventos. Si se reactivan sus configs y su workflow empieza a mandar
`comments` u otra propiedad de cabecera, el código ya no la lee por nombre fijo: hay que crear la
fila de `FieldMapping` correspondiente **primero**. Es el mismo orden que se siguió con `noelito`
en este mismo spec: primero las filas, después el código. Reactivar sin las filas repetiría, para
`amc`, exactamente el riesgo silencioso que este spec cerró para `noelito`.

## Alternativas descartadas

**Aplicar el descarte de `"null"` en `toNonEmptyString`.** Cubriría también los identificadores: hoy
un `hs_object_id` que llegue como `"null"` se convierte en un `dealId` que vale `"null"` y termina en
un `SapDocumentLink` con ese valor. Descartada para este trabajo por el tamaño del cambio: 208 usos
en 34 archivos, la mayoría identificadores (`hs_object_id`, `fromObjectId`, `portalId`, `hs_sku`,
`cardCode`, `itemCode`), así que cambiarle la semántica exige su propia tanda de regresión y su
propia rama para poder atribuir cualquier fallo. Queda anotado como trabajo siguiente.

**Descartar el `"null"` sin log.** Menos ruido, pero deja tapado que el workflow de Noelito manda dos
propiedades mal. Contradice el principio acordado de que un payload mal armado se corrige en HubSpot.

**Borrar las cinco lecturas hardcodeadas sin crear antes los mapeos de Noelito.** Le habría borrado
teléfono y dirección de entrega en silencio. Es la razón por la que la carga de las filas fue el
primer paso y no el último.

**Mandar la cabecera mapeada incondicionalmente en cada PATCH de `updateQuotation`, incluidos los
campos vacíos.** Esto es lo que se descartó — no "mandar toda la cabecera mapeada", que es
justamente lo que `ProcessHubspotUpdateQuotation` sí hace (pieza 3). Mandar cada campo mapeado
_aunque no tenga valor en el evento_ dejaría a HubSpot como fuente única de verdad y SAP nunca
divergiría, pero cualquier corrección manual en SAP se perdería en la siguiente edición de líneas
desde HubSpot. Descartada por decisión del dueño del proyecto.

Lo que sí se implementó es derramar la cabecera mapeada completa y confiar en que
`mapHubspotToSapFields` filtra los campos vacíos (no produce clave para `null`, `undefined`, `''` ni
los sentinels de texto) para que un campo ausente en el evento no se pise en SAP. Esa protección es
más débil de lo que parece: depende de que el workflow **no mande** el campo en absoluto, no de que
HubSpot mande deltas. `printer` es el caso que lo deja claro — su payload es un snapshot completo del
deal con unas 90 propiedades, la mayoría en `null`; ese workflow serializa el negocio entero en cada
evento, no un delta. Si un workflow empezara a mandar explícitamente una propiedad vacía en vez de
omitirla, `mapHubspotToSapFields` la sigue filtrando por su propio criterio de vacío, pero el diseño
no se apoya en que el workflow mande menos: se apoya en que el mapeador filtre lo vacío sin importar
cuánto mande el workflow.

**Sembrar las cinco filas de Noelito en `defaultClientConfigMappings.service.js`.**
`numero_de_contacto_primario` y `direccion_de_entrega` son nombres de propiedad específicos de ese
tenant; sembrarlos para los cuatro crea mapeos muertos en el admin de los otros tres. Mismo criterio
ya documentado para inventory-transfer-request y para `NumAtCard`.

## Pruebas

Nuevas:

- `mapHubspotToSapFields` descarta `'null'`, `'undefined'`, `'NULL'`, `' null '` y no produce la
  clave; y **sí** conserva valores legítimos que contienen la palabra dentro de otro texto
  (`'anulado'`, `'null y algo mas'`).
- Cuando descarta por ese motivo, emite un `warn` con el `sourceField` y el `targetField`. Y no
  explota cuando no se le pasa logger.
- `buildOrderPayload` ya no acepta los cinco parámetros: con `mappedDealFields` que traiga
  `Comments`, `U_ACO_Telefono`, `U_ACO_Telefono2`, `Address` y `Address2`, el payload los lleva; con
  `mappedDealFields` vacío no aparece ninguno.
- `ProcessHubspotWebhookEvent` no lee ninguna propiedad de HubSpot por nombre: con el payload de
  Noelito (`numero_de_contacto_primario`, `direccion_de_entrega`, `comments`) **y sin** los mapeos
  correspondientes, el payload de SAP sale sin esos campos. Es el test que fija que el código ya no
  tiene la puerta trasera.
- El mismo caso **con** los mapeos de Noelito: los cinco campos viajan con su valor.
- `buildQuotationPayload` ya no acepta `comments`: sale del derrame o no sale.
- `ProcessHubspotUpdateQuotation` deriva el PATCH del mapeo: con `Comments <- comments` y
  `NumAtCard <- orden_de_compra` mapeados y presentes en el payload, el PATCH lleva los dos.
- El mismo caso con el payload sin esas propiedades: el PATCH lleva `DocumentLines` y nada de
  cabecera. Es el test que fija que una edición de líneas no pisa la cabecera de SAP.
- `pickMappedHeaderFields` sigue protegiendo los campos reservados cuando se lo llama desde el PATCH.

A revisar, porque afirman el comportamiento que se está quitando:

- `tests/unit/application/processQuotationFlows.test.js:248` y `:266` — `forwards deal.comments as the
  quotation Comments` y `omits Comments on the quotation`. Pasan a expresarse por mapeo. El fixture
  `dealOrdersQuotationsMappings` está en `[]` por defecto (línea ~28), así que hay que darle la fila.
- `tests/unit/application/processQuotationFlows.test.js:581` y `:592` — los dos casos de `Comments` en
  el PATCH de `updateQuotation`.
- Cualquier test de `buildOrderPayload` que pase los cinco parámetros.

Correr jest con path anclado, no desde la raíz: la raíz levanta también las suites de los worktrees.
Hay 4 suites con fallos preexistentes ajenos (`sendMappedItemsToHubspot`,
`lineItemPriceWebhook.service`, `serviceLayerFlow`, `serviceLayerService`), verificados contra el
merge-base.

## Prueba manual

1. **Noelito, `createDeal`:** disparar un negocio con `numero_de_contacto_primario` y
   `direccion_de_entrega` llenos, y verificar en SAP que la orden lleva `U_ACO_Telefono` y `Address2`
   con esos valores. Verificar además que `U_ACO_Telefono2` y `Address` quedan **vacíos** y no con el
   texto `"null"`, y que el `warn` del descarte aparece en `logs/app.log`.
2. **Distelsa, `updateQuotation`:** editar líneas de un negocio cuyo payload **no** traiga `comments`,
   y verificar que el `Comments` que la oferta ya tenía en SAP **no** se borra ni se pisa.
3. **Distelsa, `updateQuotation` con `comments`:** editar líneas con `comments` lleno y verificar que
   el `Comments` de la oferta se actualiza.
