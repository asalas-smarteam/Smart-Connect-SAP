# Panel — Soporte (tickets, mensajes, imágenes y bandeja de staff) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado:** borrador. **Pendiente de aprobación explícita del usuario.** No se toca código hasta entonces.

**Goal:**
- **Cliente:** crear, listar y ver sus tickets; responder con texto e imágenes; reabrir un ticket resuelto. Opcionalmente, adjuntar como contexto un evento o una sincronización de su tenant.
- **Staff:** bandeja con los tickets de todos los tenants; responder; cambiar el estado; resolver con nota interna; resumen de la bandeja.

**Spec:** `docs/superpowers/specs/2026-10-12-panel-soporte-design.md`.
**Contrato:** `docs/contrato-backend/02-soporte.md` (D1–D12) y `00-reglas.md`.
**Referencia de comportamiento:** los mocks del front (solo lectura): `src/mocks/tickets-db.js`, `src/mocks/handlers/tickets.js` y `src/mocks/handlers/staff-tickets.js`.

**Depende de:**
- el plan 1, `docs/superpowers/plans/2026-10-13-panel-acceso.md`;
- el plan de endurecimiento, `docs/superpowers/plans/2026-10-13-panel-acceso-endurecimiento.md`.

Los dos ya están en el árbol de trabajo y el usuario los probó.

**Architecture:** misma estructura que el plan 1:
- dominio en `src/domain/panel/`;
- puertos y casos de uso en `src/application/.../panel/`;
- Mongoose y GridFS en `src/infrastructure/`;
- HTTP en `src/interfaces/http/panel/` y `controllers/`;
- cableado en `src/composition/panel.composition.js`.

Los tickets viven en la **base de cada tenant**, en colecciones nuevas (`Tickets`, `TicketCounters`) y un bucket GridFS nuevo (`TicketAttachments`). Se registran con un helper propio del panel, no con el registro de modelos de tenant existente.

**Tech Stack:** el del plan 1, más **una dependencia nueva:** `@fastify/multipart@8.3.1`. Es la línea compatible con Fastify 4.x (verificado contra `fastify@4.29.1`). Las versiones 9.x exigen Fastify 5.

## Global Constraints

- Trabajar en `main`, sin ramas ni worktrees. **No** `git add`, `commit` ni `push`. Al terminar cada tarea, dejar en el chat qué cambió, en qué archivos y por qué.
- **Nada existente fuera del panel cambia de comportamiento:** webhooks, syncs, rutas admin, OAuth y Bull Board.
- **No se toca el core ni los tenants:**
  - sin cambios en `src/infrastructure/database/models/tenant/index.js`, `tenantDatabase.js`, `master/database.js`, `app.js` ni `env.js`;
  - sin cambios en modelos de tenant existentes (`WebhookEvent`, `SyncLog`, etc.): solo se **leen**;
  - nada de esto llama a SAP (B1 Service Layer ni S4HANA) ni a HubSpot.
- Los únicos archivos existentes que cambian:
  - los del panel (plan 1 y endurecimiento);
  - `routes/index.js` **no** cambia, porque el plugin ya está registrado;
  - `package.json` y `package-lock.json`, por la dependencia nueva, conservando CRLF;
  - README, sección 20.
- **Tenant del cliente:** sale **solo de la sesión** (`user.tenantKey`). Nunca de la URL, el body ni un header.
- **Tenant en rutas de staff (`:tenantKey`):** se valida contra `SaaSClients` (directorio de tenants del plan 1) **antes** de abrir la conexión. `getTenantConnection` crea la base si no existe; un `tenantKey` inventado no debe crear bases.
- Un ticket de otro tenant, o inexistente → **404** `not_found`. Nunca 403: no se revela que existe.
- `internalResolution` **nunca** sale en respuestas al cliente. Lo cubren pruebas de forma explícita.
- Códigos de error del contrato (D9): `validation_error` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `invalid_transition` 409, `payload_too_large` 413, `unsupported_media_type` 415.
- Formato de error del panel sin cambios: `{ error, message? }`.
- Archivos nuevos en LF. Los existentes conservan sus finales de línea (CRLF donde ya los tienen).
- Jest: `NODE_OPTIONS=--experimental-vm-modules npx jest <archivos> --testPathIgnorePatterns=worktrees`. Las pruebas de integración (`mongodb-memory-server`) se corren en Windows.

