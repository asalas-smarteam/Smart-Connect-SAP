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
- **SAP copia `NumAtCard` de la cotización base a la orden.** 12 de 12 órdenes con cotización base
  coinciden exactamente con su base, incluidas conversiones nativas del cliente.
- **15 de 18 facturas de hoy son pedidos propios del cliente** (`NumAtCard` con su OC, `null` o
  `""`). Sólo 3 nacieron en HubSpot. Esto decide el nivel de log de los descartes.

## Impacto por tenant

Medido en el Mongo de producción el 2026-08-19: `eventType` en `WebhookEvents`, filas de
`FieldMappings` en contexto `deal`/`orders-quotations`, y `ClientConfigs` activas.

| tenant | eventTypes en uso | mapeos `deal`/`orders-quotations` | config `invoice` |
|---|---|---|---|
| `amc` | `createDeal` | 0 | no |
| `distelsa` | `createQuotation`, `updateQuotation`, `convertQuotationToOrder` | 1 (`Comments <- comments`) | **sí, la única activa** |
| `noelito` | `createDeal` | 2 (`PaymentGroupCode`, `CardName`) | no |
| `printer` | `createQuotation`, `createDeal`, `inventoryTransferRequest` | 81, incluido `NumAtCard <- hs_object_id` | no |

Esto acota cada cambio:

- **Sólo Distelsa usa `convertQuotationToOrder`.** Volver genérico ese builder afecta a un tenant
  con 2 mapeos en ese contexto. Los 81 campos de Printer nunca llegan ahí.
- **Sólo Distelsa tiene config de `invoice`.** El cambio del reconciliador (sección 3) toca un solo
  tenant, y es el mismo contra el que se validó el linaje.
- **`amc` y `noelito` no tienen mapeo de `Comments`.** Para ellos el parámetro explícito de
  `buildOrderPayload` es la única fuente de ese campo. Ver la advertencia en la sección 1.
- **Distelsa no tiene mapeo de `NumAtCard`.** Hay que crear la fila; es el paso de configuración
  sin el cual el cambio no produce ningún efecto para ellos.

## Diseño

### El principio

`Comments` y `NumAtCard` dejan de ser campos con tratamiento especial. Pasan a ser dos casos del
mismo mecanismo que ya existe: **el payload de HubSpot puede traer campos extra, y el FieldMapping
decide cuáles se convierten en campos de la cabecera de SAP.**

Eso ya es cierto en `buildOrderPayload` y en `buildQuotationPayload`, que derraman
`pickMappedHeaderFields(mappedDeal)` en la cabecera (`order-builder.service.js:69`). El derrame
sólo excluye `CardCode`, `DocDueDate`, `DocumentLines` y `PaymentGroupCode`; ni `Comments` ni
`NumAtCard` están reservados.

Los dos bugs tienen la misma causa raíz: **un parámetro explícito que se aplica después del
derrame y por lo tanto le gana siempre al mapeo.** En órdenes-desde-cotización ese parámetro traía
un literal del integrador; en cotizaciones traía `HS-DEAL-<dealId>` y le pisaba a Printer el
`hs_object_id` que configuró. Arreglar los dos casos es eliminar la doble fuente, no agregar más
casos especiales.

El valor viaja cuando se cumplen **las dos** condiciones, y las dos son configuración, no código:

1. **Existe la fila en `FieldMapping`**: `sourceField` con el nombre del campo de SAP,
   `targetField` con la propiedad de HubSpot, `objectType: 'deal'`,
   `sourceContext: 'orders-quotations'`.
2. **El workflow de HubSpot manda esa propiedad dentro de `payload.deal`.**
   `resolveEventPayload` devuelve `payload.deal` tal cual, sin lista blanca
   (`webhook-payload.service.js:14`), así que cualquier propiedad que el workflow incluya llega al
   mapeador.

Si falta cualquiera de las dos, `mapHubspotToSapFields` no produce la clave (descarta `null`,
`undefined` y `''` en `order-builder.service.js:20`), el builder no agrega el campo al payload y
SAP lo deja como esté. Vacío en HubSpot ⇒ vacío en SAP, sin default y sin error.

