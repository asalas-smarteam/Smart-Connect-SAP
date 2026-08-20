# Comments sin default, NumAtCard desde FieldMapping, y facturas por linaje SAP

Fecha: 2026-08-19
Tenant que lo pide: `sap_integration_distelsa` (`SBO_DISTELSA_PROD`)

## Problema

Tres cosas atadas entre sí.

**1. `Comments` con texto default.** La orden creada desde una cotización manda un literal
del integrador en vez del comentario de HubSpot. Confirmado en producción: la orden
`DocEntry 28987` tiene `Comments: "Pedido creado desde oferta SAP por etapa Orden de Compra
en HubSpot"`. El cliente ya reportó que en cotizaciones está bien y en órdenes no, y los datos
lo respaldan: las últimas cotizaciones llevan texto real de HubSpot (`"PRUEBA, SMARTEAM6"`,
`"Prueba de comentario en hubspot 1908"`) y `null` cuando viene vacío.

Regla que pidió el cliente, sin excepción y para todo documento: `Comments` viene de HubSpot
o va nulo. Nunca un default del integrador.

**2. `NumAtCard` ocupado por `HS-DEAL-<dealId>`.** La integración escribe ese código para poder
identificar después el negocio. El cliente necesita ese campo para su propia orden de compra,
que ahora captura en una propiedad de HubSpot. Confirmado en producción: la orden `28987` tiene
`NumAtCard: "HS-DEAL-64175519381"`.

**3. La tarea de facturas depende de ese código.** Hoy `invoice.handler.js` parsea el prefijo
`HS-DEAL-` del `NumAtCard` de la factura para sacar el `dealId`. Si `NumAtCard` pasa a ser un
dato del cliente, la reconciliación deja de encontrar negocios y ninguno se mueve a cierre
ganado — en silencio, porque una factura ajena a HubSpot siempre fue un descarte esperado.

## Validación contra el Service Layer en vivo

Sondeado el 2026-08-19 contra `SBO_DISTELSA_PROD`, sólo lecturas:

- **`$select` acepta `DocumentLines` en `Invoices`.** No hace falta `$expand`. Era el único
  supuesto del diseño que no se podía confirmar leyendo código.
- **El linaje factura→orden es universal en este tenant.** 180 facturas en 90 días: 180 con
  al menos una línea `BaseType: 17`, **cero** sin línea de orden, **cero** con `BaseType: 23`,
  **cero** consolidadas (más de un `BaseEntry` de orden distinto).
- **Las líneas repiten el mismo `BaseEntry`.** La factura `1024440` lo trae tres veces. Deduplicar
  con un `Set` es obligatorio, no defensivo.
- **El linaje cierra de punta a punta.** Factura `1024453` → `BaseEntry 28987` → orden `28987`,
  cuyo `NumAtCard` es `HS-DEAL-64175519381`.
- **Las OC propias del cliente traen caracteres especiales**: `"OC #P06485"`, `"O/C 50471"`,
  `"OC-4504297314"`. Relevante sólo para las alternativas descartadas.
- **15 de 18 facturas de hoy son pedidos propios del cliente** (`NumAtCard` con su OC, `null` o
  `""`). Sólo 3 nacieron en HubSpot. Esto decide el nivel de log de los descartes.

## Diseño

### 1. `Comments` nunca default

En `ProcessHubspotConvertQuotationToOrder.js:118`, `comments: '<literal>'` pasa a
`comments: deal?.comments`. `deal` ya está en scope desde la línea 39.

No hace falta nada más: `buildOrderFromQuotationPayload` filtra con `toNonEmptyString`
(`order-builder.service.js:494`), así que un `comments` vacío no agrega la clave `Comments` al
payload y SAP la deja nula. Queda idéntico al camino de cotización, que ya funciona.

Los tres builders (`buildOrderPayload`, `buildQuotationPayload`,
`buildOrderFromQuotationPayload`) tienen `comments = null` por defecto y ningún otro literal.
Ese era el único.

`Comments` **no** pasa a FieldMapping. Se lee de la propiedad literal `deal.comments`, igual que
hoy en cotización y en `ProcessHubspotUpdateQuotation.js:106`. Convertirlo a mapeo rompería a los
tenants que hoy dependen de esa propiedad hasta crearles la fila.

### 2. `NumAtCard` desde el FieldMapping