## Aplica a qué tenant

A **todos los tenants registrados en `SaaSClients`**, porque es una capacidad del panel y no de la integración. No depende de B1 vs S4HANA ni de field mapping: no lee ni escribe objetos de negocio. El único dato de integración que toca es la **lectura** de `WebhookEvent` y `SyncLog`, para el contexto opcional del ticket.

## Hechos verificados en el código y en los mocks

| Hecho | Dónde | Consecuencia |
|---|---|---|
| Los modelos de tenant se registran con `connection.models.X \|\| connection.model(...)` | `models/tenant/*.js` | El helper del panel usa el mismo patrón, sin tocar `index.js` |
| `getTenantConnection(tenantKey)` usa `useDb` y crea la base si no existe | `tenantDatabase.js` | Hay que validar `:tenantKey` antes (staff) |
| `tenantKey` real: `sap_integration_<slug>`; prefijo en `TENANT_DB_PREFIX` | config y `SaaSClients` | Código del ticket = slug en mayúsculas |
| `WebhookEvent` tiene `status`, `lastError`, `eventType`/`subscriptionType` y `objectId` | `models/tenant/WebhookEvent.js` | Snapshot del evento (decisión 7) |
| `SyncLog` tiene `objectType`, `status`, contadores y `errorMessage` | `models/tenant/SyncLog.js` | Snapshot de la sync (decisión 7) |
| Mock: un mensaje sobre un ticket `resuelto` → 409 | `handlers/tickets.js` | Igual en back (decisión 3) |
| Mock: el staff solo puede pasar `en_progreso → esperando_cliente` y `resuelto → en_progreso` | `handlers/staff-tickets.js` | Tabla de transiciones del dominio |
| Mock: reabrir exige mensaje y hace `reopenCount++` | `handlers/tickets.js` | `POST /tickets/:id/reopen` con body JSON `{ body }` |
| Mock: el primer mensaje del staff fija `firstResponseAt` y pasa `abierto → en_progreso` | `handlers/staff-tickets.js` | Regla del dominio |
| Mock: un mensaje del cliente pasa `esperando_cliente → en_progreso` | `handlers/tickets.js` | Regla del dominio |
| Mock: `hasNews` = la última actividad es del otro lado y es posterior a lo que vio el lector | `tickets-db.js` | `lastSeenByClientAt` / `lastSeenByStaffAt` |
| `@fastify/multipart` lanza `FST_REQ_FILE_TOO_LARGE`, `FST_FILES_LIMIT` y `FST_PARTS_LIMIT` | docs de la librería | Se traducen a 413 `payload_too_large` |

## Decisiones (cambiables antes de aprobar)

1. **Modelos del panel fuera de `registerTenantModels`.** Un helper propio, `getPanelTenantModels(tenantKey)`, abre la conexión con `getTenantConnection` y registra `Ticket` y `TicketCounter` con el patrón `connection.models.X || connection.model(...)`.
   - Colecciones: `Tickets` y `TicketCounters`.
   - **Diferencia con el spec:** el spec sugería sumarlos al registro de tenant. Se aparta porque la regla es no tocar el core de tenants.
2. **Código del ticket:** `tenantKey` sin el prefijo `${TENANT_DB_PREFIX}_`, en mayúsculas, guion y correlativo de 4 dígitos. Ejemplo: `PRINTER-0007`.
   - El correlativo sale de `TicketCounters`, con `findOneAndUpdate` + `$inc` + `upsert` (atómico).
