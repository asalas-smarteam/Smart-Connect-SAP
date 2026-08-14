# Auditoría completa de tráfico SAP en WebhookEvent

Fecha: 2026-08-06

## Problema

Cuando un webhook falla, no hay forma de ver qué se le mandó a SAP ni qué respondió. El
documento del `WebhookEvent` guarda el payload de HubSpot completo, pero del lado de SAP
guarda un subconjunto inconsistente:

- `payload.payloadSAP` — solo el payload de la orden, y solo si el use case lo propaga.
- `payload.payloadBPSAP` / `payload.responseBPSAP` — solo en la ruta `createDeal`.
- `payload.sapResult` — solo `docEntry`/`docNum`/`cardCode`.

Nada de eso incluye la **respuesta** de SAP al crear la orden o la cotización. Y la
propagación es asimétrica entre use cases: de los cuatro, solo dos cuelgan el payload de
SAP en el error. Un evento `createQuotation` que falla queda con `status`, `retries` y
`lastError`, y nada más — no se puede diagnosticar sin reproducir.

El dato existe: los cuatro use cases ya construyen un `auditTrail` completo en memoria. El
problema es que solo escapa por un camino (el `catch`, hacia el `SyncLog` de la corrida
entera) y en éxito se descarta.

## Objetivo

Que cada `WebhookEvent` guarde, además del payload de HubSpot, **todo el tráfico con SAP**:
lo que se envía y lo que responde, para BusinessPartner, ContactEmployee y el documento
(orden o cotización), tanto si el evento termina en éxito como en error.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Dónde vive | Campo nuevo `sapAudit`, de primer nivel | `payload` vuelve a significar solo "lo que llegó de HubSpot"; todo lo de SAP queda junto y ordenado por documento |
| Cuándo se escribe | Una sola escritura al cerrar el evento | Una escritura por evento; el marcador de recuperación ante caídas ya existe aparte |
| Reintentos | El último intento sobrescribe | Coherente con `lastError` y `sapResult`; el documento no crece con los reintentos |
| Alcance | Los 4 use cases de webhook | `createDeal`, `createQuotation`, `updateQuotation`, `convertQuotationToOrder` |
| Claves viejas | Dejar de escribirlas | `sapAudit` las cubre completas; se verificó que ningún código las lee |

## Arquitectura

El `auditTrail` pasa de variable local a vehículo único, y sale por los dos canales que ya
existen entre los use cases y el repositorio:

```
use case ──éxito──> return { cardCode, docEntry, docNum, sapAudit }
                             └─> ProcessWebhookDealEventBatch ─> markCompleted ─> $set sapAudit

use case ──error──> throw error con error.sapAudit
                             └─> ProcessWebhookDealEventBatch ─> markFailed ─> $set sapAudit
```

Es el mismo mecanismo de `result.payloadSap` y `error.sapOrderPayload` que ya existe, pero
completo y presente en los cuatro use cases. Eso cierra de raíz la asimetría de propagación
en vez de parchearla caso por caso.

## Componentes

### 1. `buildWebhookSapAudit(auditTrail)` — nuevo

Ubicación: `src/infrastructure/sync/syncLog.service.js`, junto a `buildWebhookSyncErrorEntry`.

Va en infrastructure porque reutiliza `serializeLogValue` (ya existe ahí, y maneja
instancias de `Error`, `undefined` y estructuras circulares). Se **inyecta** a los use cases
por constructor, igual que ya se inyectan `buildWebhookSyncErrorEntry` y
`buildErrorResponseSnapshot` — `application` no puede importar de `infrastructure`, y
`tests/unit/architecture/hexagonalBoundaries.test.js` lo verifica.

Recibe el `auditTrail` del use case y devuelve la forma persistible:

```js
{
  payloadSap:  { businessPartner, contactEmployee, order, quotation },
  responseSap: { businessPartner, contactEmployee, order, quotation },
  responseHubspot,
  capturedAt   // ISO string
}
```

Las claves que no aplican al tipo de evento quedan en `null` (una cotización no tiene
`order`). La forma es siempre la misma para que se lea igual en todos los eventos.

