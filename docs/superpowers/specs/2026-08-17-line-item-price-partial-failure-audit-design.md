# Fallo parcial, audit log y reconciliación en el webhook de precios de line items

Fecha: 2026-08-17

## Problema

Un cliente reporta que "muchas veces no cargan los precios" en los deals. El registro que
quedó en `LineItemPriceWebhookEvents`:

```json
{
  "payload": {
    "eventId": 2073333923, "portalId": 50249912, "appId": 36665006,
    "occurredAt": 1786997905997, "subscriptionType": "deal.associationChange",
    "attemptNumber": 0, "changeSource": "USER",
    "associationType": "DEAL_TO_LINE_ITEM",
    "fromObjectId": 64058987777, "toObjectId": 58061514894,
    "associationRemoved": false, "sourceId": "userId:82088707"
  },
  "isSend": false,
  "errorMessage": "HubSpot API request failed: 404 Not Found",
  "dealId": null,
  "createdAt": { "$date": "2026-08-17T20:18:26.550Z" },
  "updatedAt": { "$date": "2026-08-17T20:18:26.776Z" }
}
```

`dealId: null` y la ausencia de `payload.lineItems` lo ubican en la estrategia
**businessPartner legacy**, rama de asociación
([lineItemPriceWebhook.service.js:512](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js)).
`occurredAt` = 20:18:25.997 y `updatedAt` − `createdAt` = 226 ms: el evento se procesó medio
segundo después del cambio y murió con una o dos llamadas HTTP hechas, sin llegar a SAP.

Tres defectos convierten ese 404 puntual en "nunca carga":

1. **`Promise.all` todo o nada.** `resolveLineItems` lee todas las líneas del deal en
   paralelo ([:118](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js)).
   Una sola línea que dé 404 —o que no tenga `hs_sku`
   ([:125](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js))— rechaza el
   `Promise.all` y deja sin precio a **todas** las demás. Lo mismo en el ciclo de SAP de
   `SyncLineItemPrices` ([SyncLineItemPrices.js:179](../../../src/application/use-cases/SyncLineItemPrices.js)):
   un `Price list N not found for item X`
   ([:84](../../../src/application/use-cases/SyncLineItemPrices.js)) tumba el deal completo.

2. **No se ve por qué falló.** El evento guarda un `errorMessage` de una línea. El detalle
   (endpoint, status, respuesta del servidor) sí existe: `hubspotRequest` lo cuelga en
   `error.details` ([hubspotClient.js:67](../../../src/infrastructure/hubspot/hubspotClient.js))
   y el controlador lo persiste en el `SyncLog`
   ([lineItemPrice.controller.js:105](../../../src/interfaces/http/controllers/lineItemPrice.controller.js)),
   pero termina en **otra colección**, sin vínculo al evento, archivado bajo la llave
   `response_SAP` aunque el error sea de HubSpot, y en `errorMessage` en vez de `errors`
   (el controlador pasa el array como `errorMessage`
   [:110](../../../src/interfaces/http/controllers/lineItemPrice.controller.js) y
   `finishSyncLog` deja `errors: []`
   [syncLog.service.js:318](../../../src/infrastructure/sync/syncLog.service.js)).
   Diagnosticar un caso exige correlacionar dos colecciones por timestamp.

3. **El reintento de HubSpot se descarta como duplicado.** El controlador responde 500
   ([:120](../../../src/interfaces/http/controllers/lineItemPrice.controller.js)), así que
   HubSpot reintenta. Pero el filtro de duplicados de la rama de asociación
   ([:560](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js)) matchea el
   registro fallido y devuelve `skip: duplicate_event`. La estrategia hermana `dealPriceList`
   sí se protege con `$or: [{isSend:true},{errorMessage:null}]`
   ([dealPriceListLineItemPriceWebhook.service.js:206](../../../src/infrastructure/webhook/dealPriceListLineItemPriceWebhook.service.js)),
   con un comentario que dice explícitamente que un reintento tras fallo debe ejecutarse. La
   rama legacy no tiene ese guard. Es una asimetría, no una decisión documentada.