3. **Mensajes sobre un ticket `resuelto`:** 409 `invalid_transition` para los dos lados. El cliente debe usar *reabrir*; el staff, el cambio de estado.
4. **Resolver:** permitido desde cualquier estado que no sea `resuelto`. Exige nota interna (`internalResolution`) y fija `resolvedAt`. Si `firstResponseAt` está vacío, lo fija también, para que las métricas no queden con huecos.
5. **Imágenes:**
   - hasta 5 por mensaje, de 5 MB cada una;
   - tipos PNG, JPEG, WEBP y GIF, detectados por **magic bytes** y no por el `Content-Type` del cliente;
   - se leen todas a memoria y se validan **antes** de escribir nada;
   - si falla algo después de subir a GridFS, se borran los archivos subidos.
6. **Bandeja de staff:** consulta los tenants en paralelo, con un timeout de 5 s por tenant. Un tenant que falla o tarda no rompe la respuesta: sale en `warnings: [{ tenantKey, reason }]`. El resumen (`/staff/tickets/summary`) usa la misma regla.
7. **Contexto opcional del ticket:** se guarda un **snapshot** al crear, no una referencia viva.
   - Evento: `{ type, status, lastError, reference }`. `status` se normaliza a los estados genéricos de E1.
   - Sync: `{ objectType, status, counts, errorMessage }`.
   - Si el id no existe en **su** tenant → 400 `validation_error`.
8. **Límites de texto:** título hasta 150 caracteres; descripción, mensaje y nota interna hasta 5000. Se recortan espacios y no se aceptan vacíos.
9. **Leer el detalle marca "visto":** `GET /tickets/:id` actualiza `lastSeenByClientAt`, y el GET de staff actualiza `lastSeenByStaffAt`.
   - Es un efecto en un GET, pero así lo hace el mock y el front depende de eso para `hasNews`.
10. **Métricas F7–F9** (tiempos de respuesta y resolución en tableros): **fuera de este plan.** Los campos `firstResponseAt`, `resolvedAt` y `reopenCount` quedan guardados para que un plan posterior las calcule.

## Modelo de datos (`Tickets`, por tenant)

```
{
  number: Number (único),          code: String,            // PRINTER-0007
  title, description: String,      category: String (enum del contrato),
  status: 'abierto' | 'en_progreso' | 'esperando_cliente' | 'resuelto',
  createdBy: { id, email, name },  context: { kind: 'event'|'sync', snapshot } | null,
  messages: [{ _id, author: { id, name, side: 'client'|'staff' }, body, attachments: [{ fileId, name, mime, size }], createdAt }],
  internalResolution: String | null,
  firstResponseAt, resolvedAt, lastActivityAt, lastActivityBy: 'client'|'staff',
  lastSeenByClientAt, lastSeenByStaffAt, reopenCount: Number,
  createdAt, updatedAt
}
```

- `optimisticConcurrency: true`: dos respuestas simultáneas no se pisan.
- Índices:
  - `{ number: 1 }`, único;
  - `{ status: 1, lastActivityAt: -1 }`;
  - `{ lastActivityAt: -1 }`;
  - `{ category: 1, lastActivityAt: -1 }`.

## Transiciones (dominio)

| Desde | Acción | Hacia | Quién |
|---|---|---|---|
| (nuevo) | crear | `abierto` | cliente |
| `abierto` | primer mensaje del staff | `en_progreso` (+ `firstResponseAt`) | staff |
| `esperando_cliente` | mensaje del cliente | `en_progreso` | cliente |
| `en_progreso` | cambiar estado | `esperando_cliente` | staff |
| `resuelto` | cambiar estado | `en_progreso` | staff |
| cualquiera ≠ `resuelto` | resolver (+ nota interna) | `resuelto` | staff |
| `resuelto` | reabrir (+ mensaje) | `en_progreso` (`reopenCount++`) | cliente |
| `resuelto` | mensaje | **409** | ambos |

