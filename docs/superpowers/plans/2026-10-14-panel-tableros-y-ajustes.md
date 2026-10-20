# Panel — Plan 5: ajustes por hallazgos del front, tableros y métricas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado:** aprobado por el usuario el 2026-10-14 **sin la Parte D** (el slug público queda fuera). Opción 1 para A3.

**Goal:** cuatro partes, cada una se puede aprobar por separado.
- **A.** Corregir lo que el front encontró contra la base real de Printer (hallazgos 1 a 3).
- **B.** Resumen de integración del Inicio (contrato 05, F1–F6).
- **C.** Métricas de soporte (F7–F9).
- **D.** Slug público por empresa en lugar de `sap_integration_<slug>` (hallazgo 5, opcional).

**Contratos:**
- `docs/contrato-backend/05-tableros-y-metricas.md` del repo del front (F1–F9; se copia a este repo en la tarea 0).
- `03-eventos-y-syncs.md` y `02-soporte.md`.
- Mocks de referencia (solo lectura): `src/mocks/handlers/dashboard.js`, `metrics.js`, `period.js` y `error-causes.js`.

**Depende de:** los planes 1, de endurecimiento, 2 y 3. Todo su código está en el árbol de trabajo.

**Architecture:** la misma de los planes anteriores. Todo el cálculo de resúmenes vive en el dominio o la aplicación como funciones puras. La lectura usa el driver nativo, con proyecciones estrictas y `maxTimeMS`.

## Decisión del usuario (2026-10-14)

- **Nada de este plan cambia el core ni cómo se guardan los datos.**
  - El worker y el procesador de webhooks siguen guardando `lastError`, `errorMessage` (con `payload_*` y `response_*`) y las corridas vacías igual que hoy.
  - Las colecciones de los tenants solo se leen.
- **Opción 1 elegida para A3:** la API del panel filtra lo que entrega **a cuentas cliente**:
  - `lastError` saneado y `cause`;
  - el `errorMessage` de las corridas reducido a un resumen;
  - los `errors` de una corrida reducidos a `{ record, message }`.
  Smarteam recibe todo crudo. El front se adapta a lo que reciba (`06-ajustes-plan-5.md`).
- Motivo: si el filtro fuera solo visual, en el front, los datos internos igual llegarían al navegador del cliente.

## Global Constraints

- `main`, sin ramas ni worktrees. **No** `git add`, `commit` ni `push`. Al terminar cada tarea, dejar en el chat qué cambió, en qué archivos y por qué.
- **No se tocan el core ni los tenants:** worker, webhook processor, syncs, modelos, `tenantDatabase.js`, `app.js` y `env.js`. Todo lo de este plan es del panel y de solo lectura sobre las bases de tenant.
  - Lo que pediría cambiar el core (por ejemplo, no guardar las corridas vacías) queda como **propuesta aparte**, no implementada.
- **El Mongo de producción es anterior a la 5.0** (está anotado en `src/infrastructure/sync/syncLog.service.js`). No se usan `$dateTrunc`, `$setWindowFields`, `$getField` ni nada de 5.0 o posterior. Los días y semanas se calculan en JavaScript, con `Intl`.
- Nada de nombres de sistemas en rutas, claves de respuesta ni etiquetas (regla del spec).
- Archivos nuevos en LF; los existentes conservan sus finales de línea. Integración en Windows.

## Aplica a qué tenant

A todos, B1 y S4HANA. Hay dos excepciones que dependen del tenant y se verifican con el diagnóstico (A0):
- **Número de documento (F6):** sale de la auditoría del evento. Hoy solo se sabe dónde queda en B1 (`sapAudit.responseSap.DocNum`). En S4HANA puede estar en otro campo o no estar: si no se encuentra, sale `null`. **Hay que verificarlo con datos de cada tenant.**
- **Catálogo de causas de error (F5):** las reglas se ajustan con los textos reales que muestre el diagnóstico de cada tenant.

## Lo que se encontró al revisar los hallazgos (código)