El mecanismo ya existe y funciona: el contexto `deal` / `orders-quotations`
(`TenantWebhookRuntimeRepository.js:84`) se mapea con `mapHubspotToSapFields` y se derrama en la
cabecera vía `pickMappedHeaderFields` (`order-builder.service.js:69`), que sólo excluye
`CardCode`, `DocDueDate`, `DocumentLines` y `PaymentGroupCode`. `NumAtCard` no está reservado.

Lo único que lo tapa es que el parámetro explícito se aplica **después** del spread, así que gana
siempre contra el mapeo.

**El objetivo no es dejar de mandar `NumAtCard` en cotización. Es que en cotización, en orden
directa y en orden desde cotización el valor tenga una sola fuente: el mapeo.** Que viaje o no
depende de la configuración del tenant, no del tipo de documento, y el código no debe distinguir
entre esos tres escenarios.

Ese valor viaja cuando se cumplen **las dos** condiciones, y las dos son configuración, no código:

1. **Existe la fila en `FieldMapping`**: `sourceField: 'NumAtCard'`,
   `targetField: '<propiedad de HubSpot>'`, `objectType: 'deal'`,
   `sourceContext: 'orders-quotations'`.
2. **El workflow de HubSpot manda esa propiedad dentro de `payload.deal`.**
   `resolveEventPayload` devuelve `payload.deal` tal cual, sin lista blanca
   (`webhook-payload.service.js:14`), así que cualquier propiedad que el workflow incluya llega al
   mapeador. Si el workflow no la manda, no hay nada que mapear.

Si falta cualquiera de las dos, `mapHubspotToSapFields` no produce la clave (descarta `null`,
`undefined` y `''` en `order-builder.service.js:20`), el builder no agrega `NumAtCard` al payload
y SAP deja el campo como esté. O sea: vacío en HubSpot ⇒ vacío en SAP, sin default y sin error.

Los cambios:

- **Cotización** (`ProcessHubspotCreateQuotation.js:171`): se quita
  `numAtCard: buildDealNumAtCard(dealId)`, y se quita también el parámetro `numAtCard` de la firma
  de `buildQuotationPayload`. No es para que la cotización deje de mandar el campo — el spread del
  mapeo lo sigue trayendo, y un tenant que sí lo manda en cotización queda cubierto. Es para que
  deje de haber dos fuentes para el mismo campo, donde la explícita pisa a la del mapeo en
  silencio. Esa duplicación es la causa raíz del bug.
- **Orden desde cotización** (`ProcessHubspotConvertQuotationToOrder.js:117`): pasa a
  `numAtCard: mappedDeal.NumAtCard`. Aquí el paso explícito **sí** hace falta, porque este builder
  a propósito no derrama los campos mapeados (SAP copia la cabecera de la cotización base). Sigue
  habiendo una sola fuente: `mappedDeal`.
- Se borra `buildDealNumAtCard` de `webhookQuotationSupport.js:380`.

`buildOrderPayload` (orden directa, sin cotización) ya funciona así hoy: no tiene parámetro
`numAtCard` y toma el valor del spread. No se toca. Después del cambio, los tres builders se
comportan igual.

**Distelsa en concreto:** su workflow manda la propiedad recién en la conversión a orden de venta,
así que sus cotizaciones van a quedar con `NumAtCard` vacío y sus órdenes con la OC del usuario.
Eso es consecuencia de su configuración, no del código: el mismo código, con un workflow que mande
la propiedad desde el inicio, la manda también en la cotización.

**No se siembra un mapeo por defecto** en `defaultClientConfigMappings.service.js`: el nombre de
la propiedad de HubSpot es específico del tenant y sembrarlo para todos crea mapeos muertos en el
admin. Es el mismo criterio ya documentado para inventory-transfer-request. La fila se crea desde
el admin para el tenant que la necesita.

### 3. Facturas: reconciliación por linaje SAP

```
factura → rawSapData.DocumentLines[]
        → líneas con BaseType 17 → Set de BaseEntry
        → SapDocumentLink { hubspotCredentialId, documentType: 'order', sapDocEntry }
        → dealId → getUpdateDealStageConfig → updateDeal
```

`SapDocumentLink` **ya guarda `sapDocEntry`** desde siempre, así que esto funciona sobre los links
que ya están en producción: sin campo nuevo, sin backfill, sin colección nueva, y sin ninguna
llamada extra a HubSpot ni a SAP.

Tampoco guarda ninguna copia de `NumAtCard`, así que no hay nada que se desincronice si alguien
edita ese campo en HubSpot o en SAP después de creada la orden.