Cualquier otra combinación → 409 `invalid_transition`.

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `package.json`, `package-lock.json` | Modificar | + `@fastify/multipart@8.3.1` (CRLF preservado) |
| `src/domain/panel/tickets.js` | Crear | Estados, categorías, límites, `nextStatusFor(action, ticket, side)`, `hasNews`, formato del código |
| `src/domain/panel/imageType.js` | Crear | Detección PNG/JPEG/WEBP/GIF por magic bytes |
| `src/domain/panel/eventStatus.js` | Crear | Normaliza el estado de `WebhookEvent` al genérico de E1 |
| `src/domain/panel/permissions.js` | Modificar | + `tickets.read`, `tickets.write`, `staff.tickets` (si no existen ya) |
| `src/application/ports/panel/ticket-repository.port.js` | Crear | `create`, `findById`, `list`, `save`, `summary`, `markSeen` |
| `src/application/ports/panel/ticket-attachment-store.port.js` | Crear | `put`, `open`, `remove` |
| `src/application/ports/panel/ticket-context-reader.port.js` | Crear | `readEvent`, `readSync` (solo lectura) |
| `src/application/use-cases/panel/ticketView.js` | Crear | Vista cliente (sin `internalResolution`) y vista staff |
| `src/application/use-cases/panel/ClientTickets.js` | Crear | Crear, listar, detalle, responder, reabrir, adjunto |
| `src/application/use-cases/panel/StaffTickets.js` | Crear | Detalle, responder, cambiar estado, resolver, nota interna, adjunto |
| `src/application/use-cases/panel/StaffInbox.js` | Crear | Bandeja multi-tenant y resumen, con timeout y `warnings` |
| `src/infrastructure/database/models/panel/Ticket.js` | Crear | Esquema y fábrica `(connection) => model` |
| `src/infrastructure/database/models/panel/TicketCounter.js` | Crear | Correlativo por tenant |
| `src/infrastructure/database/repositories/panelTenantModels.js` | Crear | `getPanelTenantModels(tenantKey)` |
| `src/infrastructure/database/repositories/MongooseTicketRepository.js` | Crear | Implementa el puerto |
| `src/infrastructure/database/repositories/GridFsTicketAttachmentStore.js` | Crear | Bucket `TicketAttachments`, `metadata.ticketId` |
| `src/infrastructure/database/repositories/TenantTicketContextReader.js` | Crear | Lee `WebhookEvent` y `SyncLog` del tenant, campos mínimos |
| `src/interfaces/http/panel/multipartImages.js` | Crear | Lee el multipart (campos + archivos) con límites y valida tipos |
| `src/interfaces/http/panel/panelErrors.js` | Modificar | + 409, 413, 415 y la traducción de los errores de multipart |
| `src/interfaces/http/panel/panelPlugin.js` | Modificar | Registra multipart **solo en el contexto del panel** y las rutas nuevas |
| `src/interfaces/http/controllers/panelTickets.controller.js` | Crear | Rutas de cliente |
| `src/interfaces/http/controllers/panelStaffTickets.controller.js` | Crear | Rutas de staff |
| `src/composition/panel.composition.js` | Modificar | Construye los casos de uso de tickets con adaptadores inyectables |
| `README.md` | Modificar | Sección 20: APIs de soporte |

## Rutas

Todas bajo `/panel/api`. Exigen sesión, CSRF en las que no son GET y cambio de contraseña al día.

**Cliente** (permiso `tickets.*`; tenant tomado de la sesión):

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/tickets` | `?status&category&page&pageSize` | lista paginada (vista cliente + `hasNews`) |
| POST | `/tickets` | multipart: `title`, `description`, `category`, `contextType?`, `contextId?`, `images[]` | 201, ticket |
| GET | `/tickets/:id` | — | ticket (marca visto) |
| POST | `/tickets/:id/messages` | multipart: `body`, `images[]` | 201, ticket |
| POST | `/tickets/:id/reopen` | JSON `{ body }` | ticket |
| GET | `/tickets/:id/attachments/:fileId` | — | imagen |

**Staff** (permiso `staff.tickets`). `:tenantKey` validado contra `SaaSClients`. `/staff/tickets/summary` se registra **antes** de las rutas con `:tenantKey`:

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/staff/tickets` | `?status&category&tenantKey&page&pageSize` | lista multi-tenant + `warnings` |
| GET | `/staff/tickets/summary` | — | conteos por estado + `warnings` |
| GET | `/staff/tickets/:tenantKey/:id` | — | ticket (vista staff, marca visto) |
| POST | `/staff/tickets/:tenantKey/:id/messages` | multipart: `body`, `images[]` | 201, ticket |
| POST | `/staff/tickets/:tenantKey/:id/status` | JSON `{ status }` | ticket |
| POST | `/staff/tickets/:tenantKey/:id/resolve` | JSON `{ internalResolution }` | ticket |
| PUT | `/staff/tickets/:tenantKey/:id/internal-resolution` | JSON `{ internalResolution }` | ticket |
| GET | `/staff/tickets/:tenantKey/:id/attachments/:fileId` | — | imagen |