| Hallazgo del front | Causa real | Consecuencia |
|---|---|---|
| 1. Todas las corridas de Printer llegan con `task: null` | Hay **dos** escritores de `SyncLog`. Las tareas programadas (`SyncSapConfigToHubspot`, `SyncDropdownOptionsToHubspot`) guardan `clientConfigId`. El **procesador de la cola de webhooks** (`webhookProcessorRunner.service.js`) crea un `SyncLog` con `objectType: 'Deal'` y **sin** `clientConfigId` en cada vuelta del worker, para cada tenant activo | El cruce con la tarea funciona; esas corridas no son de ninguna tarea. Hay que mostrarlas como lo que son: corridas de la cola de eventos |
| 2. 55 536 corridas, una por minuto, casi todas vacías | Son esas mismas vueltas del procesador de webhooks, que guardan un `SyncLog` aunque no haya nada pendiente | Filtro `hideEmpty` en el panel. No guardar las vacías sería cambiar el worker (core): queda como propuesta aparte |
| 3. `lastError` técnico, con IPs y prefijos | `lastError` se guarda tal cual. Además, **el `errorMessage` de las corridas del procesador de webhooks es un array con `payload_Hubspot`, `payload_SAP`, `response_hubspot` y `response_SAP`** (`buildWebhookSyncErrorEntry`), y hoy el plan 3 lo entrega **tal cual al cliente** en `/syncs` | Es más grave que lo que vio el front: el cliente ve payloads internos y nombres de sistemas en las claves. **Se corrige primero (A3)** |
| 4. Faltan los tableros (F1–F9) | — | Partes B y C |
| 5. `sap_integration_<slug>` en las URLs del panel | El panel expone el `tenantKey` real | Parte D (opcional) |

## Decisiones (cambiables antes de aprobar)

### Parte A — ajustes a lo existente

1. **A0. Diagnóstico de solo lectura**, antes de afinar nada: `scripts/panel-operations-report.mjs <tenantDb>`. Lo corres tú, un tenant a la vez, y la salida es la evidencia para ajustar las reglas. Muestra:
   - corridas por `clientConfigId` presente o ausente, por `objectType` y cuántas tienen `recordsProcessed = 0`;
   - los 50 `lastError` más frecuentes, normalizados (números, ids, IPs y hosts reemplazados por marcadores) y con su conteo;
   - las claves de primer nivel de `errorMessage` y de los ítems de `errors`;
   - cuántos eventos creados traen `sapAudit.responseSap.DocNum`.
   No escribe nada, rechaza bases que no son de tenant y no imprime la URI.
2. **A1. Corridas de la cola de eventos:**
   - Una corrida sin `clientConfigId` sale con `task: { "id": "event_queue", "name": "Cola de eventos", "type": "event_queue" }`.
   - `GET /sync-tasks` suma ese ítem virtual al final, así el filtro existente (`?taskId=event_queue`) funciona y filtra por "sin `clientConfigId`".
   - **Requiere un ajuste en el front:** aceptar `type: 'event_queue'` y un `id` que no es de 24 hex.
3. **A2. `?hideEmpty=true` en `GET /syncs`** (cliente y staff): solo corridas con `recordsProcessed > 0`.
   - Lo apaga cualquier otro valor; un valor que no sea `true` ni `false` → 400.
   - El script de índices del plan 3 suma un **índice parcial** `{ startedAt: -1, _id: -1 }` con `partialFilterExpression: { recordsProcessed: { $gt: 0 } }`. Su llave es distinta de `{ startedAt: -1 }`, así que pueden convivir.