**El FieldMapping es la única autoridad.** Si una propiedad no llega en `payload.deal`, es un error
de configuración del workflow y se corrige en HubSpot. El código no lo compensa, no lo adivina y no
inventa un valor de reemplazo: deja de mandar el campo y el error queda visible en SAP como campo
vacío. Es el mismo criterio que ya se aplica cuando un FieldMapping del cliente provoca un error en
SAP — se hace visible, no se parchea desde el código.

### 1. `buildOrderFromQuotationPayload` pasa a derramar los campos mapeados

Es el cambio que arregla los dos bugs de una vez.

Hoy ese builder es el único de los tres que **no** derrama `mappedDealFields`: toma sólo
`DocDueDate`, porque SAP copia la cabecera de la cotización base
(`order-builder.service.js:445`). Pasa a derramar `pickMappedHeaderFields` como los otros dos.

En `ProcessHubspotConvertQuotationToOrder.js:112` eso significa:

- Se borra `comments: 'Pedido creado desde oferta SAP por etapa Orden de Compra en HubSpot'`
  (línea 118). `Comments` llega por el mapeo `Comments <- comments` que Distelsa ya tiene.
- **No** se agrega `numAtCard: mappedDeal.NumAtCard`. Llega por el derrame, igual que cualquier
  otro campo, en cuanto exista la fila del mapeo.
- Se borran los parámetros `numAtCard` y `comments` de la firma del builder: con el derrame activo
  serían una segunda fuente que le gana al mapeo, o sea el bug de nuevo.

Resultado: el próximo campo extra que Distelsa quiera mandar en la conversión no necesita código,
sólo una fila en el admin.

**`buildOrderPayload` (orden directa) NO se toca.** Conserva su parámetro `comments`. `amc` y
`noelito` no tienen mapeo de `Comments` y ese parámetro es su única fuente; quitarlo les borraría
los comentarios en silencio. Ese parámetro además no tiene el defecto que estamos arreglando: lee
`deal?.comments`, no un literal.

### 2. `NumAtCard`: se elimina `HS-DEAL-<dealId>`

- **Cotización** (`ProcessHubspotCreateQuotation.js:171`): se quita
  `numAtCard: buildDealNumAtCard(dealId)` y se quita el parámetro `numAtCard` de la firma de
  `buildQuotationPayload`. El derrame ya trae el valor del mapeo.
- Se borra `buildDealNumAtCard` de `webhookQuotationSupport.js:380`.

**Cambio de comportamiento en Printer, aceptado sin aviso al cliente.** Printer configuró
`NumAtCard <- hs_object_id` pero hoy recibe `HS-DEAL-<id>` en sus cotizaciones, porque el parámetro
le gana al mapeo. Después del cambio recibirá el `<id>` crudo, que es lo que configuró. Nada en
este código lee ese campo de vuelta para Printer: no tienen config de `invoice` y su config de
`deal` está inactiva. Decisión tomada el 2026-08-19: se despliega sin avisarles.

**`buildQuotationPayload` conserva su parámetro `comments`.** Se consideró quitarlo por simetría
—es una doble fuente que le gana al mapeo— y se descartó: `ProcessHubspotUpdateQuotation.js:106`
lee `deal?.comments` directo para su PATCH, así que si crear cotización pasara a leer por mapeo y
actualizar siguiera leyendo la propiedad literal, un tenant que mapee `Comments` a otra propiedad
recibiría un valor al crear y otro al actualizar. Eso es peor que la doble fuente actual, donde
ambas leen la misma propiedad. Unificarlo de verdad exige meter el camino de update en el mismo
mecanismo, y eso es trabajo aparte de este spec.

El parámetro que sí se quita de ese builder es `numAtCard`, que es el que produce el override
observado en Printer. La diferencia es que ese parámetro traía un valor **fabricado por el
integrador** (`HS-DEAL-<dealId>`), mientras que `comments` lee una propiedad de HubSpot: sólo el
primero es el defecto que este trabajo elimina.