**Headers de las imágenes:**
- `Content-Type`: el tipo detectado al subir;
- `Content-Disposition: inline; filename="<nombre saneado>"`;
- `X-Content-Type-Options: nosniff`;
- `Cache-Control: private, max-age=300`.

El adjunto debe pertenecer al ticket (`metadata.ticketId`); si no, 404.

> Antes de la tarea 5 se contrastan rutas y nombres de campos con `02-soporte.md` y con los handlers del mock. Si el contrato dice otra cosa, **manda el contrato**, y la diferencia se anota en la sección "Ejecución".

## Tareas

### Tarea 0 — Línea base y dependencia
- [ ] Sincronizar el espejo y correr la suite unitaria. Confirmar la línea base: 4 suites / 6 pruebas fallando, todas ajenas al panel.
- [ ] `npm install @fastify/multipart@8.3.1 --save-exact`. Reconvertir `package.json` y `package-lock.json` a CRLF y verificar que el diff solo trae la dependencia.
- [ ] Reportar en el chat.

### Tarea 1 — Dominio
- [ ] Pruebas primero: `tests/unit/domain/panelTickets.test.js`.
  - Transiciones: todas las válidas y las inválidas.
  - `hasNews`, formato del código y límites de texto.
  - `imageType`: casos buenos, un SVG o HTML disfrazado de PNG, y un archivo vacío.
  - `eventStatus`.
- [ ] Implementar `tickets.js`, `imageType.js` y `eventStatus.js`. Agregar permisos.
- [ ] Verificar que pasa `hexagonalBoundaries.test.js`.

### Tarea 2 — Modelos, repositorio, GridFS y lector de contexto
- [ ] Pruebas con fakes de conexión (como `panelUserRepository.test.js`).
  - Esquema e índices, y `optimisticConcurrency`.
  - El correlativo usa `$inc` + `upsert`.
  - `getPanelTenantModels` no registra dos veces el mismo modelo.
  - El store GridFS guarda `metadata.ticketId` y `remove` tolera un id inexistente.
  - El lector de contexto proyecta solo los campos del snapshot.
- [ ] Implementar los modelos y adaptadores.

### Tarea 3 — Casos de uso de cliente
- [ ] Pruebas con fakes (`panelFakes.js` ampliado).
  - Crear, con y sin contexto, y con contexto de un id inexistente.
  - Listar con filtros y paginación.
  - Detalle (marca visto; nunca expone `internalResolution`).
  - Responder (`esperando_cliente → en_progreso`; 409 si está resuelto).
  - Reabrir (exige mensaje; `reopenCount++`).
  - Adjunto que no es del ticket → 404.
  - Si falla el guardado después de subir imágenes, se borran.
- [ ] Implementar `ClientTickets.js` y `ticketView.js`.

### Tarea 4 — Casos de uso de staff y bandeja
- [ ] Pruebas.
  - Primer mensaje (fija `firstResponseAt` y pasa `abierto → en_progreso`).
  - Estados permitidos y prohibidos; resolver desde cada estado; nota interna.
  - `tenantKey` desconocido → 404 **sin abrir conexión**: el fake de conexión lo verifica.
  - Bandeja: un tenant que tarda más de 5 s sale en `warnings` y el resto responde; orden por `lastActivityAt`; paginación global.
  - Resumen con `warnings`.
