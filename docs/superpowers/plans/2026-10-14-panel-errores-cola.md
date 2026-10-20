# Panel — Plan 5b: errores de las corridas de la cola de eventos — Plan de implementación

> **Estado:** aprobado por el usuario el 2026-10-14.

**Goal:** en el detalle de una corrida de la cola de eventos, que el panel muestre cada fallo como un ítem de `errors`. Hoy el detalle de esas corridas queda en `errorMessage` y `errors` viene vacío.

**Pedido del front** (vía el usuario):
- Si `errors` viene vacío y `errorMessage` es la lista de entradas `payload_Hubspot / payload_SAP / response_hubspot / response_SAP`, derivar `errors.items` de ella.
- `errors.total` debe coincidir con `counts.failed`.
- El `summary` incluye el primer mensaje.

**Depende de:** el plan 5 (`2026-10-14-panel-tableros-y-ajustes.md`), ya ejecutado.

## Global Constraints

- Solo capa del panel. **No cambia cómo la integración escribe en `SyncLogs`** (ni el worker, ni `webhookProcessorRunner.service.js`, ni los casos de uso de webhooks).
- Solo lectura sobre las bases de los tenants.
- `main`, sin ramas. Sin `git add`, `commit` ni `push`. Al terminar, dejar en el chat qué cambió, en qué archivos y por qué.

## Hechos verificados en el código

| Hecho | Dónde |
|---|---|
| Cada entrada tiene las claves `payload_Hubspot`, `payload_SAP`, `response_hubspot` y `response_SAP` | `buildWebhookSyncErrorEntry`, `src/infrastructure/sync/syncLog.service.js` |
| Hay una entrada por evento fallido: el caso de uso lanza `error.syncLogWebhookErrors` con una entrada o, si no la hay, el lote agrega una con `payloadHubspot: event.payload` | `ProcessWebhookDealEventBatch.appendErrorDetails` |
| `counts.failed` es `result.errored` del lote; si el runner entero falla, se guarda `failed: 1` con una sola entrada | `webhookProcessorRunner.service.js` |
| `payload_Hubspot` es casi siempre el payload del webhook (`{ deal: { hs_object_id, … } }`). En los precios por lista es `{ dealId }` | `ProcessHubspotWebhookEvent`, `webhookQuotationSupport`, `SyncDealLineItemPricesByPriceList` |
| El mensaje no está siempre en el mismo lugar | ver lista abajo |
| **La entrada no guarda el id del evento** | `buildWebhookSyncErrorEntry` |

Dónde puede estar el mensaje:
- en `response_SAP.message`, cuando `response_SAP` es el snapshot de `buildErrorResponseSnapshot`, en el camino genérico;
- en `response_SAP.error.message`, en los casos de uso, que guardan `{ ...response_SAP, error: snapshot }`;
- en el caso del runner que falla entero, el mensaje está en `response_SAP.message` y `payload_Hubspot` lleva el `tenantKey` y el `triggerType`, no un negocio.

## Decisiones (cambiables antes de aprobar)

1. **Cuándo se deriva:** solo si `errors` viene vacío **y** `errorMessage` es una lista cuyos ítems tienen alguna de las claves `payload_Hubspot`, `payload_SAP`, `response_hubspot` o `response_SAP`. Cualquier otra corrida queda igual que hoy.
2. **Ítem derivado:** `{ record, message, eventId }`.
   - `record` = `payload_Hubspot.deal.hs_object_id`, si no `payload_Hubspot.dealId`, si no `null`.
   - `message` = el primero que exista de `response_SAP.message`, `response_SAP.error.message`, `response_hubspot.message` y `response_hubspot.error.message`. Si no hay ninguno, `"Error sin detalle"`.
     - En la vista de cliente va **saneado** (como `lastError`, G3); en la de staff, crudo.
   - `eventId` = el id del evento, buscado **sin escribir nada**: un `WebhookEvent` con esa referencia, `status: 'errored'` y `updatedAt` entre el `startedAt` y el `finishedAt` de la corrida (con un margen de 1 minuto).
     - Si hay exactamente uno, su id; si hay cero o más de uno, `null`.
     - Es una sola consulta por detalle, con `$in` de las referencias de la página, proyección `_id`, referencia y `updatedAt`, y `maxTimeMS`.
