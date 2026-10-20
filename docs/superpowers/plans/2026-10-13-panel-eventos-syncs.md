# Panel — Eventos y syncs (solo lectura) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado:** borrador. **Pendiente de aprobación explícita del usuario.** No se toca código hasta entonces.

**Goal:** que el cliente vea los eventos (webhooks) y las corridas de sync de **su** empresa, y que Smarteam vea los de **cualquier** empresa, incluidas las suspendidas.
- Listas paginadas con filtros.
- Detalle de un evento y de una sync.
- Endpoint nuevo de tareas para el filtro de syncs.
- Todo de **solo lectura**.

**Spec:** `docs/superpowers/specs/2026-10-12-panel-soporte-design.md`, §3 (historias E1–E3 de la Fase 1).
**Contrato:** `docs/contrato-backend/03-eventos-y-syncs.md` (E1–E10) y `00-reglas-generales.md`.
**Referencia de comportamiento:** los mocks del front (solo lectura): `src/mocks/handlers/events.js`, `syncs.js`, `scope.js` y `src/mocks/operations.js`.

**Depende de:** los planes 1 (acceso), de endurecimiento y 2 (soporte). Este plan reutiliza:
- `src/domain/panel/operationViews.js` (traducción a nombres genéricos);
- `SaaSClientTenantDirectory` (validar `:tenantKey`);
- `parsePagination`, el formato de errores y el plugin del panel.

**Architecture:** la misma estructura de los planes anteriores (dominio, puertos y casos de uso, infraestructura, HTTP, composición).
- La lectura se hace con el **driver nativo** sobre la conexión del tenant (`connection.db.collection('WebhookEvents' | 'SyncLogs' | 'ClientConfigs')`), no con modelos Mongoose.
- Así, leer no registra modelos ni dispara `autoIndex`/`autoCreate` en ninguna base.

**Tech Stack:** el mismo. Sin dependencias nuevas.

## Global Constraints

- Trabajar en `main`, sin ramas ni worktrees. **No** `git add`, `commit` ni `push`. Al terminar cada tarea, dejar en el chat qué cambió, en qué archivos y por qué.
- **Solo lectura.** Ningún endpoint de este plan escribe en las bases de los tenants.
- **No se tocan el core ni los tenants:**
  - sin cambios en los modelos `WebhookEvent`, `SyncLog` ni `ClientConfig` (sus esquemas e índices quedan igual);
  - sin cambios en `models/tenant/index.js`, `tenantDatabase.js`, `app.js` ni `env.js`;
  - sin cambios en webhooks, syncs, colas ni rutas admin;
  - nada de esto llama a SAP ni a HubSpot.
- **Índices:** este plan **no** crea índices automáticamente. Ver la decisión 1.
- **Tenant del cliente:** sale solo de la sesión. Una cuenta Smarteam en una ruta de cliente → 403 `forbidden`, porque no tiene tenant.
- **Rutas `/staff/tenants/:tenantKey/...`:**
  - solo cuentas Smarteam; una cuenta cliente → 403 `forbidden`, aunque tenga `events.read`;
  - `:tenantKey` se valida contra `SaaSClients` antes de abrir la conexión → 404 `not_found` si no existe;
  - las empresas suspendidas sí se pueden consultar.
- Un `id` de otro tenant o inexistente → 404 `not_found`.
- **Datos que nunca salen:**
  - `payload` y `audit` nunca salen en rutas de cliente, ni siquiera como `null`;
  - en las rutas de staff salen solo con el permiso `staff.events.raw`;
  - de `ClientConfig` solo salen `_id`, `clientName` y `taskType`, porque ahí viven `apiToken` y `externalDbPassword`;
  - los eventos `status: 'report'` nunca salen.
- Formato de error del panel sin cambios. Nombres genéricos en rutas y campos: nada de "sap" ni "hubspot".
- Archivos nuevos en LF; los existentes conservan sus finales de línea.
- Jest como en los planes anteriores. La integración (`mongodb-memory-server`) se corre en Windows.

## Aplica a qué tenant

A **todos** los registrados en `SaaSClients`, B1 y S4HANA por igual: se leen las colecciones comunes `WebhookEvents`, `SyncLogs` y `ClientConfigs`, que tienen la misma forma en todos.

Los estados internos `sap_order_created` y `sap_created_hubspot_error` son los únicos que existen hoy en el enum del modelo. Si un tenant usa otro valor, el evento sale con `status: null` y se loguea un `warn`. Ver el riesgo 3.