- [ ] Implementar `StaffTickets.js` y `StaffInbox.js`.

### Tarea 5 — HTTP
- [ ] Pruebas en `tests/unit/interfaces/panelTicketsApi.test.js` (con `fastify.inject` y adaptadores falsos inyectados).
  - Cada ruta: 401 sin sesión, 403 sin permiso, 403 si es cliente en rutas de staff (y al revés), y 400 sin `X-Panel-Request` en las que no son GET.
  - Multipart: 6 imágenes → 413; una imagen de 6 MB → 413; un PDF → 415; un JSON donde se espera multipart → 415.
  - La respuesta al cliente nunca trae `internalResolution` (se busca la clave en el JSON crudo).
  - Headers de imagen.
  - Un `tenantKey` que intente el cliente por query o body se ignora.
- [ ] Ampliar `routeAuthWiring.test.js`:
  - tabla de rutas nuevas;
  - multipart registrado solo dentro de `/panel/api`: las rutas admin siguen rechazando multipart igual que hoy.
- [ ] Implementar `multipartImages.js`, los controladores y los cambios en `panelPlugin.js`, `panelErrors.js` y la composición.

### Tarea 6 — Integración y documentación
- [ ] `tests/integration/panelTickets.test.js` con `mongodb-memory-server` (lo corre el usuario en Windows).
  - Flujo completo cliente ↔ staff con dos tenants.
  - Imagen real subida y descargada desde GridFS.
  - Aislamiento entre tenants.
  - Un `tenantKey` inexistente no crea la base: se verifica con `listDatabases`.
- [ ] README, sección 20: tabla de rutas de soporte, límites y nota de las colecciones nuevas por tenant.
- [ ] Sección "Ejecución" en este plan, con las diferencias reales.

### Tarea 7 — Verificación
- [ ] Suite unitaria completa en el espejo. Debe quedar la misma línea base de fallos, más las pruebas nuevas en verde.
- [ ] Revisión de seguridad con un subagente, enfocada en:
  - aislamiento de tenants;
  - fuga de `internalResolution`;
  - subida de archivos (tipos, tamaños, nombres, limpieza);
  - creación de bases por `tenantKey`;
  - DoS de la bandeja.
- [ ] Guía de prueba manual con el front en modo real (`npm run dev`). La corre el usuario.
- [ ] Reporte final en el chat: qué cambió, en qué archivos y por qué.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un `tenantKey` inventado crea bases vacías | Validación contra `SaaSClients` antes de `getTenantConnection`, más una prueba de integración con `listDatabases` |
| Memoria por imágenes en buffer (hasta 25 MB por request) | Límites de multipart en el contexto del panel; el login ya limita quién llega. Si hace falta, se puede pasar a streaming en un plan aparte |
| La bandeja se vuelve lenta con muchos tenants | Paralelo con timeout por tenant, `warnings` e índices por `lastActivityAt`. Revisar si crece mucho el número de tenants |
| `.env` local apunta a una base remota (posible producción) | Solo se crean colecciones nuevas (`Tickets`, `TicketCounters`, `TicketAttachments.*`) en tenants existentes. Avisar antes de probar |
| Multipart afectando rutas existentes | Registrado dentro del plugin encapsulado del panel, más una prueba en `routeAuthWiring` |
| Diferencias entre el contrato y el mock | Manda el contrato; las diferencias se anotan en "Ejecución" |

## Ejecución (2026-10-13)

Plan ejecutado completo, salvo la prueba de integración (la corre el usuario en Windows) y la prueba manual con el front. Como lo dice el propio plan, **donde el plan difería del contrato (`02-soporte.md`), del spec o del mock, se siguió el contrato**:

