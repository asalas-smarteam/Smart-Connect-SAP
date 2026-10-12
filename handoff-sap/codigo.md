# Código — mapa del repo, cómo correr local, deploy

> Handoff técnico de Smart-Connect-SAP (conector bidireccional SAP↔HubSpot, multi-tenant). Verificado contra el commit `1305b31` (2026-10-11).

## Mapa de módulos (arquitectura hexagonal, sin DI de terceros)

El repo sigue **arquitectura hexagonal / clean architecture**. El *composition root* (`src/composition/`) son **factory functions puras** (`buildX()`) que ensamblan casos de uso con adaptadores concretos, validando contratos (`ports`) en runtime con `assertPort`. No hay contenedor DI (ni Awilix, ni InversifyJS).

La frontera está verificada por un test propio: `tests/unit/architecture/hexagonalBoundaries.test.js` prohíbe que `application`, `domain`, `ports` y `shared` importen `#infrastructure/*` o paquetes de infraestructura (`axios`, `bullmq`, `fastify`, `ioredis`, `mongoose`, `redis`).

Alias de imports (`package.json`, Node subpath imports):

```
#application/*    → src/application/*
#bootstrap/*      → src/bootstrap/*
#domain/*         → src/domain/*
#infrastructure/* → src/infrastructure/*
#interfaces/*     → src/interfaces/*
#main/*           → src/main/*
#ports/*          → src/ports/*
#shared/*         → src/shared/*
#composition/*    → src/composition/*
#plugins/*        → mapeado, pero la carpeta no existe
```

### `src/domain/` — reglas de negocio puras, sin I/O

| Carpeta | Responsabilidad |
|---|---|
| `business-partners/` | Reglas de clientes/proveedores SAP: factory de estrategia de payload de creación (`legacyWhitelist` vs `fullMapped`). |
| `batches/` | Lotes/vencimientos: factories de estrategia de fuente (`none`, `s4_BatchMaster`) y de proyección hacia HubSpot (`hs_ProductProperties`). |
| `hubspot/` | Reglas de dominio del lado HubSpot (identity properties, batching). |
| `inventory/` | Traslados de inventario (webhook `inventoryTransferRequest`). |
| `orders/` | Documentos de venta (cotizaciones/órdenes), builder de payload por sabor SAP. |
| `owners/` | Resolución de propietario/vendedor (SlpCode vs EmployeeID). |
| `prices/` | Precios de line items, descuentos. |
| `products/` | Estrategias de producto (`OneToOne` vs `OneToMany`), bodegas (`WarehouseStockStrategyFactory`). |
| `purchases/` | Ofertas de compra (OPQT, B1). |
| `sap/` | Lógica compartida de SAP (filtros, opciones de sync FULL/INCREMENTAL). |
| `sync/` | `execution-times.js` (normaliza horarios de ejecución), constantes de dropdown-options. |
| `tenants/` | Resolución de contexto de tenant. |
| `warehouses/` | Estrategias de stock por almacén (B1 `ItemWarehouse` vs S/4 `PlantStorageLocation`). |
| `webhooks/` | Reglas de eventos de webhook (dedup, tipos deduplicados). |

### `src/application/` — casos de uso y servicios, sin acceso directo a infraestructura real

- `use-cases/` — un caso de uso por operación de negocio (`SyncSapConfigToHubspot`, `ProcessHubspotCreateQuotation`, `SyncDropdownOptionsToHubspot`, etc.).
- `services/` — servicios reutilizables sin DB directa: `field-mapping.service.js` (motor central de mapeo SAP→HubSpot), `crmObjectIndex.service.js` (índice en memoria para matching batch), `hubspotPropertyPayload.service.js` (sanitiza payloads), `sap-sync-options.service.js` (decide FULL/INCREMENTAL), `tenant-context.service.js`, `syncTaskRouter.service.js` (rutea por `taskType`), `oauth-state.service.js` (firma HMAC del `state` OAuth), `error-message.service.js`, `secret-fields.service.js` (enmascara secretos en respuestas admin).
- `ports/` — contratos (`createPort`/`assertPort`) que los adapters de infraestructura deben cumplir: `database/`, `hubspot/`, `lock/`, `logger/`, `queue/`, `sap/`.