Ninguna capa reintenta un 404: el transporte sólo reintenta 429 y 5xx
([hubspotTransport.js:71](../../../src/infrastructure/hubspot/hubspotTransport.js) y
[:93](../../../src/infrastructure/hubspot/hubspotTransport.js)), y el `runWithRetry(retries:1)`
envuelve las escrituras batch, no estos GET.

### Causa probable del 404 (hipótesis del negocio)

El asesor de ventas quita líneas del deal. El índice de asociaciones de HubSpot queda
desfasado unos segundos, así que `GET deals/{id}?associations=line_items` sigue devolviendo el
id de una línea ya archivada, y el `GET line_items/{id}` siguiente responde 404. Encaja con
`changeSource: USER`, con lo intermitente y con la ventana de medio segundo. El audit de este
spec es lo que va a confirmarlo o descartarlo con datos.

### Por qué nadie lo detectó antes: tres copias del mismo paso

"Leer el deal y todas sus líneas" está implementado tres veces, con semánticas distintas:

| | Ubicación | Estilo | ¿Tolera fallo de una línea? |
|---|---|---|---|
| 1 | `lineItemPriceWebhook.service.js:105` `resolveLineItems` | `Promise.all` | **No** — lanza sin `hs_sku` (`:125`) |
| 2 | `lineItemPriceWebhook.service.js:276` `recalculateDealLineItemsFromMisc` | `Promise.all` | Sí — descarta y sigue (`:299`) |
| 3 | `SyncDealLineItemPricesByPriceList.js:125` | `for` secuencial | Sí — `skippedLineItems` (`:185`) |

Y "leer una línea → su deal" está dos veces:
`lineItemPriceWebhook.service.js:388` y `dealPriceListLineItemPriceWebhook.service.js:227`.

Historial: la ruta original nació el 2026-05-05 (`c87bd14`). La estrategia `dealPriceList`
se agregó el 2026-07-09 (`09bfdd2`) y en ese mismo commit se creó
`lineItemPriceWebhook.shared.js`, cuyo encabezado dice que se extrajo de la primera "sin
cambios de comportamiento". La extracción compartió las piezas chicas
(`fetchHubspotObject`, `extractAssociationIds`, `resolveHubspotCredentials`,
`buildDuplicateFilter`) y **no** la operación compuesta. Encima las dos estrategias leen
desde capas distintas: la vieja en infraestructura antes de armar el payload, la nueva dentro
del use case a través del puerto.

Resultado: la copia 1 es la única todo-o-nada de las tres, y es justo la que corre en el
cliente que reportó el problema.

## Objetivo

1. Que el fallo de una línea no bloquee a las demás, ni leyendo de HubSpot ni pidiendo
   precio a SAP.
2. Que el evento guarde un **audit log** que responda *por qué* falló, no sólo *qué* falló.
3. Que al cerrar el flujo se releen las líneas del deal y se reprocese lo que quedó sin
   precio, reutilizando lo que ya se trajo de SAP.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Dónde vive el audit | Campo nuevo `audit` en `LineItemPriceWebhookEvent` | Se diagnostica abriendo el evento que falló, sin joins ni correlación por timestamp. Mismo patrón que `WebhookEvent.sapAudit` (`WebhookEvent.js:48`) |