3. **`errors.total`:** la cantidad de entradas de `errorMessage`.
   - Según el código actual es igual a `counts.failed` (una entrada por evento fallido; `failed: 1` con una entrada si cae el runner).
   - Si alguna corrida vieja no coincidiera, se informa la cantidad real de entradas, que es la que se puede mostrar. No se inventan ítems.
4. **Paginación:** `errorsPage` y `errorsPageSize` se aplican igual sobre los ítems derivados.
   - Para no traer el array entero, el lector pide `errorMessage` recortado con `$slice` y su tamaño con `$size`, como ya hace con `errors`.
5. **Staff:** también recibe los ítems derivados, con el mensaje **crudo** y `eventId`. `errorMessage` le sigue llegando completo.
6. **`summary` para el cliente** (en lista y detalle):
   - si hay mensaje: `"N error(es) en la corrida: <primer mensaje saneado>"`, en singular o plural según N ("1 error en la corrida: …", "3 errores en la corrida: …");
   - sin mensaje: "N error(es) en la corrida", como hoy.
   - En la lista, el primer mensaje sale de la primera entrada, que ya se lee recortada.
7. **Contrato:** se agrega **G7** a `06-ajustes-plan-5.md`. Para el front: los ítems de `errors` pueden traer `eventId` (string o `null`).

## Archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/domain/panel/queueRunErrors.js` | Crear | Reconocer la lista, derivar `{ record, message, eventId }` y armar el `summary` |
| `src/domain/panel/operationViews.js` | Modificar | `clientSyncErrorMessage` usa el nuevo `summary` |
| `src/infrastructure/database/repositories/TenantOperationsReader.js` | Modificar | `findSync`: recorte y tamaño de `errorMessage`; + `findQueueEventIds` (solo lectura) |
| `src/application/ports/panel/operations-reader.port.js` | Modificar | + `findQueueEventIds` |
| `src/application/use-cases/panel/PanelOperations.js` | Modificar | `getSync`: si `errors` está vacío y es la lista, deriva, pagina y busca los `eventId` |
| Pruebas unitarias, integración y `06-ajustes-plan-5.md` (G7) | Modificar | — |

## Pruebas

- Derivación con cada forma real:
  - camino genérico con `payload.deal`;
  - caso de uso con `response_SAP.error.message`;
  - precios por lista con `{ dealId }`;
  - runner caído (sin negocio → `record: null`).
- Vista de cliente: mensaje saneado y nada de `payload_*` ni `response_*` en la respuesta. Staff: mensaje crudo.
- `total` igual a la cantidad de entradas, paginación, y `eventId` único, ausente o ambiguo.
- `summary` en singular y en plural.
- Una corrida con `errors` propios no cambia.
- Integración (Windows): corrida de la cola con dos fallos y sus dos eventos.

## Ejecución (2026-10-14)

Ejecutado. El core no se tocó.

Archivos:
- `src/domain/panel/queueRunErrors.js` (nuevo).
- `operationViews.js`: el `summary` de las corridas de la cola.
- `PanelOperations.getSync` y `queueEventIds`.
- `TenantOperationsReader.findQueueEventIds` (solo lectura; tope de 500 resultados) y su puerto.
- `06-ajustes-plan-5.md` (G7).

Diferencias con el plan:
- **Decisión 4:** `errorMessage` no se recorta en la base, porque Smarteam lo recibe completo (decisión 5). Los ítems se paginan en memoria, sobre el documento ya leído (cabe en los 16 MB de Mongo).
- **Extra:** si un mismo negocio falló dos veces en la misma corrida, sus ítems salen con `eventId: null`, porque no se puede saber cuál es cuál.

Pruebas:
- Suite unitaria: 236 suites / 2965 tests, con los mismos 4 suites / 6 tests rojos previos.
- Nuevas: `tests/unit/domain/panelQueueRunErrors.test.js`, y casos en `panelOperations.test.js` y `panelOperationsReader.test.js`.
- Se actualizaron 2 aserciones por el nuevo `summary`.
- Integración en `tests/integration/panelOperations.test.js` (Windows).