4. **A3. Textos de error para el cliente** (rutas de cliente y snapshots de tickets):
   - **Eventos:** se agrega `cause: { key, label, group }` (catálogo F5, a cliente y staff).
   - En rutas de cliente, `lastError` pasa por un **saneador**:
     - IPs, `host:puerto`, URLs y correos → `[servidor]`, `[enlace]` y `[correo]`;
     - se quitan prefijos técnicos conocidos (los que muestre A0);
     - si la causa es del grupo `connectivity`, el texto es directamente el `label` ("No se pudo conectar con el sistema destino.").
   - En rutas de staff, `lastError` sale **crudo**: Smarteam lo necesita para diagnosticar. El texto crudo también sigue en `audit`.
   - **Syncs, cliente:**
     - `errorMessage` texto → saneado;
     - `errorMessage` objeto o array → `{ "summary": "N error(es) en la corrida" }`;
     - los ítems de `errors` se reducen a `{ record, message }` saneados, sin payloads ni respuestas.
   - **Syncs, staff:** sin cambios, todo crudo.
   - **Snapshot de un ticket nuevo:** se guarda la versión de cliente, porque el cliente lo ve. Los snapshots ya guardados no se migran.
5. **A4. Contrato:** se escribe `docs/contrato-backend/06-ajustes-plan-5.md` con estos cambios (A1–A3 y D) para el front.

### Parte B — resumen de integración (F1–F6)

6. **Cálculo en JavaScript**, no en agregaciones de Mongo:
   - se leen los eventos del período con una proyección mínima: `status`, `lastError`, `createdAt`, `updatedAt`, `payload.deal.hs_object_id`, `payload.deal.dealname` y `sapAudit.responseSap.DocNum`;
   - nunca el `payload` ni la auditoría completos;
   - tope de **20 000 eventos** por período: si se pasa → 400 `validation_error` "El período tiene demasiados eventos; acórtalo.";
   - motivo: funciona en Mongo < 5.0, reutiliza las reglas del mock y se prueba sin base.
7. **Grupos (F3):** `created` = `completed`, `sap_order_created`, `sap_created_hubspot_error`; `errored` = `errored`; `pending` = `waiting`, `inprocess`. Los `report` y los estados sin traducción quedan fuera (estos últimos con un `warn`).
8. **Período (F1, F4):**
   - `from`, `to` y `tz` obligatorios; `to > from`; máximo 366 días más 1 hora (cambio de horario);
   - `tz` debe ser una zona IANA válida;
   - inválido → 400 "Período o zona horaria inválidos.".