| Alcance del fallo parcial | Lectura de HubSpot **y** consulta a SAP | Hoy los dos tumban el deal completo; el segundo es el más frecuente en el día a día (ítem sin lista de precios) |
| `amount` del deal con líneas descartadas | Se escribe con lo que se pudo valorizar | Decisión del negocio: el deal queda con un total consistente con los precios visibles |
| Cuándo se escribe el `amount` | Una sola vez, al final, tras la reconciliación | Evita dos writes al deal y da el total más completo |
| Rondas de reconciliación | Exactamente una, dentro del request | Cubre el desfase del índice (segundos) sin volver impredecible la latencia de un webhook que HubSpot corta y reintenta |
| Caché de SAP | `Map<itemCode, {priceData, sapItemData}>` por invocación | La ronda 2 no vuelve a SAP por lo que ya trajo |
| Disparador de la reconciliación | Diferencia de conteo **o** `price = 0` no explicado por SAP | Un precio 0 legítimo de SAP no debe disparar trabajo |
| Guard de duplicados | Alinear con `dealPriceList` | Sin eso, un fallo transitorio es permanente |
| Migración de `dealPriceList` al lector compartido | **Fuera de alcance** | Ya tolera fallos parciales; no es urgente. Queda como deuda |
| Grabador de llamadas | Reutilizar `createSapCallRecorder` | Ya existe, probado en el flujo de cotizaciones, con noop para tests |

## Arquitectura

```
POST /webhooks/hubspot/line-items/prices
  │
  ├─ preparePayload (infra/webhook)          ronda 1: lectura tolerante
  │    └─ readDealLineItems ──> { lineItems, failures }
  │
  ├─ SyncLineItemPrices.execute (application)
  │    ├─ callRecorder = this.createSapCallRecorder()
  │    ├─ ciclo SAP tolerante ──> sapCache: Map<itemCode, {priceData, sapItemData}>
  │    ├─ batch update de line items + products
  │    ├─ ¿disparador? ──> ronda 2 (relee HubSpot, reusa sapCache, reescribe)
  │    ├─ updateDealAmount  (una sola vez, al final)
  │    └─ return { data, meta, audit }
  │
  └─ markAsSent / markAsError  ──> $set { isSend, errorMessage }
                               ──> $set { audit }     ← updateOne SEPARADO
```

El audit viaja por los dos canales que ya existen entre el use case y el controlador:
`result.audit` en éxito y `error.lineItemPriceAudit` en fallo — el mismo mecanismo que
`error.syncLogWebhookErrors` ya usa hoy
([SyncLineItemPrices.js:389](../../../src/application/use-cases/SyncLineItemPrices.js)).

## Componentes

### 1. `readDealLineItems` — nuevo, una implementación y dos entradas

Función exportada en `src/infrastructure/webhook/lineItemPriceWebhook.shared.js`:

```js
readDealLineItems(token, dealId, { properties })
  → { lineItems: [{ id, itemCode, quantity, ...extras }],
      failures:  [{ id, stage: 'hubspot_read', reason, status, endpoint }] }
```

Nunca lanza por una línea individual: envuelve cada `fetchHubspotObject` en su propio
`try/catch` y acumula. Sigue usando `Promise.all` (el paralelismo no es el problema; el
problema es que un rechazo mata al conjunto).

`HubspotLineItemPriceClient.readDealLineItems()` delega a esa función y se agrega al puerto
`HubspotLineItemPriceClientPort`
([line-item-price.port.js:33](../../../src/ports/line-item-price.port.js)), para que
`SyncLineItemPrices` la alcance sin que application importe infrastructure — restricción que
`tests/unit/architecture/hexagonalBoundaries.test.js` verifica.

Consumidores: `buildLegacyPayload`
([lineItemPriceWebhook.service.js:479](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js))
para la ronda 1, y `SyncLineItemPrices` vía puerto para la ronda 2.

`resolveLineItems` deja de lanzar `Deal has no associated line items` como efecto de una
línea mala; sigue lanzando cuando el deal no tiene **ninguna** línea asociada.
`buildLegacyPayload` devuelve además `lineItemFailures`, que el use case incorpora al audit.

### 2. Campo `audit` en el schema

`src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js`, junto a `dealId`
([:20](../../../src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js)):

