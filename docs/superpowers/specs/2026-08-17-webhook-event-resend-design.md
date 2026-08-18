# Reenvío de webhooks de HubSpot tras un fallo definitivo

Fecha: 2026-08-17

## Problema

Cuando un webhook de HubSpot falla en la integración con SAP, el tenant corrige la data en
HubSpot y quiere reenviar el mismo documento (orden, cotización, transferencia de inventario).
Hoy eso es imposible por dos motivos independientes, uno en cada lado:

**En el integrador.** `findDuplicateEvent` busca por `eventType + payload.deal.hs_object_id`
sin mirar el estado del evento (`src/infrastructure/webhook/webhookEvent.service.js:15-26`), así
que cualquier segundo envío para el mismo deal se traga como duplicado. Además hay un índice
único de Mongo sobre esa misma llave con `partialFilterExpression: { eventType: 'createDeal' }`
(`src/infrastructure/database/models/tenant/WebhookEvent.js:65-77`), o sea una garantía dura de
base de datos que impide siquiera insertar un segundo evento de `createDeal` por deal.

**En HubSpot.** El envío lo hace una acción de código personalizado (Operations Hub Professional)
dentro de un workflow disparado por etapas del pipeline. Una vez que el workflow se ejecutó no
se vuelve a ejecutar, y devolver el deal a una etapa anterior para forzar el re-enrollment no es
viable: hay pipelines donde no se puede retroceder.

Un tercer hecho, menos visible, condiciona todo el diseño: **el payload es una foto**.
`ProcessHubspotWebhookEvent` lee `deal`, `company`, `contact`, `lineItems`, `contactEmployees` y
`bpAddress` del payload guardado (`src/application/use-cases/ProcessHubspotWebhookEvent.js:65`) y
nunca vuelve a consultar HubSpot. Por lo tanto un mecanismo que solo "revive" el evento viejo
mandaría a SAP exactamente la misma data mala. **El reenvío tiene que traer un payload fresco
desde HubSpot.**

## Alcance

| Tipo de webhook | Regla nueva de dedup + índice | Propiedad de estado |
|---|---|---|
| `createDeal` | Sí | Sí |
| `createQuotation` | Sí | Sí |
| `convertQuotationToOrder` | Sí | Sí |
| `inventoryTransferRequest` | Sí | Sí |
| `updateQuotation` | **No** | Sí |
| Precios de line items | No aplica | No |

`updateQuotation` queda fuera del cambio de dedup **a propósito**. Hoy no está en
`DEDUPLICATED_EVENT_TYPES` (`src/infrastructure/webhook/webhookEvent.service.js:4-9`) porque una
cotización se actualiza muchas veces y cada envío es legítimo, así que el reenvío ya funciona ahí
desde siempre. Aplicarle la regla nueva le **agregaría** una restricción que hoy no tiene: la
segunda actualización de una cotización que ya sincronizó bien quedaría bloqueada porque el evento
anterior está `completed`. Es una asimetría deliberada y no hay que "completarla" por prolijidad.

El webhook de precios de line items (`/webhooks/hubspot/line-items/prices`) no necesita exclusión
explícita: escribe en otro modelo y otra colección, `LineItemPriceWebhookEvents`
(`src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js:27`), y nunca pasa por
este flujo.

## Qué habilita el reenvío

Solo el estado `errored`. Es el único que garantiza que **no hay documento en SAP**:

- `errored` se pone cuando se agotaron los retries o el error fue permanente, siempre antes de
  crear el documento (`src/application/use-cases/ProcessWebhookDealEventBatch.js:286-300`).
- `sap_created_hubspot_error` se pone cuando SAP **sí** creó el documento y falló algo posterior
  (`src/application/use-cases/ProcessWebhookDealEventBatch.js:261-283`). Reprocesarlo correría el
  flujo completo otra vez y crearía un segundo documento en SAP. **No es reenviable por esta vía.**
  Se marca distinto en HubSpot para que el asesor sepa que tiene que escalar a soporte.
- `waiting`, `inprocess`, `sap_order_created` y `completed` bloquean por razones obvias: hay
  trabajo en curso o ya está hecho.

El fallo parcial de `ContactEmployee` no entra en este diseño. Por defecto la config
`bypassSapErrors` falla cerrado (`src/infrastructure/config/sapErrorBypass.config.js`), así que
un `ContactEmployee` rechazado lanza `PermanentWebhookError` **antes** de `createOrder`
(`src/application/use-cases/ProcessHubspotWebhookEvent.js:281-285`): o se crea todo en SAP o no se
crea nada, y el evento queda `errored`, o sea reenviable. El camino de éxito parcial
(`src/application/use-cases/ProcessWebhookDealEventBatch.js:143-170`) solo existe cuando el tenant
prendió el bypass a propósito, y en ese caso `Completado` es el valor honesto: el cliente decidió
que ese error se indulta.