**El filtro por `BaseType: 17` no es opcional.** Los `DocEntry` de SAP son secuencias por objeto:
la cotización 500 y la orden 500 coexisten. Sin filtrar por tipo, una factura copiada de una
cotización (`BaseType: 23`) haría match con una orden ajena que tenga ese `DocEntry` y movería el
negocio equivocado.

**`DocumentLines` se agrega como campo estructural, no como FieldMapping.** El reconciliador lo
requiere; si viajara como mapeo, un tenant que lo borre desde el admin rompe el sync en silencio.
`buildServiceLayerUrl` ya tiene `clientConfig.objectType` a mano y ya tiene el mecanismo de campos
extra por objectType (`serviceLayerUrlBuilder.js:49`, mezclado en `:156`), así que se agrega ahí como obligatorio para
`objectType: 'invoice'`.

**Facturas consolidadas:** el `Set` puede traer varios `BaseEntry`. Se mueven todos los negocios
encontrados; la factura cuenta como un `updated` y el log lleva la lista de `dealId`. No se
observó ningún caso en 90 días, pero el código no asume que no exista.

**`findByDeal` se reemplaza por `findByOrderDocEntry`.** Ya no se busca el link por `dealId`: encontrar el link de orden por su `sapDocEntry` ya
es la prueba de que la factura le corresponde.

**Índice.** Se agrega `{ hubspotCredentialId: 1, documentType: 1, sapDocEntry: 1 }` (no único) al
esquema de `SapDocumentLink`. `mongoose.createConnection` va con `autoIndex` por defecto
(`tenantDatabase.js:38`), así que se crea solo en los cuatro tenants de producción. No hace falta
backfill porque `sapDocEntry` siempre se escribió.

**Códigos de descarte.** Los dos nuevos van en `debug`, no en `warn`:

| código | significado | nivel | por qué |
|---|---|---|---|
| `NO_ORDER_BASE_ENTRY` | ninguna línea apunta a un pedido | debug | factura ajena a un pedido: esperado, no anomalía |
| `ORDER_LINK_NOT_FOUND` | apunta a un pedido que la integración no creó | debug | 15 de 18 facturas por corrida |
| `UPDATE_DEAL_STAGE_DISABLED` | configuración ausente o apagada | warn | sí es un error de configuración |
| `NO_DEAL_IN_NUM_AT_CARD` | *histórico, ya no se emite* | — | ver abajo |

`ORDER_LINK_NOT_FOUND` baja de `warn` a `debug`: con este cliente, que factura sus propios pedidos
de SAP, se emite en la gran mayoría de las facturas de cada corrida y en `warn` llenaría el log.

`NO_DEAL_IN_NUM_AT_CARD` se deja **declarado con un comentario de que es histórico**. Los `SyncLog`
viejos en Mongo lo tienen guardado en `skippedReasons`; borrar la constante hace ilegibles esas
corridas.

Se borra `extractDealId`. `NumAtCard` se queda en `DEFAULT_INVOICE_MAPPINGS`: ya no decide nada,
pero es la OC del cliente y sirve en el log. Hay que corregir el comentario de
`defaultClientConfigMappings.service.js:65`, que hoy dice que los mapeos existen para que el
reconciliador lea `NumAtCard (HS-DEAL-<dealId>)`.

## Sin compatibilidad hacia atrás

Decisión del cliente: las órdenes existentes con `NumAtCard: HS-DEAL-<id>` se van a borrar. No hay
fallback al parseo del prefijo ni migración de datos.

## Limitación conocida (no se implementa)

Si alguien convierte una cotización en orden **a mano dentro de SAP**, la integración nunca crea el
`SapDocumentLink` de esa orden. Su factura resuelve el `BaseEntry`, no encuentra link, y el negocio
no se mueve a cierre ganado.

Esto **ya pasa hoy** por el mismo motivo (el handler actual también exige el link de orden), así
que no es una regresión de este cambio. En el sondeo se vieron órdenes con
`Comments: "Basado en Ofertas de ventas 51429."` — el texto que escribe SAP en esas conversiones
manuales — pero eran de cotizaciones nativas de SAP, sin `HS-DEAL-`, o sea negocio propio del
cliente y ajeno a la integración.

