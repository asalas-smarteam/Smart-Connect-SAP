# Panel — Plan 7: Tareas programadas (pedido 4r del front, J1 a J5) — Plan de implementación

> **Estado:** aprobado por el usuario ("lo apruebo"), con `nextRunAt` incluido, y ejecutado. Aclaración del usuario: los datos de la base externa no viven en `ClientConfig` sino en `SapCredentials`, que el panel no lee.

**Goal:** vista "Tareas programadas" del panel, **solo lectura**: todas las tareas (`ClientConfigs`)
de la empresa, para cliente y Smarteam.

**Contrato:** `smartHubPanel/docs/contrato-backend/09-tareas-programadas.md` (J1 a J5). Se copia a
este repo con una nota del backend.

**Depende de:** plan 3 (E8 `GET /sync-tasks`, mismo `id` y mapa de tipos), plan 5 (saneo de errores
para cliente) y plan 6 (mismo patrón de rutas y lector).

## Global Constraints

- Solo capa del panel y solo lectura. **No cambia el núcleo:**
  - ni el modelo `ClientConfig`;
  - ni el programador (`sapSyncScheduler.service.js`, `sapSync.queue.js`);
  - ni las rutas admin de configuración.
- Sin `PATCH`, sin "ejecutar ahora". Nada escribe en Mongo ni en Redis.
- `main`, sin ramas. Sin `git add`, `commit` ni `push`. Al terminar, dejar en el chat qué cambió,
  en qué archivos y por qué.

## Aplica a qué tenant

A todos (B1 y S4HANA). `sourcePath` es la ruta relativa guardada:
- B1: `/Items`, `/Orders`;
- S4HANA: `/API_PRODUCT_SRV/A_Product`.

Nunca lleva host.

## Hechos verificados en el código

| Hecho | Dónde |
|---|---|
| El esquema de `ClientConfig` todavía declara campos heredados `externalDb*`. Según el usuario, esos datos viven en `SapCredentials`, que el panel no lee. La lista blanca los deja fuera igual | `models/tenant/ClientConfig.js` |
| Defaults del esquema: `taskType` `SAP_SYNC`, `mode` `INCREMENTAL`, `hubspotBatchSize` 1, `active` `false`, `associationFetchEnabled` y `requireUpdateHubspotID` `false`, listas `[]`, `intervalMinutes`, `startTime` y `endTime` `null` | mismo archivo |
| Filtro: `dynamicType` vale `'datetime'` por defecto **aunque el filtro no sea dinámico** | `clientFilterSchema` |
| `executionDays` se guarda capitalizado (`Monday`…) | enum `EXECUTION_DAYS` |
| `lastRun` y `lastError` los escriben las corridas (`markSyncSucceeded` / `markSyncFailed`) | `MongooseClientConfigRepository` |
| La zona del programador es la constante **no exportada** `SAP_SYNC_SCHEDULER_TIMEZONE = 'America/Costa_Rica'`. Se usa en las tareas por hora (FULL) y en las de ventana. Las de intervalo simple corren "cada N ms" | `sapSyncScheduler.service.js` |
| Cada tarea programada es un job scheduler de BullMQ con id `sap-sync:<tenantKey>:<configId>` o `…:<slot>` si tiene varias horas. Solo se programan tareas activas de tenants activos | `sapSync.queue.js` (`buildScheduledJobId`), `bootstrapScheduledJobs` |
| BullMQ expone `queue.getJobSchedulers()`, cuyos ítems traen `next` (ms de la próxima ejecución). La conexión compartida usa `maxRetriesPerRequest: null`: con Redis caído, un comando espera sin límite | `bullmqRedis.js`, `redis.config.js` |
| Saneo de errores para cliente: `clientErrorText` | `src/domain/panel/errorText.js` |
| Mapa de tipos de E8: `SYNC_TASK_TYPE_MAP` | `src/domain/panel/operationViews.js` |

## Decisiones (cambiables antes de aprobar)

1. **Rutas** (J1), mismo patrón que el plan 6:
   - `GET /scheduled-tasks`, con `requireClientAccount` + `tasks.read`;
   - `GET /staff/tenants/:tenantKey/scheduled-tasks`, con `requireStaffAccount` + `tasks.read`;
   - `:tenantKey` validado contra el directorio antes de abrir la base; si no existe, 404.
2. **Permiso** (J4). `TASKS_READ: 'tasks.read'` para admin, usuario y Smarteam. Sale en
   `/auth/me`; sin él, 403 `forbidden`.