## Diseño

### 1. Regla de dedup

Se reemplaza la consulta sin filtro de estado por una que bloquea salvo que **todo lo existente
esté en `errored`**:

```js
findOne({
  eventType,
  'payload.deal.hs_object_id': dealId,
  status: { $ne: 'errored' },
})
```

Si encuentra algo → duplicado, se traga como hoy. Si no encuentra nada → se inserta un evento
nuevo. Eso cubre de un golpe el primer envío (no existe nada) y el reenvío legítimo (solo hay
`errored`).

La formulación es por exclusión (`$ne: 'errored'`) y no por lista blanca a propósito: si mañana
alguien agrega un estado al enum de `WebhookEvent` y se olvida de este archivo, el default es
**bloquear**, que es el lado seguro del error.

### 2. Evento nuevo, no reciclado

El documento viejo **no se toca**: queda en `errored` con su `lastError` y su `sapAudit` completo,
y eso es el log de intentos. El evento nuevo se crea como cualquier otro, con los defaults del
schema (`retries: 0`, `lastError: null`), sin campos de trazabilidad cruzada. El reenvío es una
sola escritura, un `insert`, así que no aparece la pregunta de qué pasa si el insert funciona y un
update posterior falla — no hay transacciones disponibles.

### 3. Índice único nuevo

El índice viejo de `createDeal` tiene que desaparecer, porque a partir de ahora un `dealId` va a
existir varias veces. Pero es la **única** garantía dura que protege al flujo de órdenes:
`ProcessHubspotWebhookEvent` no escribe `SapDocumentLink`, así que ese flujo no tiene la red del
índice único `(hubspotCredentialId, dealId, documentType)`
(`src/infrastructure/database/models/tenant/SapDocumentLink.js:63-70`) que sí protege a cotización,
conversión y transferencia. Quitarlo sin reemplazo dejaría menos protección que hoy.

Se reemplaza por un campo `dedupActive` en `WebhookEvent` y un índice único parcial sobre él:

```js
{ eventType: 1, 'payload.deal.hs_object_id': 1, dedupActive: 1 }
partialFilterExpression: {
  dedupActive: true,
  'payload.deal.hs_object_id': { $exists: true },
}
unique: true
```

`dedupActive` va **dentro de la llave** además del filtro parcial, y eso es deliberado. MongoDB no
acepta dos índices con el mismo patrón de llave que difieran solo en el `partialFilterExpression`
(está anotado en `src/infrastructure/database/models/tenant/WebhookEvent.js:59-64`), así que si el
índice nuevo usara la misma llave que el viejo no podrían coexistir y habría que tumbar el viejo
antes de crear el nuevo — dejando una ventana sin ninguna garantía dura sobre `createDeal`.
Agregando `dedupActive` a la llave el patrón es distinto, los dos índices conviven, y la migración
puede crear el nuevo antes de tumbar el viejo. Semánticamente no cambia nada: el filtro parcial ya
pinta `dedupActive: true` en todos los documentos indexados, así que la unicidad sobre la terna es
la misma que sobre el par.

`dedupActive` significa *"este documento ocupa hoy el cupo de dedup de su (eventType, dealId)"*:
vale `true` cuando el tipo participa del dedup **y** el estado no es `errored`. Para
`updateQuotation` no se escribe nunca, y por eso el índice no necesita excluir ese tipo — sus
documentos simplemente no entran. La lista de tipos sigue viviendo solo en
`DEDUPLICATED_EVENT_TYPES`; no hay una segunda lista que se pueda desincronizar.

La cláusula `$exists` no es decorativa: los documentos con `status: 'report'` viven en esta misma
colección y no tienen deal, así que sin ella todos colisionarían entre sí en la llave
`(eventType, null)`. El índice actual ya la trae por el mismo motivo.

Resultado: Mongo garantiza **a lo sumo un evento no-`errored` por (eventType, dealId)** para los
cuatro tipos, no solo para `createDeal`. Más protección dura que hoy.

`dedupActive` se escribe en dos lugares y nada más: al insertar en `queueWebhookEvent`, y en
`markFailed` del repositorio (`src/infrastructure/repositories/MongooseWebhookEventRepository.js:100`),
donde ya se decide el status.