9. **Catálogo F5** en `src/domain/panel/errorCauses.js`:
   - arranca con las reglas del mock más reglas de conectividad (`ETIMEDOUT`, `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `socket hang up`, `timeout`) y se ajusta con A0;
   - etiquetas genéricas, sin nombres de sistemas;
   - gana la primera regla que calce; si ninguna calza → `other`.
10. **F6:** como el mock. `title` = `payload.deal.dealname`; `documentNumber` = `sapAudit.responseSap.DocNum` en los creados, o `null` (ver "Aplica a qué tenant").

### Parte C — métricas de tickets (F7–F9)

11. Se leen los tickets del tenant sin mensajes ni nota interna (`openedAt`, `firstResponseAt`, `resolvedAt`, `status`, `reopenCount`, `category`) y se calcula en JavaScript con las reglas F8 y F9 del contrato.
    - La ruta de staff recorre los tenants como la bandeja (paralelo, 5 s por tenant).
    - Agrega `warnings` si un tenant falla; es un campo extra que el front puede ignorar.
12. `byTenant` solo en la ruta de staff. `tenantKey` y `category` se validan: empresa inexistente → 404; categoría desconocida → 400.

### Parte D — slug público (opcional, recomendado antes de producción)

13. **Recomendación: hacerlo ahora**, antes de que existan enlaces guardados.
    - El panel usa como `tenantKey` el **slug sin prefijo** (`printer`) en **todas** las respuestas y rutas: `/auth/me`, usuarios, `/staff/tenants`, bandeja, detalle de ticket, eventos y syncs, métricas.
    - Al entrar, se traduce al real buscando en `SaaSClients` el `tenantKey` igual a `<prefijo>_<slug>` o igual a `<slug>`.
    - `PanelUsers` guarda el real: **no hay migración**.
    - Un slug que no existe → 404 como hoy.
    - El nombre del campo no cambia: el front solo ve valores distintos.
    - Alternativa: no hacerlo y aceptar `sap_integration_` en las URLs de Smarteam.

## Rutas nuevas

| Ruta | Permiso | Cuenta |
|---|---|---|
| `GET /dashboard/integration?from=&to=&tz=` | `events.read` | cliente |
| `GET /staff/tenants/:tenantKey/dashboard/integration?…` | `events.read` | Smarteam |
| `GET /tickets/metrics?from=&to=&tz=` | `tickets.read` | cliente |
| `GET /staff/tickets/metrics?from=&to=&tz=&tenantKey=&category=` | `staff.tickets` | Smarteam |

- `/tickets/metrics` no choca con `/tickets/:id`, porque en Fastify una ruta estática gana a una con parámetro. Igual se prueba.
- Cambia una ruta existente: `GET /syncs` (y la de staff) acepta `hideEmpty`.

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `scripts/panel-operations-report.mjs` | Crear | Diagnóstico A0 (solo lectura) |
| `scripts/create-panel-operation-indexes.mjs` | Modificar | + índice parcial de corridas no vacías (A2) |
| `src/domain/panel/errorCauses.js` | Crear | Catálogo F5, `classifyError`, grupos |
| `src/domain/panel/errorText.js` | Crear | Saneador de textos para el cliente (A3) |
| `src/domain/panel/period.js` | Crear | Período, días locales, lunes y mediana (F4, F9), con `Intl` |
| `src/domain/panel/operationViews.js` | Modificar | `cause`; vista de cliente y de staff; tarea virtual `event_queue` |
| `src/domain/panel/integrationSummary.js` | Crear | Cuerpo F2 a partir de eventos crudos |
| `src/domain/panel/ticketMetrics.js` | Crear | Cuerpo F8 a partir de tickets |
| `src/application/use-cases/panel/operationFilters.js` | Modificar | `hideEmpty`, `taskId=event_queue` |
| `src/application/use-cases/panel/PanelOperations.js` | Modificar | Vistas por lado (cliente o staff), tarea virtual, `dashboard()` |
| `src/application/use-cases/panel/ClientTickets.js` | Modificar | Snapshot con la vista de cliente |
| `src/application/use-cases/panel/TicketMetrics.js` | Crear | Métricas del cliente y de staff (con fan-out) |
| `src/application/ports/panel/operations-reader.port.js` | Modificar | + `listEventsForSummary` |
| `src/application/ports/panel/ticket-repository.port.js` | Modificar | + `listForMetrics` |
| `src/infrastructure/database/repositories/TenantOperationsReader.js` | Modificar | `hideEmpty`, sin `clientConfigId`, eventos del período con tope |
| `src/infrastructure/database/repositories/MongooseTicketRepository.js` | Modificar | `listForMetrics` (proyección mínima) |
| `src/interfaces/http/controllers/panelOperations.controller.js` y `panelTicketMetrics.controller.js` | Modificar / Crear | Lado (cliente o staff) y nuevas rutas |
| `src/interfaces/http/panel/panelPlugin.js` | Modificar | 4 rutas nuevas |
| **Parte D:** `SaaSClientTenantDirectory.js`, `panelUserView.js`, `ManagePanelUsers.js`, `ListPanelTenants.js`, `StaffInbox.js`, `StaffTickets.js`, `PanelOperations.js` y su puerto | Modificar | Traducción slug ↔ tenantKey en un solo lugar (`domain/panel/tenantSlug.js` + el directorio) |
| `docs/contrato-backend/05-tableros-y-metricas.md` | Copiar del front | Referencia del contrato en este repo |
| `docs/contrato-backend/06-ajustes-plan-5.md` | Crear | Cambios para el front (A1–A3, D) |
| `README.md` | Modificar | Sección 20 |

## Tareas

### Tarea 0 — Línea base y contrato
- [ ] Suite unitaria: 232 suites, con los 4 suites / 6 tests rojos previos.
- [ ] Copiar `05-tableros-y-metricas.md` del front (solo lectura del repo del front).

### Tarea 1 — A0: diagnóstico
- [ ] Escribir `scripts/panel-operations-report.mjs` y su prueba de integración (en Windows).
- [ ] **Pausa:** te pido correrlo sobre Printer (y los demás tenants que quieras) y compartir la salida, si te parece bien. Con eso se ajustan el catálogo (F5), el saneador (A3) y el campo del número de documento.
  - Si prefieres no correrlo todavía, se sigue con las reglas del mock y se ajustan después.

### Tarea 2 — A3: saneador y catálogo (lo más urgente)
- [ ] Pruebas primero:
  - IPs v4 y v6, `host:puerto`, URLs y correos;
  - un texto de negocio no se toca ("El artículo ITEM-0042 no existe");
  - grupo de conectividad → `label`;
  - el catálogo con todos los ejemplos del mock y de A0.
- [ ] Vistas de cliente y de staff para eventos y syncs:
  - en la de cliente, `errorMessage` objeto o array → `summary`, y `errors` → `{ record, message }`;
  - **prueba que falla hoy:** una corrida con `errorMessage` de `buildWebhookSyncErrorEntry` no puede devolver al cliente ninguna clave `payload_*` ni `response_*`.
- [ ] Snapshot de ticket con la vista de cliente.

### Tarea 3 — A1 y A2: corridas de la cola y `hideEmpty`
- [ ] Pruebas:
  - corrida sin `clientConfigId` → tarea virtual;
  - `/sync-tasks` la incluye al final;
  - `taskId=event_queue` filtra por `clientConfigId` ausente;
  - `hideEmpty=true` filtra por `recordsProcessed > 0`;
  - `hideEmpty=x` → 400.
- [ ] Índice parcial en el script de índices, con su prueba.

### Tarea 4 — Parte B: resumen de integración
- [ ] Pruebas de dominio, tomando los mismos casos del mock donde se pueda:
  - días locales en `America/Costa_Rica` alrededor de la medianoche UTC;
  - todos los días del período, con ceros;
  - grupos F3; `avgDuration*`; `oldestPendingAt`;
  - orden de `causes` y `groups` (`other` al final en el empate);
  - F6: tope de 10, orden, `resolvedAfterSeconds`, `steps`.
- [ ] Período inválido, más de 366 días, `tz` inválida y tope de 20 000 eventos → 400.
- [ ] HTTP: alcance cliente y staff, 403 cruzados, 404 de empresa, nada de `payload` ni auditoría en la respuesta.

### Tarea 5 — Parte C: métricas de tickets
- [ ] Pruebas de F8 y F9:
  - medianas;
  - un ticket reabierto y abierto no cuenta como resuelto;
  - `resolvedPreviousPeriod`;
  - semanas desde el lunes en `tz`;
  - `buckets` siempre los 4;
  - `byCategory`;
  - `byTenant` solo en staff;
  - un tenant caído → `warnings`.
- [ ] HTTP, y comprobar que `/tickets/metrics` no se toma como un id.

### Tarea 6 — Parte D: slug público (si se aprueba)
- [ ] `domain/panel/tenantSlug.js` (`toPublicKey` y candidatos al resolver) y el directorio con `findByPublicKey`.
- [ ] Todas las salidas y entradas del panel usan el slug. Pruebas en cada endpoint que devuelve o recibe `tenantKey`: me, usuarios, empresas, bandeja, resumen, detalle, eventos, syncs, tableros y métricas.
- [ ] Se acepta también el `tenantKey` completo en las rutas, para no romper enlaces durante la transición. Las respuestas siempre llevan el slug.

### Tarea 7 — Documentación y verificación
- [ ] `06-ajustes-plan-5.md` para el front, README y sección "Ejecución".
- [ ] Integración (Windows):
  - resumen con datos reales en memoria;
  - métricas con dos tenants;
  - `hideEmpty` con el índice parcial;
  - leer no crea bases.
- [ ] Suite completa, revisión de seguridad con un subagente (enfocada en lo que llega al cliente) y prueba manual con el front.
- [ ] Reporte final en el chat.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un período largo en un tenant grande | Proyección mínima, `maxTimeMS` de 5 s, tope de 20 000 eventos, índices del plan 3 |
| El catálogo no cubre los textos reales | Todo lo que no calza cae en `other` y el tablero igual funciona; se afina con A0 |
| El saneador borra algo útil para el cliente | Solo quita IPs, hosts, URLs y correos; lo de negocio queda. Staff siempre ve el texto crudo |
| El número de documento no está en la auditoría en S4HANA | Sale `null`; se verifica con A0 |
| La Parte D toca muchas respuestas | Traducción en un solo punto; las rutas aceptan las dos formas; pruebas por endpoint |

## Propuestas fuera de este plan (cambian el core; necesitan aprobación aparte)

- **No guardar las corridas vacías del procesador de webhooks**, o guardarlas con un TTL corto (`webhookProcessorRunner.service.js`). Bajaría de unas 1 440 a unas pocas corridas por día y por tenant.
- **`tenantDatabase.js`:** una conexión que falla la primera vez queda en caché hasta reiniciar.

## Ejecución (2026-10-14)

Ejecutado: Partes A, B y C. **La Parte D quedó fuera por decisión del usuario.** El core no se tocó: ningún archivo del worker, del procesador de webhooks, de los modelos ni de `tenantDatabase.js`.

Diferencias y precisiones:
- **A0, diagnóstico:** el script está escrito (`scripts/panel-operations-report.mjs`), pero la pausa para correrlo no se hizo.
  - El catálogo arrancó con las reglas del mock, más dos de conectividad (`timeout` y `connection_failed`).
  - Afinarlo con la salida real de cada tenant queda pendiente.
- **A3:**
  - el saneador también reemplaza los nombres de sistemas por "el ERP" y "el CRM";
  - por la revisión de seguridad, además enmascara: IPv6 entre corchetes y con zona, hosts con `_`, hosts sin dominio con puerto, rutas de archivos y de red, y bases `SBO_*`;
  - corta la entrada a 2000 caracteres antes de las expresiones, contra ReDoS (con el corte, 100 KB de entrada adversa tardan unos 10 ms; sin él, la revisión midió hasta 11 s con 80 KB).
- **G5 (revisión de seguridad, HIGH):** los snapshots de tickets creados antes del plan 5 se vuelven a sanear al leerlos para el cliente. Antes, el plan decía que los ya guardados "se conservan" tal cual.
- **F2:**
  - los eventos se leen con `aggregate` (`$match`, `$limit`, `$project`) para cortar `lastError` a 2000 caracteres en la base; todo funciona en Mongo < 5.0 (`$substrCP`, `$type`);
  - el agrupado por referencia se hizo lineal.
- **Período:** además de lo del plan, se rechazan fechas anteriores a 2000 o posteriores a 2100, para que el período anterior de F8 sea siempre una fecha válida.
- **Fan-out:** `tenantFanOut.js` es nuevo y lo usan las métricas de staff. La bandeja del plan 2 sigue con su propia copia, sin cambios.
- **Script de índices:** suma el índice parcial `{ startedAt: -1, _id: -1 }` sobre `recordsProcessed > 0`. Ahora son 6 índices.

Pendientes y propuestas (no implementados):
- Correr el diagnóstico por tenant y afinar el catálogo y el saneador.
- Límite de frecuencia en las rutas de resumen.
- Concurrencia máxima en el fan-out.
- Las del core, ya anotadas arriba: no guardar las corridas vacías y el caché de conexiones fallidas.

Pruebas:
- Suite unitaria: 235 suites / 2955 tests, con los mismos 4 suites / 6 tests rojos previos.
- Nuevas: `tests/unit/domain/{panelErrorText,panelSummaries}.test.js`, `tests/unit/application/panel/ticketMetrics.test.js`, y casos nuevos en `operationFilters`, `panelOperations`, `clientTickets`, `panelOperationsReader`, `panelOperationsApi` y `routeAuthWiring` (las 4 rutas).
- Integración: `tests/integration/panelOperations.test.js`, ampliada con corridas de la cola, `hideEmpty`, el tablero, los 6 índices y el diagnóstico. Pendiente de correr en Windows.