```js
audit: { type: Schema.Types.Mixed, default: null }
```

Forma del contenido:

```js
{
  capturedAt, dealId, cardCode,
  rounds: [{
    round: 1,
    lineItemIdsFromDeal: ['58061514894', ...],   // lo que devolvió el índice de HubSpot
    priced:   [{ id, itemCode, price, source: 'sap' | 'cache' }],
    failures: [{ id, itemCode, stage, reason, status, endpoint }],
  }, {
    round: 2,
    trigger: ['count_mismatch'] | ['zero_price'] | ambos,
    ...mismas llaves
  }],
  calls: [{ target: 'hubspot' | 'sap', method, path, params, ok, status, durationMs,
            request?, response?, error? }],
  unresolved: [{ id, itemCode, reason }],
  amount: { written: bool, total },
}
```

`stage` es la llave del diagnóstico: `hubspot_read` (el 404 reportado), `sap_price` (ítem sin
lista de precios o inexistente en SAP), `hubspot_write` (la línea entró al batch y HubSpot la
rechazó).

### 3. `buildLineItemPriceAudit(auditTrail)` — nuevo, en `syncLog.service.js`

Serializa el audit reutilizando lo que ya existe para `buildWebhookSapAudit`
([syncLog.service.js:215](../../../src/infrastructure/sync/syncLog.service.js)):
`serializeLogValue`, `sanitizeAuditKeys` (`:93`), `truncateAuditBody` (`:133`) y
`buildErrorResponseSnapshot` (`:30`).

`sanitizeAuditKeys`, `serializeSapCalls` y `truncateAuditBody` son privadas hoy: hay que
exportarlas o generalizar. **No** se puede reutilizar `buildWebhookSyncErrorEntry` (`:45`):
no sanitiza claves.

**Volumen de llamadas.** El grabador corta en 40
([sapCallRecorder.js:19](../../../src/infrastructure/sap/sapCallRecorder.js)) y un deal de 20
líneas hace ~85 llamadas (1 deal + 1 company + 20 líneas + hasta 40 a SAP + 3 escrituras).
Regla: las llamadas **fallidas** se graban completas (request + respuesta del servidor); las
exitosas quedan como entrada compacta sin cuerpo de respuesta. El tope se sube a 200 para
esta ruta. Así el documento queda acotado sin perder el "por qué".

### 4. Grabador de llamadas en `SyncLineItemPrices`

Se sigue el patrón ya establecido en los use cases de cotización:

- constructor: `createSapCallRecorder = createNoopSapCallRecorder`
  (como [ProcessHubspotCreateQuotation.js:48](../../../src/application/use-cases/ProcessHubspotCreateQuotation.js))
- `execute()`: `const callRecorder = this.createSapCallRecorder()`
  (como [:72](../../../src/application/use-cases/ProcessHubspotCreateQuotation.js))
- composition inyecta el real en `line-item-prices.composition.js`
  ([:20](../../../src/composition/line-item-prices.composition.js))

`wrap()` no aplica: `SapLineItemPriceClient` llama a axios directo y no tiene `.request`
([SapLineItemPriceClient.js:45](../../../src/infrastructure/external-services/SapLineItemPriceClient.js)).
Se usa `record(options, run)` explícitamente alrededor de cada llamada a SAP y a HubSpot.

**Verificación de cableado obligatoria:** `grep` de `createSapCallRecorder` en
`line-item-prices.composition.js` después de implementar. Un parámetro de constructor sin
cablear pasa los tests con `expect.any(Object)`.

### 5. Caché de SAP por invocación

`Map<itemCode, { priceData, sapItemData }>` creado al inicio de `execute()`. Guarda las **dos**
llamadas que hoy se hacen por ítem: precio de business partner
([SyncLineItemPrices.js:193](../../../src/application/use-cases/SyncLineItemPrices.js)) y
stock/impuesto ([:240](../../../src/application/use-cases/SyncLineItemPrices.js)).