Queda anotado porque si el cliente empieza a convertir a mano cotizaciones que **sí** nacieron en
HubSpot, esos negocios se quedan sin cerrar sin ningún error visible. Mitigación posible si aparece:
encadenar orden→cotización (traer la orden de SAP, leer su `BaseEntry` de `BaseType: 23`, y buscar
el link de cotización). No se implementa ahora porque costaría un GET a SAP en cada una de las ~15
facturas ajenas por corrida para cubrir un caso que hoy no ocurre.

## Alternativas descartadas

**Guardar `numAtCard` en `SapDocumentLink`** (o en una colección nueva). Era la propuesta inicial y
funciona, pero es la única opción que guarda una **copia** de un dato que dos sistemas distintos
pueden editar. Si alguien cambia el `NumAtCard` en HubSpot o en SAP después de creada la orden, la
factura llega con un valor que Mongo no tiene y el negocio no se mueve — sin error, meses después.
El linaje no tiene esa clase de falla, y además no necesita campo nuevo ni backfill.

**Búsqueda inversa en HubSpot por la propiedad del mapeo** (`findDealByProperty`, o en lote con el
operador `IN`). Funciona y siempre refleja el estado real de HubSpot, pero agrega tráfico de red al
reconciliador, que hoy no llama a HubSpot para identificar el negocio. El loop de facturas es
secuencial (`SendMappedItemsToHubspot.js:455`) y la Search API está limitada a 5/s a nivel de
cuenta, así que una corrida grande se alarga. Peor: las ~15 facturas ajenas por corrida gastarían
una búsqueda cada una para no encontrar nada. Y las OC del cliente traen `#` y espacios, que habría
que escapar.

**UDF en SAP con el `dealId`** (`U_HS_DealId` en la orden, marcado para copiarse al documento
destino). Es la respuesta correcta desde SAP e inmune a todo lo anterior, pero requiere trabajo del
cliente en su SAP. Descartada por decisión del usuario.

**Híbrido linaje + `numAtCard` de respaldo.** Cubriría facturas emitidas sueltas, pero el sondeo
mostró 0 de 180 en 90 días. Es el doble de código y de casos de prueba para un caso que no existe
en este tenant.

## Pruebas

Nuevas:

- `extractOrderBaseEntries`: filtro por `BaseType`, deduplicación del mismo `BaseEntry` repetido,
  entrada basura (`null`, no-array, `BaseEntry` no numérico).
- `invoice.handler.process`: un caso por código de descarte, el camino feliz, y el camino con
  varios `BaseEntry` distintos.
- `findByOrderDocEntry` en el repositorio.
- `buildServiceLayerUrl`: incluye `DocumentLines` para `objectType: 'invoice'` y **no** lo incluye
  para los demás.
- `buildQuotationPayload` toma `NumAtCard` de los campos mapeados (y ya no acepta el parámetro).
- **Cotización de un tenant que sí manda `NumAtCard`**: con `mappedDealFields.NumAtCard` presente,
  el payload de cotización lo lleva. Este caso es el que garantiza que el cambio no deja fuera a
  los tenants distintos de Distelsa, y hoy no existe en la suite.
- **Cotización sin la propiedad**: sin `NumAtCard` en `mappedDealFields`, la clave no aparece en el
  payload (no viaja como `null` ni como `''`).
- `buildOrderFromQuotationPayload` recibe `numAtCard` y `comments` explícitos.
- `ProcessHubspotConvertQuotationToOrder` pasa `deal.comments` y `mappedDeal.NumAtCard`.

A reescribir, porque hoy afirman el comportamiento que se está quitando:

- `tests/unit/infrastructure/invoiceHandler.test.js` — completo, hoy todo gira sobre `HS-DEAL-`.
- `tests/unit/domain/quotationBuilder.test.js:22` — espera `NumAtCard: 'HS-DEAL-123'`.
- `tests/unit/domain/orderBuilder.test.js` — casos de `buildQuotationPayload` y
  `buildOrderFromQuotationPayload`.

Correr jest apuntado a los archivos, no desde la raíz: la raíz levanta también las suites de los
worktrees y produce fallos ajenos al cambio.

## Prueba manual

`POST /sap-sync/run` con sólo la config de facturas de `sap_integration_distelsa` activa. En
`SBO_DISTELSA_PROD` hay facturas de hoy con `NumAtCard: HS-DEAL-<id>` cuyo `BaseEntry` apunta a
órdenes reales (`1024453 → 28987`, `1024445 → 28974`), así que el camino feliz se puede verificar
con datos existentes antes de tocar HubSpot.