3. **Lectura:**
   - driver nativo sobre `ClientConfigs`, `find({})`;
   - **proyección en lista blanca**, solo los campos de J2. Así no salen de la base ni lo de J3 ni
     los campos heredados del esquema, ni lo que se agregue al modelo después;
   - orden `active: -1, clientName: 1, _id: 1`, `maxTimeMS` 5000 (timeout → 400) y tope de
     1000 tareas con aviso en el log.
4. **Vista** (J2). Igual para cliente y Smarteam, salvo `lastError`:
   - nombres y conversiones de la tabla del contrato;
   - si falta un campo, el default del esquema (es lo que ve la integración): `mode` →
     `incremental`, `batchSize` → 1, `active` → `false`, etc.;
   - texto vacío (`''`) → `null`, como en el plan 6;
   - `type`: con el mapa de E8. Sin valor → `record_sync`; valor desconocido → `null`, como E8;
   - `schedule.days`: en minúsculas. `schedule.times`: tal cual;
   - `schedule.timeZone`: siempre `America/Costa_Rica`;
   - `filters[].dynamicType`: el guardado (o `datetime`) solo si `isDynamic` es `true`; si no,
     `null`;
   - `filters[].value`: tal cual (número, texto, lista o `null`);
   - `lastError`: Smarteam lo ve crudo; el cliente, saneado con `clientErrorText` (G4);
   - **`sourcePath` para cliente:** si por error trae un esquema o host (`://`), se entrega solo
     la ruta. Con los valores actuales no cambia nada; es un resguardo.
5. **Zona del programador:**
   - el núcleo no exporta la constante, y el plan no lo toca;
   - el panel define `SCHEDULER_TIME_ZONE = 'America/Costa_Rica'`;
   - una prueba lee `sapSyncScheduler.service.js` y falla si allá cambia. Así no quedan
     desalineadas sin aviso.
6. **`nextRunAt`** (J5). **Se incluye.** Recomendado; se puede quitar antes de aprobar.
   - Puerto nuevo `ScheduledRunReaderPort.nextRunsFor(tenantKey)` → `Map<configId, Date>`.
   - Adaptador `BullMqScheduledRunReader`: una sola llamada `getSapSyncQueue().getJobSchedulers()`
     por pedido. Filtra los ids `sap-sync:<tenantKey>:<configId>[:slot]`, y para cada tarea toma
     el `next` más cercano entre sus slots.
   - **Nunca bloquea ni tumba la respuesta:**
     - tope de 1,5 s;
     - si Redis no responde o falla, todas las tareas salen con `nextRunAt: null` y se registra
       un aviso.
   - Tarea inactiva o sin programación → `null`.
   - Solo lee Redis: no crea, borra ni mueve jobs.
7. **Arquitectura** (replica la existente):
   - puerto `ScheduledTaskReaderPort.listScheduledTasks(tenantKey)`, implementado con un método
     nuevo en `TenantOperationsReader`;
   - puerto `ScheduledRunReaderPort` (decisión 6);
   - caso de uso nuevo `PanelScheduledTasks`.
   - La resolución de tenant del plan 6 se mueve a un helper `resolveScopeTenant`, que usan
     `PanelFieldMappings` y `PanelScheduledTasks`. `PanelFieldMappings` no cambia de
     comportamiento, y `PanelOperations` no se toca.

## Archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/domain/panel/permissions.js` | Modificar | + `TASKS_READ` |
| `src/domain/panel/scheduledTaskView.js` | Crear | `toScheduledTaskView(raw, { side, nextRunAt })` y `SCHEDULER_TIME_ZONE` |
| `src/application/ports/panel/scheduled-task-reader.port.js` | Crear | Lectura de `ClientConfigs` |
| `src/application/ports/panel/scheduled-run-reader.port.js` | Crear | Próximas ejecuciones |
| `src/infrastructure/database/repositories/TenantOperationsReader.js` | Modificar | + `listScheduledTasks(tenantKey)` |
| `src/infrastructure/queue/BullMqScheduledRunReader.js` | Crear | `nextRunsFor` con tope de tiempo |
| `src/application/use-cases/panel/tenantScope.js` | Crear | `resolveScopeTenant(tenantDirectory, scope)` |
| `src/application/use-cases/panel/PanelFieldMappings.js` | Modificar | Usa el helper (sin cambio de comportamiento) |
| `src/application/use-cases/panel/PanelScheduledTasks.js` | Crear | Resolver tenant, leer tareas y próximas ejecuciones, armar `{ items }` |
| `src/interfaces/http/controllers/panelScheduledTasks.controller.js` | Crear | Handler único cliente/staff |
| `src/interfaces/http/panel/panelPlugin.js` | Modificar | Las dos rutas |
| `src/composition/panel.composition.js` | Modificar | `buildPanelScheduledTaskUseCases`, parámetros `scheduledTaskReader` y `scheduledRunReader` |
| `docs/contrato-backend/09-tareas-programadas.md` | Copiar + nota | Contrato |
| `README.md` | Modificar | Sección 20 |
| Pruebas | Crear / Modificar | Ver abajo |