Clave `itemCode` sola: `cardCode` y `date` son fijos durante la invocación. Efecto
secundario deseado: hoy un deal con el mismo producto dos veces consulta SAP dos veces; con
la caché, una.

### 6. Clasificación de fallos

**Tolerable** — se descarta la línea, el evento sigue:

| Fallo | `stage` |
|---|---|
| 404 al leer una línea | `hubspot_read` |
| Línea sin `hs_sku` | `hubspot_read` |
| Ítem sin precio en la lista de SAP / inexistente en SAP | `sap_price` |
| Línea rechazada por el batch de HubSpot | `hubspot_write` |

**Fatal** — `errorMessage`, HTTP 500, HubSpot reintenta. Comportamiento **sin cambios**
respecto a hoy; lo único nuevo es que el audit dice cuál fue y con qué respuesta:

- falla el `GET deals/{id}` ([:486](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js))
- token inválido o credenciales ausentes ([lineItemPriceWebhook.shared.js:57](../../../src/infrastructure/webhook/lineItemPriceWebhook.shared.js))
- cero líneas valorizadas — igual que `SyncDealLineItemPricesByPriceList.js:218`

### 7. Reconciliación

Al final de `execute()`, **una sola ronda**:

```
lineasHS2 = releer el deal + cada línea con properties ['hs_sku','quantity','price']

disparador =
     lineasHS2.length !== actualizadasConExito.length         // (a) conteo
  || existe línea en lineasHS2 con price == 0 que NO esté
     explicada por un precio 0 en sapCache                    // (b) precio 0

si no hay disparador -> no se hace nada más

para cada línea que necesita trabajo:
    itemCode = hs_sku
    si sapCache tiene itemCode:
        reusar          (source: 'cache', CERO llamadas a SAP)
    si no:
        consultar SAP   (source: 'sap')  -> guardar en sapCache
batch update con lo obtenido
lo que siga sin resolver -> audit.unresolved
```

Casos que cubre el punto (b) usando la caché como árbitro:

| Estado | Acción |
|---|---|
| `price = 0` en HubSpot, caché dice 0 | Correcto, no se toca |
| `price = 0` en HubSpot, caché dice ≠ 0 | Nuestra escritura no aterrizó → reescribir **desde caché** |
| `price = 0` en HubSpot, itemCode no está en caché | Línea nueva o su llamada a SAP falló → consultar SAP |

El `amount` se calcula después de esto, sumando el `lineTotal` de todo lo valorizado entre
las dos rondas, y se escribe una sola vez
([SyncLineItemPrices.js:335](../../../src/application/use-cases/SyncLineItemPrices.js) se
mueve al cierre).

### 8. Guard de duplicados

El `$or: [{ isSend: true }, { errorMessage: null }]` se agrega **en el `findOne` de
`lineItemPriceWebhook.service.js:561`**, extendiendo el filtro que devuelve el helper:

```js
const duplicate = await LineItemPriceWebhookEvent.findOne({
  ...buildDuplicateFilter(payload),
  $or: [{ isSend: true }, { errorMessage: null }],
}).select({ _id: 1 }).lean();
```

**No** se toca `buildDuplicateFilter`
([lineItemPriceWebhook.shared.js:27](../../../src/infrastructure/webhook/lineItemPriceWebhook.shared.js)):
es compartido, y `dealPriceList` ya le agrega ese mismo `$or` por su cuenta
([dealPriceListLineItemPriceWebhook.service.js:206](../../../src/infrastructure/webhook/dealPriceListLineItemPriceWebhook.service.js));
ponerlo dentro del helper lo duplicaría en esa ruta.

Efecto: un reintento de HubSpot tras un fallo nuestro se ejecuta; un reenvío de un evento ya
exitoso o en vuelo sigue descartándose.