### `src/infrastructure/` — adaptadores concretos (DB, colas, HTTP externo)

| Carpeta | Responsabilidad |
|---|---|
| `cache/` | Cliente Redis (`redisClient.js`) para la sesión SAP (cookie `B1SESSION` cacheada). |
| `config/` | Repositorios de configuración que leen claves de `Configurations` (phone normalization, batch expiry, warehouse stock, etc.). |
| `database/` | Conexión a Mongo maestra y por tenant (`tenantDatabase.js`), modelos, repositorios por agregado. |
| `external-services/` | Clientes HTTP especializados (solo 3: `HubspotLineItemPriceClient`, `SapLineItemPriceClient`, `SapDiscountClient`). No hay terceros tipo Stripe/Twilio. |
| `hubspot/` | Adaptadores de API de HubSpot. |
| `locks/` | Lock distribuido Redis por tenant (`tenantSapSyncLock.service.js`), evita sync concurrente del mismo tenant. |
| `logger/` | Winston (niveles `error/warn/info/debug`), transports Console + File (`logs/app.log`). |
| `queue/` | Colas BullMQ (`sap-sync`, `webhook-events`), conexión Redis compartida. |
| `repositories/` | Repositorios genéricos (mapping, webhook event, line item price config). |
| `sap/` | Transporte B1/S4, enrichers (`SapRecordEnricherPort`), grabador de auditoría de tráfico (`sapCallRecorder.js`), factory de documento de venta B1/S4. |
| `scheduler/` | `sapSyncScheduler.service.js` (planes de horario), `sapSyncQueueAdmin.service.js` (administración de colas). |
| `sync/` | `syncLog.service.js` (auditoría de corridas, serialización segura para Mongo < 5.0). |
| `tenants/` | Replicación de `ClientConfig` master a tenants nuevos. |
| `webhook/` | Procesamiento de eventos de webhook entrante. |

### `src/interfaces/` — puntos de entrada HTTP y de colas

- `http/` — rutas Fastify (`routes/index.js`: health, config, mapping, oauth, sapSync, dealMapping, ownerMapping, sapCredentials, lineItemPrice, internal, webhook) y middlewares (`tenantResolver.js`, `internalAuth.js`, `adminAuth.js`).
- `jobs/` — `sap-sync.job.js` y `webhook.job.js` (procesadores BullMQ), `workers/sapSync.worker.js` y `workers/webhook.worker.js`, `tasks/sapSyncTask.js` (`runSapSyncOnce`, usado por disparo manual) y `tasks/webhookProcessorTask.js`.

### `src/composition/`, `src/bootstrap/`, `src/main/`

- `composition/` — un builder por caso de uso/agregado (`sap-sync.composition.js`, `hubspot-sync.composition.js`, `webhook-processing.composition.js`, etc.). Es el único lugar donde se conectan dominio + infraestructura real.
- `bootstrap/` — `appLifecycle.bootstrap.js` (hook `onReady`: conexiones externas, scheduler, crons), `bullBoard.js` (dashboard BullMQ en `/admin/queues`).
- `main/` — **dos procesos independientes, misma base de código**:
  - `server.js` — proceso API: Fastify, rutas HTTP, Bull Board, bootstrap de infraestructura.
  - `worker.js` — proceso worker: arranca los dos workers BullMQ (`sap-sync`, `webhook-events`). No expone HTTP ni cron.
  - `app.js` — registra rutas, logging de requests, Bull Board, lifecycle hook.
  - `container.js` — `createApplicationContainer()`, composition root completo para quien necesite todas las dependencias ya ensambladas.

### `src/shared/`

- `errors/` — `ApplicationError` → `ExternalServiceError`, `TenantConfigNotFoundError`, `PermanentWebhookError` (marca errores que no deben reintentarse).
- `utils/` — `batchProcessor.js` (retry por batch), `retry.js`, `object-path.utils.js`, `provisioningValidation.js`.

## Entry points

- **Arranque API local**: `npm run dev` (nodemon sobre `src/main/server.js`).
- **Arranque worker local**: `npm run dev:worker` (nodemon sobre `src/main/worker.js`).
- **Ambos a la vez**: `npm run dev:all` (requiere bash, mata ambos procesos al salir).
- **Producción**: `npm run start:api` / `npm run start:worker` (fijan `NODE_ENV=production`; `npm start` sin más no lo fija).