Nunca lanza: si `serializeLogValue` falla sobre algún fragmento, ese fragmento cae a `null`
en lugar de propagar la excepción. Una falla al auditar no puede tumbar el procesamiento.

### 2. Campo `sapAudit` en el schema

`src/infrastructure/database/models/tenant/WebhookEvent.js`:

```js
sapAudit: {
  type: Schema.Types.Mixed,
  default: null,
}
```

Campo de primer nivel, hermano de `payload`. `Mixed` porque la forma varía por tipo de
evento y las respuestas de SAP son documentos arbitrarios.

### 3. Persistencia

`src/infrastructure/repositories/MongooseWebhookEventRepository.js`:

- `markCompleted(event, result)` — si `result.sapAudit` viene, lo incluye en el `$set`.
- `markFailed(event, failure)` — si `failure.sapAudit` viene, lo incluye en el `$set`.

Ambos siguen el patrón condicional que ya usan para `payloadSap` y `sapResult`: si no viene,
no se escribe la clave (no se pisa con `null` lo que ya había).

### 4. Propagación en los cuatro use cases

Cada uno construye `sapAudit = this.buildWebhookSapAudit(auditTrail)` y lo saca por ambos
caminos:

| Use case | `return` (éxito) | `catch` (error) |
|---|---|---|
| `ProcessHubspotWebhookEvent` | agregar `sapAudit` | agregar `error.sapAudit` |
| `ProcessHubspotCreateQuotation` | agregar `sapAudit` | agregar `error.sapAudit` |
| `ProcessHubspotUpdateQuotation` | agregar `sapAudit` | agregar `error.sapAudit` |
| `ProcessHubspotConvertQuotationToOrder` | agregar `sapAudit` | agregar `error.sapAudit` |

En el `catch`, la asignación de `error.sapAudit` va **antes** de armar
`error.syncLogWebhookErrors`, dentro de su propio `try/catch` que traga cualquier fallo: si
auditar falla, se propaga el error original de SAP, nunca el error del auditor.

### 5. Cableado en el batch

`src/application/use-cases/ProcessWebhookDealEventBatch.js` pasa el audit al repositorio en
los tres caminos terminales:

- éxito → `markCompleted(event, result)` (el `result` ya lo trae).
- error normal → `markFailed(event, { ..., sapAudit: error.sapAudit ?? null })`.
- error post-creación en SAP (`sapOrderCreated` y `handlePostSapBookkeepingFailure`) → igual.

### 6. Claves que dejan de escribirse

- `payload.payloadSAP` — cubierta por `sapAudit.payloadSap.order` / `.quotation`.
- `payload.payloadBPSAP` — cubierta por `sapAudit.payloadSap.businessPartner`.
- `payload.responseBPSAP` — cubierta por `sapAudit.responseSap.businessPartner`.

Se verificó por búsqueda en todo el repo que ningún código las lee: son de solo escritura.
Los documentos existentes las conservan; los nuevos quedan sin el dato duplicado.

`MongooseWebhookEventProgressRepository.markBusinessPartnerCreated` queda sin contenido útil
tras esto, así que se elimina junto con su llamada.

## Lo que no cambia

`payload.sapResult`, `status: 'sap_order_created'` y `payload.sapOrderCreatedAt` se
mantienen. **No son auditoría, son el marcador de recuperación** que evita duplicar una orden
en SAP si el proceso muere después de crearla. `markOrderCreated` sigue existiendo con ese
único propósito.

Tampoco cambia el `SyncLog`: sigue recibiendo `error.syncLogWebhookErrors` como hoy.

## Manejo de errores

Auditar es una función de soporte y nunca puede degradar el procesamiento:

- `buildWebhookSapAudit` no lanza. Ante un fragmento no serializable, ese fragmento cae a
  `null`.
- Si `sapAudit` no llega al repositorio, `markCompleted`/`markFailed` escriben igual el resto
  y el evento cierra normal.
- La construcción del audit en el `catch` de cada use case va protegida para no sustituir el
  error original.

## Testing

**Unitarios nuevos** — `tests/unit/infrastructure/webhookSapAudit.test.js`:
- forma completa: BP + contactEmployee + orden, request y response
- claves no aplicables en `null` (cotización sin `order`)
- estructura circular en una respuesta de SAP → no lanza, degrada a `null`
- `auditTrail` vacío o `null` → devuelve la forma con todo en `null`