En `markFailed` se **calcula a partir del status** (`status !== 'errored'`), no se pone en `false` a
secas. Importa porque `markFailed` se llama con tres estados distintos: `errored`,
`sap_created_hubspot_error`, y también `waiting` en el camino de liberación de
`safelyHandleProcessingError` (`src/application/use-cases/ProcessWebhookDealEventBatch.js:193-198`).
Si ese último dejara `dedupActive: false`, un evento que sigue en cola liberaría su cupo de dedup y
un segundo envío podría insertarse en paralelo. Los demás caminos de estado — `markCompleted`,
`claimWaiting` a `inprocess`, `markOrderCreated` a `sap_order_created` — no tocan el campo porque
todos mantienen `dedupActive: true`.

### 4. Propiedad de estado en HubSpot

Un desplegable en el deal, `sap_integration_status`, con cuatro valores que ciclan:

| Valor | Quién lo escribe | Cuándo |
|---|---|---|
| `Completado` | El integrador | El evento quedó `completed` |
| `Error — reintentar` | El integrador | El evento quedó `errored`. **Único valor que habilita el reenvío** |
| `Error — revisar con soporte` | El integrador | El evento quedó `sap_created_hubspot_error` |
| `Reintentar` | El asesor, a mano | Después de corregir la data. Dispara el workflow de reintento |

El ciclo cierra solo: el asesor solo pasa de `Error — reintentar` a `Reintentar`, y el que devuelve
el valor a `Error — reintentar` es el integrador, que es el único que sabe de verdad que volvió a
fallar. No hay forma de que quede trabada en un valor que ya no dispara, que es lo que rompe la
versión con un simple checkbox.

No hay valor `Procesando`. El workflow original no toca la propiedad, solo manda el fetch: el
integrador es el único que escribe estados, salvo el `Reintentar` del asesor.

**Creación de la propiedad.** Se agrega a `tenantHubspotSeed.service.js:205-210`, junto a
`sap_docentry` y `sap_docnum`. Ese seed corre en el callback de OAuth y usa `ensureObjectProperty`,
que es idempotente y ya soporta `enumeration` con opciones (ver `tipo_cliente`). Los tenants ya
instalados necesitan reconectar OAuth o una corrida puntual del seed.

**Configuración por tenant.** Va en el mismo documento `Configuration` de `requireMessageHS`, que
ya guarda `requiereReturnStage` y `stageToReturned`
(`src/infrastructure/config/webhookFailureNotification.config.js:3-7`). Es la misma familia: qué
hacemos en HubSpot cuando un webhook termina. Se agregan el nombre interno de la propiedad y los
tres valores que escribe el integrador, para que un tenant con su propia propiedad de estado la
pueda reusar en vez de que le impongamos la nuestra. El valor `Reintentar` no se configura acá:
solo lo escribe el asesor y solo lo lee el workflow de HubSpot, el integrador nunca lo toca.

La normalización sigue el patrón de `sapErrorBypass.config.js`: **falla apagado**. Si falta el
nombre de la propiedad o alguno de los valores, la función queda desactivada y el comportamiento es
idéntico al de hoy. No se escribe una propiedad a medias.

**Dónde escribe el integrador.** Un servicio nuevo, hermano de `notifyWebhookFailure`, invocado
desde `ProcessWebhookDealEventBatch` en sus tres puntos terminales: `markCompleted` OK, `errored`,
y `sap_created_hubspot_error`. Un solo lugar, cubre los cinco tipos de evento, y sigue el mismo
patrón de efecto de lado que ya tiene el notifier
(`src/infrastructure/hubspot/webhookFailureNotifier.service.js:1-3`): **nunca puede tirar hacia
arriba**, porque el bookkeeping ya pasó y un hipo de HubSpot no puede corromperlo.

### 5. Lado de HubSpot

Un workflow nuevo con re-enrollment sobre `sap_integration_status = Reintentar`, cuya acción de
código personalizado es la misma que ya existe: lee los objetos ligados al deal y hace el fetch al
API. Como el payload se arma de cero en cada corrida, la data corregida llega sola. No requiere
mover etapas ni una UI extension.

Alternativas descartadas:

- **Volver a mover la etapa** reusando el `stageToReturned` que ya existe. Cero propiedades nuevas,
  pero choca con el problema original: hay pipelines donde no se puede retroceder.
- **Checkbox que el workflow desmarca al final.** Cero cambios en el integrador, pero el valor se
  queda marcado tras el primer uso si algo falla en el reset, y el asesor no tiene ninguna señal de
  estado.