Nota sobre el índice único
([LineItemPriceWebhookEvent.js:31](../../../src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js)):
cubre los 6 campos del filtro, así que al reprocesar un reintento el `create` posterior
([:580](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js)) va a chocar con
`E11000`. El `catch` de `error.code === 11000` que ya existe
([:586](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js)) hoy responde
`skip: duplicate_event`, lo que anularía el arreglo. El reintento debe **reutilizar el
registro existente** (buscarlo y actualizarlo) en vez de crear uno nuevo.

## Manejo de errores

**El audit se escribe en un `updateOne` aparte** del que escribe `isSend`/`errorMessage`, en
`markAsSent` / `markAsError`
([:630](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js) y
[:646](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js)).

Motivo, y es un golpe ya recibido en este proyecto: el Mongo de producción es < 5.0 y rechaza
el `$set` **completo** si encuentra una clave con `$` al inicio. El `$select` de OData va justo
en `params`. Si audit y `errorMessage` viajan en el mismo `$set`, un audit malo se lleva
puesto el `errorMessage` — exactamente lo que pasó con `sapAudit`
(ver `2026-08-06-webhook-sap-audit-design.md`, sección "Claves que MongoDB rechaza").
Doble defensa: `sanitizeAuditKeys` sobre todo el audit, y escritura separada.

`buildLineItemPriceAudit` no puede lanzar: envuelto en `try/catch` que devuelve `null`, igual
que `buildWebhookSapAudit`
([syncLog.service.js:248](../../../src/infrastructure/sync/syncLog.service.js)). Un audit
roto nunca puede impedir que el evento registre su resultado.

El `SyncLog` sigue escribiéndose como hoy. No se corrige el `errorMessage` vs `errors` ni la
llave `response_SAP` para un error de HubSpot: queda como deuda anotada, porque el audit del
evento pasa a ser la fuente de diagnóstico.

## Lo que no cambia

- La estrategia `dealPriceList` y `SyncDealLineItemPricesByPriceList`: intactas.
- El flujo `line_item.propertyChange` (modos `Legacy` y `SkippedVersion`) y su debounce.
- La ruta legacy con `payload.lineItems` en el cuerpo
  ([:501](../../../src/infrastructure/webhook/lineItemPriceWebhook.service.js)): sigue
  aceptando líneas ya resueltas sin pasar por `readDealLineItems`.
- El contrato HTTP: mismos códigos, mismo `resolveStatusCode`.
- El transporte y el rate limiter de HubSpot.

## Testing

Unitarios sobre `SyncLineItemPrices`, con dobles de los puertos:

- una de tres líneas da 404 al leerse → las otras dos se escriben, la fallida queda en
  `audit.rounds[0].failures` con `stage: 'hubspot_read'`
- SAP sin precio para una línea → las demás siguen, `stage: 'sap_price'`
- cero líneas valorizadas → lanza
- reconciliación **no** se dispara cuando conteo y precios cuadran (cero llamadas extra)
- se dispara por diferencia de conteo
- se dispara por `price = 0` no explicado por la caché
- **no** se dispara cuando el 0 viene de SAP
- la ronda 2 no llama a SAP para itemCodes que ya están en caché (`source: 'cache'`)
- el `amount` se escribe una sola vez y suma las dos rondas
- un `itemCode` repetido en dos líneas consulta SAP una sola vez

Sobre `lineItemPriceWebhook.service.js`:

- un reintento de HubSpot tras un fallo previo **no** se descarta como duplicado
- un reenvío de un evento exitoso sí se descarta
- un reintento reutiliza el registro existente en vez de crear uno nuevo, y **no** termina en
  la rama `E11000 → duplicate_event` (este test es el que prueba que el arreglo del guard
  sirve de algo; sin él, el índice único lo anula)
- el audit se persiste en su propio `updateOne`, y un audit que Mongo rechaza no impide que
  `errorMessage` se guarde