## Hechos verificados en el código y en los mocks

| Hecho | Dónde | Consecuencia |
|---|---|---|
| `WebhookEvents` indexa `eventType` y `status` por separado, más un único parcial `{ eventType, payload.deal.hs_object_id, dedupActive }`. No hay índice por `createdAt` | `models/tenant/WebhookEvent.js` | Listas por fecha sin índice: decisión 1 |
| `SyncLogs` no tiene ningún índice y no tiene `createdAt` (`timestamps: false`); se ordena por `startedAt` | `models/tenant/SyncLog.js` | Igual |
| `SyncLog.status` es `completed`, `errored` o `null` (corriendo) | `SyncLog.js` | `running` ↔ `status: null` (E6) |
| `SyncLog.errors` es un array dentro del documento | `SyncLog.js` | Paginación de errores con `$slice` y `$size`, sin traer el array entero |
| `ClientConfig` (colección `ClientConfigs`) guarda `apiToken` y otras credenciales | `ClientConfig.js` | Proyección estricta `{ clientName, taskType }` |
| `ClientConfig.taskType` es `SAP_SYNC` o `DROPDOWN_OPTIONS`; si falta, es `SAP_SYNC` | `domain/sync/dropdown-options.constants.js` | `SYNC_TASK_TYPE_MAP` de `operationViews.js` (ya existe) |
| Hay un script por tenant con dry run y `--apply` | `scripts/migrate-webhook-event-dedup-active.mjs` | Patrón para el script de índices (decisión 1) |
| `migrate-mongo` apunta solo a la base master | `migrate-mongo-config.cjs` | No sirve para índices de tenants |
| Mock: rutas de cliente y de staff con el mismo handler; cliente sin tenant → 403; staff con cuenta cliente → 403; empresa inexistente → 404 | `mocks/handlers/scope.js` | Misma regla |
| Mock: `from` inclusivo, `to` exclusivo; fecha inválida → 400 | `scope.js` | Igual (E3) |
| Mock: detalle de sync con `?errorsPage=&errorsPageSize=` (25 por defecto, máximo 100) | `mocks/handlers/syncs.js` | Igual (E7) |

## Decisiones (cambiables antes de aprobar)

1. **Índices: script aparte que corres tú, no `autoIndex`.**
   - Los índices que pide el spec van en un script nuevo, `scripts/create-panel-operation-indexes.mjs <tenantDbName> [--apply]`, con el mismo patrón que `migrate-webhook-event-dedup-active.mjs`.
   - **Dry run por defecto:** imprime la evidencia (cantidad de documentos, tamaño de la colección, índices actuales y los que faltan) sin escribir nada.
   - Con `--apply` crea los índices que falten. Es idempotente y se corre un tenant a la vez.
   - **No se agregan a los esquemas Mongoose:** así el próximo arranque no los construye solo en los cuatro tenants de producción.
   - Índices propuestos:
     - `WebhookEvents`: `{ createdAt: -1 }`, `{ status: 1, createdAt: -1 }` y `{ 'payload.deal.hs_object_id': 1, createdAt: -1 }` (filtro por referencia, historia E1);
     - `SyncLogs`: `{ startedAt: -1 }` y `{ clientConfigId: 1, startedAt: -1 }` (filtro por tarea).
   - Las APIs funcionan **sin** los índices, solo más lentas: ver la decisión 2. Tú decides cuándo correr `--apply` en producción, con la salida del dry run como evidencia.
   - Alternativa: sin script, y cada consulta queda acotada por el tiempo máximo.
2. **Tiempo máximo por consulta:** `maxTimeMS: 5000` en cada `find`, `countDocuments` y `aggregate`.
   - Si se excede: 400 `validation_error` con el mensaje "La consulta tardó demasiado. Acota el rango de fechas o agrega filtros.".
   - El front ya muestra el `message` de `validation_error`, así que no hay que cambiar el front.
   - Alternativa: un código nuevo `query_timeout` (503), que obliga a ajustar el front y el contrato.
3. **Lectura con el driver nativo**, sin modelos. Leer no crea colecciones, bases ni índices.
   - En la tarea 5 se pasa también a este lector el contexto de los tickets (`TenantTicketContextReader`, plan 2), que hoy registra modelos.
   - Es un cambio interno del panel, sin cambio de comportamiento.