- **Botón real en la ficha del deal** con una UI extension del HubSpot CLI. Mejor experiencia, pero
  agrega una plataforma entera de HubSpot que mantener (proyecto, sandbox, despliegues) para
  resolver algo que una propiedad ya resuelve.
- **Reintento parcial** para `sap_created_hubspot_error`, que reejecutara solo el tramo posterior a
  SAP usando el `docEntry` guardado. Conceptualmente correcto, pero es un segundo flujo de reproceso
  completo. Se deja para cuando el cliente demuestre que le pasa seguido.

## Invariante y rama de omisión

**El sistema nunca duplica en SAP. Lo que HubSpot muestre en la propiedad es informativo y puede
desincronizarse sin costo.**

De ahí sale que la rama de omisión no necesita nada nuevo. Cuando llega un reenvío que la regla
bloquea, el API devuelve el mismo 200 de hoy
(`src/application/use-cases/QueueHubspotWebhookEvent.js:84-87`), el integrador no escribe la
propiedad, no deja nota y no hace nada más. Si un asesor pone `Reintentar` sobre un deal ya
completado, la propiedad se queda en `Reintentar` hasta el próximo estado terminal real: es un
error del asesor y no tiene consecuencia. Lo único que queda de ese camino es el log que ya existe,
`"Duplicate HubSpot webhook detected"` (`src/application/use-cases/QueueHubspotWebhookEvent.js:75-82`),
que le sirve a soporte si alguien pregunta por qué no pasó nada.

## Migración

Es la parte con más riesgo operativo, y **la base es por tenant**: la migración recorre todos los
tenants activos, no corre una sola vez.

Pasos, por tenant, en este orden:

1. **Verificar** que no exista ya más de un evento no-`errored` por `(eventType, dealId)`. No
   debería haberlo, porque el dedup de aplicación bloqueaba cualquier segundo evento, pero un índice
   único que se crea sobre datos que lo violan falla. La migración lo reporta antes de tocar nada.
2. **Backfill** de `dedupActive` en los cuatro tipos, con el valor `status !== 'errored'`.
3. **Crear** el índice nuevo.
4. **Tumbar** el índice viejo de `createDeal`. Hay que hacerlo explícito: Mongoose crea índices,
   pero no borra los que sobran.

El orden no se puede invertir. Si el índice nuevo se crea antes del backfill, los documentos sin el
campo quedan fuera del índice parcial y no hay protección. Si el viejo se tumba antes de que el
nuevo exista, hay una ventana sin ninguna garantía dura sobre `createDeal`. Que los pasos 3 y 4 se
puedan hacer en ese orden depende de que la llave del índice nuevo incluya `dedupActive` y sea por
lo tanto un patrón distinto al del viejo (ver la sección 3); con la misma llave, MongoDB rechazaría
el nuevo y habría que abrir esa ventana.

Un detalle de despliegue: el índice nuevo se declara en el schema, así que Mongoose lo crea solo al
inicializar el modelo. Si el código nuevo llega antes del backfill, ese `autoIndex` corre sobre
documentos sin `dedupActive`, que quedan fuera del filtro parcial — no falla, pero deja sin cubrir a
los eventos viejos hasta que el backfill los complete. El backfill es idempotente, así que la
secuencia segura es correr la migración y después desplegar, o correrla inmediatamente después.

## Verificación

- **Unitario del dedup:** la regla nueva contra los seis estados del enum, por cada uno de los
  cuatro tipos, más que `updateQuotation` sigue insertando siempre.
- **Unitario del repositorio:** `markFailed` pone `dedupActive: false` solo cuando el estado es
  `errored`.
- **Unitario del publicador de estado:** los tres mapeos terminales, apagado sin configuración, y
  que no tira nunca hacia arriba.
- **Unitario del batch:** que llame al publicador en sus tres puntos terminales.
- **Integración con `mongodb-memory-server`:** que el índice único rechace un segundo evento
  no-`errored` y acepte N `errored`. El `memory-server` corre una versión de Mongo más nueva que
  producción; para índices parciales no hay divergencia conocida, pero la migración hay que probarla
  contra una instancia de la versión de producción antes de soltarla.
- **Prueba manual:** `POST /sap-sync/runWebHook` (`src/interfaces/http/routes/sapSync.routes.js:18`),
  el disparador manual del procesador de webhooks.
- **Revisión de cableado:** grep explícito en la composition por la llave exacta del servicio nuevo
  inyectado. Ya pasó de commitear un parámetro sin cablear con todos los tests verdes.