Sobre `buildLineItemPriceAudit`: claves con `$` se prefijan, `@odata.*` se descartan, cuerpos
grandes se truncan, y un `auditTrail` circular devuelve `null` sin lanzar.

Arquitectura: `tests/unit/architecture/hexagonalBoundaries.test.js` debe seguir pasando —
`SyncLineItemPrices` no importa infrastructure.

`npx jest` necesita `--experimental-vm-modules`.

## Verificación

Con el tenant de pruebas y la estrategia `businessPartner` activa:

1. Deal con 3 líneas, una con un `hs_sku` que no existe en SAP → las otras 2 cargan precio,
   el evento queda `isSend: true`, y `audit.rounds[0].failures` tiene la tercera con
   `stage: 'sap_price'`.
2. Deal con 2 líneas, quitar una desde la UI y volver a agregar otra en la misma ráfaga →
   revisar si aparece un `hubspot_read` con status 404 en el audit. **Esto es lo que confirma
   o descarta la hipótesis del índice desfasado.**
3. Deal cuyas líneas quedan todas con precio → `audit.rounds` tiene un solo elemento (la
   reconciliación no se disparó).
4. Verificar en Mongo que el documento del evento tiene `audit` poblado y que ningún `$set`
   fue rechazado (revisar `logs/app.log`).

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Colección nueva `LineItemPriceWebhookAudits` | Diagnosticar exigiría dos consultas y mantener el vínculo al evento |
| Arreglar sólo el `SyncLog` existente | El diagnóstico sigue en dos colecciones y `SyncLogs` mezcla precios con todas las demás sincronizaciones |
| Reconciliación en el controlador | Convierte el controlador (ya con 100 líneas de `try/catch`) en orquestador de negocio y deja la lógica fuera de los tests del use case |
| Bucle de reconciliación hasta que no haya progreso | El tiempo de respuesta pasaría a depender de cuántas líneas fallen; HubSpot corta los webhooks lentos y los reintenta, generando trabajo duplicado |
| Reconciliación diferida en un worker | Es lo más robusto contra el desfase, pero mete infraestructura de cola en un flujo hoy puramente sincrónico |
| Detectar "sin precio" mirando sólo `price` en HubSpot | Un 0 puede ser legítimo. La caché de SAP es la que desambigua |
| Tolerar también los fallos "fatal" | Marcaría como bueno un evento que no hizo nada — justo el escenario en que el cliente dice "no cargó" y el sistema dice que todo salió bien |
| `recorder.wrap()` para SAP | `SapLineItemPriceClient` no tiene `.request`; se usa `record()` directo |
| Reutilizar `buildWebhookSyncErrorEntry` para el audit | No sanitiza claves con `$`; el `$select` de OData rompería la escritura |
| Parchear sólo el `Promise.all` de la copia 1 | Dejaría tres semánticas distintas del mismo paso y el hueco se reabre con la próxima estrategia |

## Fuera de alcance (deuda anotada)

1. **Migrar `dealPriceList` al lector compartido.** Ya tolera fallos parciales
   (`skippedLineItems`), así que no es urgente. Mientras no se haga, conviven dos
   implementaciones de "leer el deal y sus líneas". Decisión explícita del 2026-08-17:
   primero se arregla la ruta que falla, la arquitectura correcta se aborda después.
2. **Unificar las tres copias** (incluida `recalculateDealLineItemsFromMisc`) y las dos de
   "línea → su deal".
3. **`errors` vs `errorMessage` en el `SyncLog`** y la llave `response_SAP` para errores de
   HubSpot.
4. **El controlador sólo procesa `req.body[0]`**
   ([lineItemPrice.controller.js:38](../../../src/interfaces/http/controllers/lineItemPrice.controller.js)).
   HubSpot agrupa eventos en un array; los demás se descartan. En este flujo se disimula
   porque cada evento recalcula todo el deal, pero es un hueco real.