| Punto del plan | Implementado | Fuente |
|---|---|---|
| Rutas de staff `/staff/tickets/:tenantKey/:id/...` | `/staff/tenants/:tenantKey/tickets/:id/...` | Contrato D3/D10, spec |
| Reabrir → `en_progreso`, body `{ body }` | Reabrir → `abierto`, body `{ message }` | Spec (S11 y tabla), mock |
| Resolver con JSON `{ internalResolution }` | Multipart `message` + `internalResolution` + `images`; deja el mensaje al cliente | Contrato D6, spec S10 |
| Cambio de estado `{ status }`; nota interna `{ internalResolution }` | `{ to }` y `{ text }` | Spec, mock |
| Imágenes PNG/JPEG/WEBP/GIF | PNG, JPEG y WebP (sin GIF) | Spec, contrato D9 |
| Errores 413 `payload_too_large` / 415 | `too_many_images` 400, `invalid_image` 400, `image_too_large` 413; un cuerpo que no es multipart → 400 `validation_error` | Contrato D9 |
| Contexto inexistente → 400 | 404 `not_found` | Contrato D11 |
| Snapshot `{ type, status, lastError, reference }` | Forma genérica completa de E1/E5/E6 (sin `payload`, auditoría, `errors` ni credenciales) | Contrato 03 (sección "Contexto de tickets") |
| `warnings: [{ tenantKey, reason }]` | `warnings: [{ tenantKey, error }]` | Contrato D2 |
| Modelo con `messages.author{...}`, `lastActivityBy` | `authorType/authorId/authorName`, `statusHistory`, `attachments` de apertura, `internalResolution { text, updatedAt, updatedBy }`, `lastPublicAuthorType`, `clientLastSeenAt`/`staffLastSeenAt` | Spec §2 (modelo) |
| Además | `page_window_exceeded` (page × pageSize > 1000) en la bandeja | Contrato D9 |
| `domain/panel/eventStatus.js` | `domain/panel/operationViews.js` (estado y forma genérica de eventos y syncs; reutilizable en el plan 3) | — |
| `optimisticConcurrency` | Compare-and-set por estado en `findOneAndUpdate({ _id, status })` | Mismo objetivo, sin reintentos de versión |

Decisiones del plan que se mantienen: modelos fuera de `registerTenantModels` (helper `getPanelTenantModels`), código `PRINTER-0007`, mensajes sobre `resuelto` → 409, resolver desde cualquier estado menos `resuelto` (el mensaje de resolución fija `firstResponseAt` si estaba vacío), imágenes validadas antes de escribir y borradas si el cambio falla, bandeja en paralelo con 5 s por tenant, GET de detalle marca "visto", F7–F9 fuera.

Además:
- `Ticket` y `TicketCounter` con `autoIndex: false` y `autoCreate: false`: leer (bandeja, resumen) no crea colecciones ni bases. Los índices se crean con el primer ticket del tenant.
- `Cache-Control: no-store` del panel ya no pisa el `private` de las imágenes. Las imágenes suman `Content-Security-Policy: default-src 'none'; sandbox` y `Cross-Origin-Resource-Policy: same-origin`.
- Revisión de seguridad (subagente): sin hallazgos críticos ni altos. Se corrigieron: limpieza de imágenes cuando solo falla el paso `firstResponseAt` (ya no se borran imágenes de un mensaje guardado), `abort()` de una subida a GridFS fallida, rechazo por `Content-Length` > ~26 MB y descarte sin memoria de archivos en campos que no son `images`.
- Pendientes propuestos (no implementados, fuera de este plan): límite de frecuencia y tope de mensajes por ticket; concurrencia máxima en la bandeja; en `tenantDatabase.js` (core) una conexión que falla la primera vez queda en caché hasta reiniciar.

Pruebas: suite unitaria 227 suites / 2796 tests, con los mismos 4 suites / 6 tests rojos previos (ajenos al panel). Nuevas: `tests/unit/domain/panelTickets.test.js`, `tests/unit/infrastructure/panelTicketAdapters.test.js`, `tests/unit/application/panel/{clientTickets,staffTickets,staffInbox}.test.js`, `tests/unit/interfaces/panelTicketsApi.test.js`; `routeAuthWiring.test.js` ampliado con las 14 rutas. Integración: `tests/integration/panelTickets.test.js` (pendiente de correr en Windows).