**Por use case** (extender los archivos existentes de cada uno):
- éxito: el `return` incluye `sapAudit` con el payload y la respuesta del documento creado
- error: `error.sapAudit` viene poblado con lo que sí alcanzó a pasar antes de fallar
- regresión del caso real: un `createQuotation` que falla con el error de numbering series
  guarda el payload de la cotización que se intentó crear

**Repositorio** — extender `tests/unit/infrastructure/mongooseWebhookEventRepository.test.js`:
- `markCompleted` escribe `sapAudit` cuando viene; no escribe la clave cuando no viene
- `markFailed` igual

**Batch** — extender `tests/unit/application/processWebhookDealEventBatch.test.js`:
- `error.sapAudit` llega a `markFailed` en los tres caminos terminales

## Verificación

```bash
npm test
```

Línea base conocida: 6 suites / 12 tests fallando de antes (`sendMappedItemsToHubspot`,
`lineItemPriceWebhook.service`, `syncLineItemPrices`, `serviceLayerService`,
`serviceLayerFlow`, `integration/internalTenant`). Cualquier otra suite en rojo es regresión.

**End to end**: encolar un `createQuotation` que falle en SAP y otro que tenga éxito, correr
`POST /sap-sync/runWebHook` con `{"tenantID": "sap_integration_printer"}`, y confirmar en
Mongo que ambos documentos traen `sapAudit` con `payloadSap.quotation` y `responseSap`
poblados — el que falla debe mostrar el payload que se intentó mandar.

## Corrección posterior (2026-08-13): la llamada que falla también se audita

El diseño de arriba llena el `auditTrail` con el valor de **retorno** de cada adapter, así que
la llamada que lanza no deja rastro. Un `createDeal` real quedó en Mongo con
`lastError: "(1) SP - ERROR - el subgrupo NO es valido para este cliente."` y `sapAudit: null`:
el `POST /BusinessPartners` fue rechazado por un stored procedure de SAP y su payload murió
dentro de `findOrCreateBusinessPartner`, antes de las asignaciones a
`auditTrail.payload_SAP.businessPartner`. Con el trail vacío, `buildWebhookSapAudit` devuelve
`null` por diseño y `markFailed` omite la clave.

Se agrega un grabador a nivel de transporte, `createSapCallRecorder`
(`src/infrastructure/sap/sapCallRecorder.js`), inyectado por composition a los 5 use cases:

- `wrap(adapter)` devuelve una vista por evento del adapter con `request` interceptado
  (`Object.create`, así que el resto de los métodos y los `this.request` internos siguen
  igual). Los adapters son singletons en composition, por eso no puede ser una dependencia
  de constructor.
- `sapAudit.sapCalls` es la lista de llamadas: `method`, `path`, `params`, `request`, `ok`,
  `status`, `durationMs`, y `response` o `error` (con el mensaje ya resuelto de SAP, el mismo
  texto que `lastError`).
- La graba **antes** de saber si va a fallar, así que la llamada rechazada queda completa.
- Efecto colateral buscado: quedan registradas las llamadas cuyo error se traga a propósito
  (`updateBusinessPartnerFields` / `updateContactEmployeeFields` devuelven `{ error }` para no
  bloquear la creación del documento).
- Nunca graba headers: la cookie de sesión viaja ahí y el login sucede dentro del transporte,
  fuera de `request`.
- Topes defensivos, porque el `$set` que guarda `sapAudit` es el mismo que guarda `lastError`
  y no puede pasarse del límite de Mongo: 40 llamadas por evento (`droppedCalls` cuenta el
  resto) y 20 000 caracteres por cuerpo serializado (se reemplaza por
  `{ truncated, originalLength, preview }`).

### Claves que MongoDB rechaza (bug del primer intento)

La primera versión del grabador guardaba `params` como objeto, y el `$set` se cayó entero:

```
The dollar ($) prefixed field '$select' in 'sapAudit.sapCalls.0.params.$select'
is not valid for storage.
```