4. **Filtros:**
   - `status`: el valor genérico se traduce al interno (`in_process` → `inprocess`, `destination_created` → `sap_order_created`, etc.). Un valor desconocido → 400.
   - Las listas siempre excluyen `report`.
   - `type`: igualdad exacta con `eventType`. Debe ser un texto; un array → 400.
   - `reference`: igualdad exacta con `payload.deal.hs_object_id`. Si es numérico, se busca como texto **y** como número, porque el tipo guardado depende del origen del webhook.
   - `from` y `to`: fechas ISO; `from` inclusivo, `to` exclusivo. Inválida → 400 "Fecha inválida.".
   - `taskId`: un id de 24 hex; otro formato → 400 "Tarea inválida.". El mock devolvía lista vacía.
5. **Paginación:**
   - `page` y `pageSize` como en el resto del panel (máximo 100).
   - Sin tope de ventana, porque el contrato no lo pide. Una página muy profunda la corta el tiempo máximo de la decisión 2.
6. **Detalle del evento:**
   - cliente: la forma genérica (`operationViews.toEventView`);
   - staff con `staff.events.raw`: además `payload` (tal cual) y `audit` (`sapAudit`, o `null`);
   - staff sin ese permiso: igual que el cliente, sin las claves.
7. **Detalle de sync:** la forma de la lista más `errors: { items, page, pageSize, total }`. Cada ítem se devuelve tal cual (JSON libre, contrato E7).
8. **Tareas en la lista de syncs:** se buscan en una sola consulta los `ClientConfigs` de los `clientConfigId` de la página. Si la tarea ya no existe, `task` sale en `null`.
9. **Sync-tasks (E8):**
   - todas las `ClientConfigs` del tenant, ordenadas por `clientName`;
   - solo `{ id, name, type }`, sin paginar.

## Rutas

Todas `GET`, con sesión y cambio de contraseña al día:

| Ruta | Permiso | Cuenta |
|---|---|---|
| `/events` | `events.read` | cliente (tenant de la sesión) |
| `/events/:id` | `events.read` | cliente |
| `/syncs` | `syncs.read` | cliente |
| `/syncs/:id` | `syncs.read` | cliente |
| `/sync-tasks` | `syncs.read` | cliente |
| `/staff/tenants/:tenantKey/events` | `events.read` | Smarteam |
| `/staff/tenants/:tenantKey/events/:id` | `events.read` (+ `staff.events.raw` para `payload`/`audit`) | Smarteam |
| `/staff/tenants/:tenantKey/syncs` | `syncs.read` | Smarteam |
| `/staff/tenants/:tenantKey/syncs/:id` | `syncs.read` | Smarteam |
| `/staff/tenants/:tenantKey/sync-tasks` | `syncs.read` | Smarteam |