**Registrar una tarea de sync nueva**: el ruteo por `taskType` vive en `#application/services/syncTaskRouter.service.js` (`resolveSyncUseCase`) y lo comparten el worker BullMQ (`sap-sync.job.js`) **y** el disparo manual (`runSapSyncOnce` en `tasks/sapSyncTask.js`). Cualquier tipo de tarea nuevo debe cablearse en los **dos lados**, o quedará invisible para quien prueba manualmente vía `/sap-sync/run`.

## Cómo correr local

1. **Dependencias**: `npm install`.
2. **Variables de entorno**: copiar `.env.example` a `.env` y completar (placeholders, sin valores reales):
   - `PORT` (default 3000)
   - `MONGODB_URI` — ej. `<MONGO_URI>` (Mongo maestra)
   - `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — `<REDIS_HOST>`, `<REDIS_PORT>`, `<REDIS_PASSWORD>`
   - `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` / `HUBSPOT_REDIRECT_URI` — credenciales de la app OAuth de HubSpot
   - `HUBSPOT_SCOPES` — scopes de la app (ya viene con un valor por defecto razonable)
   - `INTERNAL_KEY` — clave compartida para rutas admin/internas (`x-internal-key`)
   - `JWT_SECRET` — firma del JWT propio de `tenantResolver` para webhooks
   - `SAP_SYNC_CRON_ENABLED` / `WEBHOOK_EVENT_BATCH_SIZE` / `WEBHOOK_EVENT_MAX_RETRIES` / `WEBHOOK_WORKER_CONCURRENCY` / `SAP_SYNC_WORKER_CONCURRENCY`
   - `COMPANY_ADD_FIELDS_URL_SAP` / `PRODUCT_ADD_FIELDS_URL_SAP` / `DEAL_ADD_FIELDS_URL_SAP` — campos extra a traer del Service Layer por entidad
   - `SAP_TEST_FIXED_DATETIME` — **cuidado en producción**: si queda seteada, fija la fecha de referencia del filtro incremental y enmascara corridas que en realidad no traen nada nuevo (ver `decisiones-y-problemas.md`).

   > ⚠️ No reutilices ningún valor que veas en `.env` o en `.env.example` del repo real — varios campos ahí tienen valores de ejemplo con aspecto de credencial real (host/puerto/password de Redis). Pedí al dueño del proyecto las credenciales vigentes por un canal seguro y evaluá si conviene rotarlas.

3. **Levantar Mongo y Redis**: no vienen en el `docker-compose.yml` del repo (ese compose asume que ya existen externamente). Para desarrollo local, levantalos aparte (contenedores sueltos o instalaciones locales) y apuntá `MONGODB_URI`/`REDIS_*` a ellos.
4. **Migraciones**: `npm run migrate:status`, `npm run migrate:up` (usa `migrate-mongo`, config en `migrate-mongo-config.cjs`, migraciones en `scripts/migrations`, módulo ESM).
5. **Probar manualmente una tarea de sync** (sin esperar cron ni encolar en BullMQ):
   - Dejar **activa únicamente** la `ClientConfig` que se quiere probar (desactivar las demás de ese cliente).
   - `POST /sap-sync/run` con header `x-internal-key: <INTERNAL_KEY>` y body opcional `{ "tenantID": "<tenantKey>" }` para acotar a un tenant.
   - Internamente: `sapSync.controller.js` → `SapSyncAdminAdapter` → `runSapSyncOnce()` (`src/interfaces/jobs/tasks/sapSyncTask.js`), que rutea por `taskType` igual que el worker.
   - Análogo para webhooks: `POST /sap-sync/runWebHook` (mismo header, acepta `{ "tenantID": ... }` desde el commit `0d87e80`).

## Tests

- **`npm test` no sirve en Windows**: el script es `NODE_OPTIONS=--experimental-vm-modules jest`, y npm en Windows lo lanza con `cmd.exe`, que no entiende el prefijo `VAR=valor`. Invocar jest directo desde **Git Bash**:

  ```bash
  NODE_OPTIONS=--experimental-vm-modules npx jest \
    --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' \
    --testPathPatterns='tests[\\/]unit[\\/]domain[\\/]miArchivo'
  ```

  Omitir `--testPathPatterns` corre toda la suite del repo.

- **Tres trampas medidas**:
  1. Un patrón de ignore con `/` no matchea nunca en Windows (las rutas van con `\`) — usar `[\\/]`.
  2. Las opciones de array (`--testPathIgnorePatterns`) van **con `=`**; sin `=` se traga los argumentos siguientes y corre la suite completa **en silencio**.
  3. Sin filtro de ignore se levantan también los tests de `.claude/worktrees/*` (copias del repo con su propio `node_modules`) — un test puede fallar desde la raíz y pasar desde su worktree, o viceversa.

- **Baseline conocido (medido en `1305b31`, 2026-10-11)**: 212 suites, **5 rojas / 10 tests** preexistentes — `tests/integration/internalTenant.test.js`, `tests/unit/application/sendMappedItemsToHubspot.test.js`, `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js`, `tests/unit/serviceLayerService.test.js`. Son las mismas cinco desde hace meses — "verde" en este repo significa esas cinco y solo esas. `tests/unit/replicateDefaultSapFilters.test.js` es flaky bajo carga paralela (usa `MongoMemoryServer` real); correrla aislada antes de culpar a un cambio.
- `mongodb-memory-server` (usado en tests de integración) corre ≥ 5.0 y acepta claves Mongo con `$` al inicio — el Mongo de producción es < 5.0 y las **rechaza**. Un test de integración en verde no garantiza que el documento se pueda guardar en producción.

## Deploy

- `Dockerfile`: `node:20-alpine`, `npm ci --omit=dev`, `ENV NODE_ENV=production`, expone puerto 3000, `CMD npm run start:api` (el `docker-compose.yml` sobreescribe el comando para el servicio `worker`).
- `docker-compose.yml` levanta **dos servicios con la misma imagen**: `api` (`npm run start:api`, puerto `${PORT:-3000}:3000`) y `worker` (`npm run start:worker`, sin puerto expuesto). Ambos toman variables de `.env` vía `env_file` y están en `restart: unless-stopped`.
- **Red externa de Mongo obligatoria**: ambos servicios declaran `networks: [default, mongo]`, y `mongo` es externa (`name: mongodb-4-kfyz_default`). En el VPS de producción, Mongo corre en **otro proyecto de compose**; si los contenedores no se unen a esa red, la API falla con `getaddrinfo EAI_AGAIN <host>`, entra en crash-loop (~cada 35s) y nginx devuelve un 502 en HTML (el código custom de HubSpot lo ve como `Unexpected token '<'`). Diagnóstico: `docker logs --tail 100 <contenedor>` buscando `EAI_AGAIN`, y `docker inspect -f '{{json .NetworkSettings.Networks}}' <contenedor>`.
- No hay `volumes:` en el compose: `logs/app.log` vive **dentro del contenedor** y se pierde al recrearlo.
- `app.listen` usa `host: '::'` (dual-stack), no `'0.0.0.0'` (solo IPv4) — importante si se depura con túneles locales que resuelven `localhost` a `::1`.

## Convenciones

- TDD: tests en `tests/unit/` y `tests/integration/`, estructura espejo de `src/`.
- Patrón "parámetro de constructor con default" ha dejado dependencias sin cablear en composition con la suite en verde más de una vez — ver `decisiones-y-problemas.md`. Preferir constructores que **exigan** la dependencia y lancen si falta, en vez de traer un default silencioso.
- Logger: Winston a consola (nivel `info`) + archivo `logs/app.log` (desde `debug`). No hay transports externos (sin Sentry/Datadog). `logs/app.log` es el primer lugar donde mirar ante un error que no llegó a Mongo.

## Fuentes

- Bóveda Obsidian: `01-Arquitectura.md`, `04-Infraestructura.md` (Smart-Connect-SAP, al día con `1305b31`, 2026-10-11).
- Repo: `package.json`, `docker-compose.yml`, `Dockerfile`, `.env.example`, `migrate-mongo-config.cjs`, estructura de `src/`.
- Memoria persistente: `jest-picks-up-worktree-tests.md`, `sap-sync-manual-testing-workflow.md`.