Mongo rechaza el `$set` **completo** por una sola clave inválida, así que no se perdió solo la
auditoría: se perdieron `status`, `retries` y `lastError`. Dos eventos con la orden ya creada
en SAP (DocEntry 565527 y 565528) quedaron colgados en `sap_order_created`, porque falló
`markCompleted` y después también el `markFailed` de `handlePostSapBookkeepingFailure`.

Dos defensas, una en cada capa:

1. **Al construir el audit** (`sync/syncLog.service.js`): `params` se guarda como query string
   (`$top=1&$select=CardCode&$filter=...`), que además se lee mejor. Y `sanitizeAuditKeys`
   (antes `stripODataKeys`) sanea toda clave de todo cuerpo: descarta `@odata.*`, prefija con
   `_` las que empiezan con `$`, y reemplaza `.` por `_`.
2. **Al persistir** (`MongooseWebhookEventRepository.applyUpdates`): si el `$set` con
   `sapAudit` es rechazado, se reintenta sin él y se loguea. El estado del evento siempre se
   guarda; el audit es lo único sacrificable.

Cuidado al testear esto: `mongodb-memory-server` corre MongoDB >= 5.0, que **sí** acepta
claves con `$` prefijado, así que un test de integración contra él no ve el rechazo (el
servidor del cliente es anterior). Lo que sí se verifica contra un mongod real en
`tests/integration/webhookSapAuditPersistence.test.js` es que lo persistido no lleve ninguna
de esas claves; el reintento se cubre con dobles en la suite unitaria del repositorio.

### Eventos saltados por idempotencia (`skipped`)

Tercer síntoma del mismo día: 13 `createQuotation` cerraron en `completed` con `sapAudit: null`.
No era un fallo — los 13 tomaron el atajo de idempotencia ("Quotation already exists for deal,
skipping creation", visible en `logs/app.log`) porque las cotizaciones ya existían de una
corrida anterior. No hubo **ninguna** llamada a SAP, así que no había tráfico que auditar; y
además esos `return` tempranos no incluían `sapAudit`.

Un `null` ahí es indistinguible de "la auditoría está rota", así que ahora los tres flujos con
idempotencia (`createQuotation`, `convertQuotationToOrder`, `inventoryTransferRequest`) marcan
`auditTrail.skipped = { reason, sapDocEntry, sapDocNum }` antes del `return`, y
`buildWebhookSapAudit` lo devuelve como registro real (`skipped` cuenta como contenido, igual
que `sapCalls`). El documento dice explícitamente que no se mandó nada y por qué.

`sapAudit` sigue siendo `null` únicamente cuando el evento falla antes de la primera llamada a
SAP y sin haber saltado nada.

Consecuencia para probar el audit: reencolar un deal que ya tiene su documento en SAP **no**
ejercita nada. Hace falta un deal sin `SapDocumentLink` (uno nuevo), o borrar el link a mano
sabiendo que eso crea un documento duplicado en SAP.

`payloadSap` / `responseSap` se mantienen como resumen por documento; `sapCalls` es el
tráfico crudo y es lo único que sobrevive a una llamada que lanza. `sapAudit` sigue siendo
`null` cuando el evento falla **antes** de la primera llamada a SAP (por ejemplo un
`PermanentWebhookError` de `CardName` faltante), porque ahí no hubo nada que auditar.

Los use cases construidos sin la dependencia (tests directos) usan
`createNoopSapCallRecorder` (`src/application/services/sap-call-audit.service.js`) y se
comportan como antes. Como ese default puede tapar un olvido de cableado,
`tests/unit/composition/webhookProcessingComposition.test.js` verifica por comportamiento que
los 5 use cases de composition reciben el grabador real.

## Fuera de alcance

- Los flujos de precios de line items (`SyncLineItemPrices`,
  `SyncDealLineItemPricesByPriceList`): no crean documentos en `WebhookEvents`, así que no
  tienen dónde colgar el `sapAudit`. Su auditoría sigue en el `SyncLog`.
- Historial de intentos: cada reintento sobrescribe el `sapAudit` anterior.
- Migración de documentos existentes: los viejos conservan las claves viejas.
- Política de retención o purga de auditorías.