**Asimetría aceptada, y su riesgo.** En el camino de conversión, `Comments` pasa a salir del mapeo,
mientras que crear y actualizar cotización lo siguen leyendo de `deal.comments`. Para Distelsa da
el mismo valor, porque su fila es `Comments <- comments`. El riesgo es que si esa fila se desactiva
o se borra, los comentarios de sus órdenes desaparecen en silencio — y los comentarios son
justamente lo que el cliente reclamó. Se asume porque es coherente con el principio acordado (una
propiedad que no llega es un error de configuración que se corrige en HubSpot), pero queda escrito
para que se sepa de dónde vendría esa falla.

**Distelsa en concreto:** su workflow manda la propiedad de la OC recién en
`convertQuotationToOrder`, así que sus cotizaciones quedarán con `NumAtCard` vacío y sus órdenes
con la OC del usuario. Eso es consecuencia de su configuración, no del código.

Y como red de seguridad verificada: SAP copia `NumAtCard` de la cotización base a la orden (12 de
12 órdenes coinciden con su base, incluidas conversiones nativas del cliente — `OC 4500093438` en
la orden 25308, `OC-13265` en la 25307). Si un tenant mandara la propiedad sólo en la cotización y
no en la conversión, la orden heredaría el valor correcto igual.

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

## Paso de configuración, sin el cual nada de esto tiene efecto para Distelsa

Crear en el admin la fila `NumAtCard` → propiedad de HubSpot de la OC, en `objectType: 'deal'`,
`sourceContext: 'orders-quotations'`, para el `hubspotCredentialId` de Distelsa. Hoy ese contexto
tiene una sola fila (`Comments <- comments`). Sin esta fila el código queda correcto pero el
`NumAtCard` de Distelsa viajará vacío.

Y **las dos filas de ese contexto pasan a ser críticas para el camino de conversión**, porque es de
ahí que salen `Comments` y `NumAtCard` de la orden. Desactivar o borrar `Comments <- comments`
vacía los comentarios de las órdenes de Distelsa sin ningún error visible.

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
Sobre el derrame de campos mapeados, que es el corazón del cambio:

- `buildOrderFromQuotationPayload` **derrama** los campos mapeados: con
  `mappedDealFields: { NumAtCard: 'OC-123', Comments: 'texto' }` el payload lleva los dos.
- El mismo builder **no** inventa nada con `mappedDealFields` vacío: ni `NumAtCard` ni `Comments`
  aparecen en el payload. Este es el test que fija la regla que pidió el cliente.
- El mismo builder sigue respetando `DocDueDate` y las líneas `BaseType`/`BaseEntry`/`BaseLine`
  que ya construía: el derrame no debe pisar lo que el builder posee.
- Ninguno de los tres builders acepta ya un parámetro `numAtCard` que le gane al mapeo
  (`buildQuotationPayload` y `buildOrderFromQuotationPayload` pierden la firma; `buildOrderPayload`
  nunca la tuvo).
- `buildQuotationPayload` **conserva** su parámetro `comments`: con `mappedDealFields` vacío y
  `comments: 'texto'`, el payload lleva `Comments`. Protege los dos tests vivos de
  `processQuotationFlows.test.js` y la consistencia con el PATCH de update-quotation.
- **Cotización de un tenant que sí manda `NumAtCard`** (el caso de Printer): con
  `mappedDealFields.NumAtCard` presente el payload de cotización lo lleva **tal cual**, sin prefijo
  `HS-DEAL-`. Es el test que fija el cambio de comportamiento de Printer como intencional.
- **Cotización sin la propiedad**: sin `NumAtCard` en `mappedDealFields`, la clave no aparece en el
  payload (no viaja como `null` ni como `''`).
- `buildOrderPayload` **conserva** su parámetro `comments`: con `mappedDealFields` vacío y
  `comments: 'texto'`, el payload lleva `Comments`. Es el test que protege a `amc` y `noelito`, que
  no tienen mapeo de `Comments`, de que un refactor futuro lo elimine por simetría.
- `ProcessHubspotConvertQuotationToOrder` no pasa `comments` ni `numAtCard` al builder, y el
  payload resultante no contiene el literal `'Pedido creado desde oferta SAP'`.

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