- "Cuenta cliente" quiere decir que el usuario tiene `tenantKey`; si no lo tiene → 403.
- "Cuenta Smarteam" quiere decir `accountType: 'smarteam'`; si no lo es → 403.
- Se agregan dos guardas en `panelSession.js`: `requireClientAccount` y `requireStaffAccount`.

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/domain/panel/operationViews.js` | Modificar | + `EVENT_STATUS_FROM_API` (inverso de E1), `SYNC_STATUS_VALUES`; `toEventView(raw, { withRaw })` |
| `src/application/ports/panel/operations-reader.port.js` | Crear | `listEvents`, `findEvent`, `listSyncs`, `findSync`, `findTasks`, `listTasks` |
| `src/application/use-cases/panel/operationFilters.js` | Crear | Validación y traducción de filtros (decisiones 4 y 5) |
| `src/application/use-cases/panel/PanelOperations.js` | Crear | Casos de uso de eventos, syncs y tareas para un tenant ya resuelto |
| `src/application/use-cases/panel/panelReasons.js` | Modificar | + `QUERY_TIMEOUT` (traducido a 400 `validation_error` con mensaje) |
| `src/infrastructure/database/repositories/TenantOperationsReader.js` | Crear | Driver nativo, proyecciones estrictas, `maxTimeMS`, `$slice` y `$size` para los errores |
| `src/infrastructure/database/repositories/TenantTicketContextReader.js` | Modificar | Delegar en `TenantOperationsReader` (decisión 3) |
| `src/interfaces/http/panel/panelSession.js` | Modificar | + `requireClientAccount`, `requireStaffAccount` |
| `src/interfaces/http/panel/panelErrors.js` | Modificar | Mapeo de `QUERY_TIMEOUT` |
| `src/interfaces/http/controllers/panelOperations.controller.js` | Crear | Resuelve el tenant (sesión o `:tenantKey` validado) y llama al caso de uso |
| `src/interfaces/http/panel/panelPlugin.js` | Modificar | Las 10 rutas |
| `src/composition/panel.composition.js` | Modificar | `buildPanelOperationUseCases` |
| `scripts/create-panel-operation-indexes.mjs` | Crear | Dry run con evidencia y `--apply` por tenant (decisión 1) |
| `README.md` | Modificar | Sección 20: rutas y cómo usar el script de índices |

## Tareas

### Tarea 0 — Línea base
- [ ] Sincronizar el espejo y correr la suite unitaria. Debe dar 227 suites, con los 4 suites / 6 tests rojos previos.

### Tarea 1 — Dominio y filtros
- [ ] Pruebas primero, en `tests/unit/domain/panelOperationViews.test.js` y `tests/unit/application/panel/operationFilters.test.js`:
  - mapa inverso de estados; `report` nunca es filtrable;
  - `running` ↔ `null`;
  - `withRaw` agrega `payload` y `audit`; sin `withRaw`, las claves no existen;
  - fechas válidas e inválidas, con `from` inclusivo y `to` exclusivo;
  - `reference` numérica genera los dos tipos;
  - `taskId` inválido;
  - arrays y objetos en la query → 400.
- [ ] Implementar.

### Tarea 2 — Lector nativo
- [ ] Pruebas con una conexión falsa (`db.collection()` con `find`, `countDocuments` y `aggregate` simulados), en `tests/unit/infrastructure/panelOperationsReader.test.js`:
  - las proyecciones excluyen `payload` y `sapAudit` salvo con `withRaw`, `errors` en las listas, y todo lo de `ClientConfig` menos `clientName` y `taskType`;
  - el filtro siempre lleva `status: { $ne: 'report' }` o un `$in` de estados visibles;
  - `maxTimeMS` en cada operación;
  - los errores de la sync se paginan con `$slice` y `$size`;
  - un id inválido devuelve null sin conectar;
  - un `MaxTimeMSExpired` (código 50) se traduce a un error de tiempo máximo.
- [ ] Implementar `TenantOperationsReader` y su puerto.

### Tarea 3 — Casos de uso
- [ ] Pruebas con un lector falso, en `tests/unit/application/panel/panelOperations.test.js`:
  - lista de eventos con cada filtro, orden por `createdAt` desc y paginación;
  - detalle con y sin `withRaw`; id de otro tenant → `NOT_FOUND`;
  - syncs con su tarea (una sola consulta de tareas por página) y con tarea borrada (`null`);
  - detalle con errores paginados (por defecto 25, máximo 100, 400 si es inválido);
  - sync-tasks;
  - tiempo máximo excedido → `QUERY_TIMEOUT`.
- [ ] Implementar `PanelOperations` y los cambios en `panelReasons`.

### Tarea 4 — HTTP
- [ ] Pruebas en `tests/unit/interfaces/panelOperationsApi.test.js` y `routeAuthWiring.test.js` (las 10 rutas):
  - 401 sin sesión;
  - cuenta Smarteam en una ruta de cliente → 403;
  - cuenta cliente en una ruta de staff → 403;
  - `:tenantKey` inexistente → 404 **sin abrir conexión**;
  - empresa suspendida → 200;
  - `payload` y `audit` solo con `staff.events.raw` en la ruta de staff (se busca la clave en el JSON crudo de las respuestas de cliente);
  - ningún campo de respuesta contiene "sap" ni "hubspot", salvo dentro de `payload`/`audit` o del texto de un error;
  - tiempo excedido → 400 con su mensaje.
- [ ] Implementar las guardas, el controlador, las rutas y la composición.

### Tarea 5 — Contexto de tickets con el lector nativo
- [ ] `TenantTicketContextReader` delega en `TenantOperationsReader`. Las pruebas del plan 2 siguen en verde sin cambiar lo que esperan.

### Tarea 6 — Script de índices
- [ ] `scripts/create-panel-operation-indexes.mjs`:
  - sin `--apply` no escribe nada: imprime, por colección, cantidad de documentos, `storageSize`, índices actuales y faltantes;
  - con `--apply` crea solo los faltantes;
  - sin `MONGODB_URI` sale con error (no apunta a localhost en silencio).
- [ ] Prueba de integración del script con `mongodb-memory-server` (en Windows): el dry run no crea nada; `--apply` crea los cinco índices; correrlo dos veces no cambia nada.

### Tarea 7 — Integración y documentación
- [ ] `tests/integration/panelOperations.test.js`:
  - datos reales en dos tenants;
  - filtros por fecha, estado y referencia (texto y número);
  - los `report` nunca salen;
  - errores paginados de una sync con 60 errores;
  - leer una empresa sin datos no crea su base (se verifica con `listDatabases`).
- [ ] README, sección 20: rutas y uso del script (dry run primero, `--apply` por tenant).
- [ ] Sección "Ejecución" en este plan.

### Tarea 8 — Verificación
- [ ] Suite unitaria completa, con la misma línea base de fallos más las pruebas nuevas en verde.
- [ ] Revisión de seguridad con un subagente, enfocada en:
  - aislamiento entre tenants;
  - fuga de `payload`, `audit` y credenciales de `ClientConfig`;
  - inyección por la query;
  - costo de las consultas sin índice.
- [ ] Guía de prueba manual con el front en modo real.
- [ ] Reporte final en el chat: qué cambió, en qué archivos y por qué.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Consultas lentas en tenants con muchos eventos y sin índice por fecha | `maxTimeMS` de 5 s y mensaje para acotar; el script de índices, con evidencia, cuando lo decidas |
| `countDocuments` sobre colecciones grandes | El mismo tiempo máximo. Si molesta, un plan aparte puede pasar a "más de N" o usar `estimatedDocumentCount` sin filtros |
| Estado interno no previsto en un tenant (otro sistema destino) | Sale como `null` y se loguea un `warn`; se agrega al mapa cuando aparezca. El front lo muestra como `invalid_response`, así que conviene verlo en la prueba manual con datos reales de cada tenant |
| `payload` con datos sensibles del CRM visibles para Smarteam | Solo con `staff.events.raw` y en la ruta de staff; nunca en rutas de cliente (lo cubren pruebas) |
| `.env` local apunta a una base remota | Este plan solo lee. El script de índices es dry run salvo `--apply` explícito |

## Fuera de este plan

- Reintentar eventos (E4), portada de estado (E5), eventos de precios (E6), pestaña de reportes (E7) y logs técnicos (E8): son de las Fases 2 y 3.
- Tableros y métricas F1–F9 (`05-tableros-y-metricas.md` del front): necesitan un plan propio.

## Ejecución (2026-10-13)

Ejecutado completo, salvo las pruebas de integración (las corre el usuario en Windows) y la prueba manual con el front.

Diferencias con el plan:
- **Estado de evento desconocido:** `isVisibleEvent` ahora oculta solo `report`. Un estado interno sin traducción sale con `status: null` y un `warn`, como decía el riesgo 3; antes se ocultaba.
- **Estado de sync:** `toSyncView` deja pasar solo `completed`, `errored` y `running` (null interno). Un valor desconocido sale como `null`. Los `skippedReasons` mal formados se ignoran en vez de romper la lista.
- **Revisión de seguridad** (subagente): sin hallazgos críticos ni altos. Se aplicaron:
  - tope de desplazamiento: `page × pageSize` (y lo mismo para los errores de una sync) de hasta 10 000; si se pasa, `400 validation_error` antes de consultar, en vez de un 500 de Mongo;
  - el script de índices solo acepta bases con el prefijo de tenant (`TENANT_DB_PREFIX`, por defecto `sap_integration_`).
- **Contexto de tickets:** `TenantTicketContextReader` delega en `TenantOperationsReader`. Sus tres pruebas unitarias se reescribieron a la delegación; las de casos de uso y HTTP del plan 2 no cambiaron.

Pendientes propuestos (no implementados):
- Auditar las lecturas de `payload`/`audit` por Smarteam.
- `countDocuments` acotado en tenants grandes.
- Revisar qué texto guardan `lastError`, `errorMessage` y `errors` antes de mostrarlo a clientes.
- En el core (`tenantDatabase.js`): una conexión que falla la primera vez queda en caché hasta reiniciar.

Pruebas:
- Suite unitaria: 232 suites / 2890 tests, con los mismos 4 suites / 6 tests rojos previos.
- Nuevas: `tests/unit/domain/panelOperationViews.test.js`, `tests/unit/application/panel/{operationFilters,panelOperations}.test.js`, `tests/unit/infrastructure/panelOperationsReader.test.js`, `tests/unit/interfaces/panelOperationsApi.test.js`.
- `routeAuthWiring.test.js` ampliado con las 10 rutas.
- Integración: `tests/integration/panelOperations.test.js`, que incluye el script de índices.