## Pruebas

- **Dominio:**
  - mapeo de nombres (`sourcePath`, `batchSize`, `associationsEnabled`, `requireCrmIdUpdate`,
    `lastRunAt`) y defaults;
  - `mode`, `objectType` y `days` en minúsculas;
  - `type` con el mapa de E8;
  - `dynamicType` `null` si no es dinámico;
  - **nunca** salen `apiToken`, `sqlQuery`, `apiUrl`, `storeProcedureName`, `update*`,
    `integrationModeId`, `hubspotCredentialId`, `associationFetchConfig`, `externalDb*` ni `__v`,
    aunque vengan en el documento;
  - `lastError` saneado para cliente y crudo para Smarteam;
  - `sourcePath` con host → solo la ruta;
  - la zona coincide con la del programador (prueba de deriva);
  - permisos: `tasks.read` en las listas de `panelPermissions` y `sessionUseCases`.
- **Caso de uso:**
  - lista propia;
  - Smarteam válido;
  - `tenantKey` inexistente → 404 sin leer;
  - empresa sin tareas → `{ items: [] }`;
  - timeout → 400;
  - `nextRunAt` armado;
  - si el lector de próximas ejecuciones falla o tarda, la lista sale igual con `nextRunAt: null`
    y un aviso en el log.
- **Lector Mongo:** proyección en lista blanca (sin campos sensibles), orden, `maxTimeMS` y tope.
- **Adaptador BullMQ:**
  - filtra por tenant (no confunde `acme` con `acme2`);
  - toma el `next` más cercano entre los slots;
  - tope de tiempo;
  - Redis con error → `Map` vacío.
- **HTTP:**
  - cliente 200;
  - Smarteam 200 / 404;
  - cuenta equivocada → 403;
  - sin sesión → 401;
  - `tasks.read` en `/auth/me`;
  - filas nuevas en `routeAuthWiring`;
  - `PanelFieldMappings` sigue pasando sus pruebas.
- **Integración** (Windows): tareas activas e inactivas con `apiToken`, `sqlQuery` y
  `externalDbPassword` guardados. Se verifica el orden, que no salgan esos campos y que leer una
  empresa vacía no cree su base.

## Ejecución

Hecho según el plan, sin desvíos:

- `permissions.js`: `TASKS_READ` para staff, admin y usuario.
- **Nuevos:**
  - `scheduledTaskView.js` (con `SCHEDULER_TIME_ZONE`);
  - los puertos `scheduled-task-reader.port.js` y `scheduled-run-reader.port.js`;
  - `BullMqScheduledRunReader.js`, `tenantScope.js`, `PanelScheduledTasks.js` y
    `panelScheduledTasks.controller.js`.
- `TenantOperationsReader.listScheduledTasks`: lista blanca de campos, orden
  `active: -1, clientName: 1, _id: 1`, `maxTimeMS` y tope de 1000.
- `PanelFieldMappings`: usa `resolveScopeTenant`, sin cambio de comportamiento.
- `panelPlugin.js`: las dos rutas. `panel.composition.js`: `buildPanelScheduledTaskUseCases` y
  los parámetros `scheduledTaskReader` y `scheduledRunReader`.
- **Pruebas:**
  - nuevas: `panelScheduledTaskView` (con la prueba de deriva de la zona), `panelScheduledTasks`,
    `panelScheduledRunReader`, `panelScheduledTasksApi` y la integración `panelScheduledTasks`
    (Windows);
  - ampliadas: `panelOperationsReader`, `routeAuthWiring` y `operationFakes`;
  - actualizadas por el permiso nuevo: `panelPermissions` y `sessionUseCases`.
- Contrato copiado con la nota del backend; README sección 20.
