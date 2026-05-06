# Arquitectura Hexagonal Multi-Tenant

Este documento describe la migracion base del Plan 1. La meta es separar contratos,
adaptadores e interfaces de entrada sin cambiar el comportamiento actual.

La estrategia aprobada es reemplazo in-place: no se crea una v2 del proyecto, no se
crean rutas `/v2` y los entrypoints actuales deben migrar gradualmente hasta usar
solo `interfaces`, `application`, `domain`, `ports` e `infrastructure`.

## Capas

- `domain`: conceptos y reglas de negocio puras. No debe importar Fastify, BullMQ,
  Mongoose, Axios, Redis, SAP ni HubSpot.
- `application`: casos de uso y servicios de aplicacion. Coordina flujos usando
  dependencias inyectadas o factories, no detalles de infraestructura.
- `ports`: contratos JSDoc para SAP, HubSpot, base de datos y colas.
- `infrastructure`: adaptadores concretos para SAP, HubSpot, MongoDB, BullMQ y logger.
- `interfaces`: entradas HTTP y jobs. Deben traducir entrada/salida y llamar casos de uso.
- `shared`: errores y utilidades transversales sin dependencias de framework.

## Estado Actual

La migracion es in-place. Las rutas HTTP activas viven en `src/interfaces/http/routes`,
los jobs activos viven en `src/interfaces/jobs`, y los flujos principales de health,
webhook processor, SAP sync, line item prices, mapping y sync HubSpot ya tienen casos
de uso o servicios de aplicacion con adaptadores de infraestructura.

Avance del Plan 2:

- La suite completa queda verde como gate base de refactor.
- Las rutas HTTP de prueba/debug (`dbTest`, `testHS`, `hubspotTest`,
  `associationTest` y `echo_test`) ya no estan expuestas.
- El webhook `createDeal` ya entra por controller fino, caso de uso de aplicacion
  y adapters de infraestructura para tenant, persistencia del evento y cola.
- Los entrypoints viven en `src/main`: `app.js`, `server.js`, `worker.js` y
  `container.js`.
- `src/main/app.js` delega el ciclo de vida de conexiones, schedulers y cron jobs
  a `bootstrap/appLifecycle.bootstrap.js`.
- `interfaces/jobs/webhook.job.js` ya no importa services legacy directamente;
  usa un adapter de infraestructura.
- Los controllers HTTP activos ya no importan `src/services`, `src/tasks`,
  `src/queues`, `src/utils`, `src/config` ni `src/integrations` directamente.
- Las facades legacy en `src/controllers/*.js` fueron eliminadas; los imports
  internos y tests apuntan a `src/interfaces/http/controllers`.
- `sapSync`, `lineItemPrice`, `masterClientConfig` y resolucion de tenant models
  usan adapters de infraestructura en vez de acoplar controllers a services/utilidades.
- El dominio ahora contiene una entidad pura para validar webhooks createDeal de
  HubSpot, ademas del servicio de construccion de ordenes SAP.
- Los contratos de line item price fueron movidos a `src/ports` para evitar
  puertos duplicados dentro de `domain`.
- Los roots legacy `src/config`, `src/core`, `src/db`, `src/integrations`,
  `src/lib`, `src/middleware`, `src/queues`, `src/services`, `src/tasks`,
  `src/utils`, `src/workers`, `database` y `models` fueron eliminados o movidos
  a capas hexagonales.
- Los tests de arquitectura bloquean la reintroduccion de rutas test/debug y
  protegen controllers HTTP, jobs de interfaz, capas internas y roots legacy
  contra regresiones.

## Tabla De Migracion

| Archivo actual | Problema detectado | Nueva ubicacion propuesta | Accion | Prioridad |
| --- | --- | --- | --- | --- |
| `src/app.js`, `src/server.js`, `src/worker.js` | Entry points en raiz de `src` | `src/main` | Movidos a `main`; scripts actualizados | Alta |
| rutas HTTP test/debug | Exponian endpoints no productivos y saltos a services legacy | No aplica | Eliminadas de `interfaces/http/routes` y del route index | Alta |
| `src/interfaces/http/controllers/*.js` | Importaban services/tasks/utils/config legacy | `application/use-cases` + `infrastructure/*` adapters | Controllers activos desacoplados de roots legacy directos | Alta |
| `src/interfaces/http/controllers/webhook.controller.js` | Orquestaba tenant, DB y cola directamente | `application/use-cases/QueueHubspotCreateDealWebhook.js` + adapters | Migrado con dominio `HubspotCreateDealWebhook` | Alta |
| `src/services/webhookProcessor.js` | Facade legacy de compatibilidad | `infrastructure/webhook/webhookProcessor.js` + `application/use-cases` | Movido fuera de `src/services` | Alta |
| `src/services/hubspot/syncOrchestrator.js` | Facade legacy de compatibilidad | `infrastructure/hubspot/syncOrchestrator.js` + `application/use-cases/SendMappedItemsToHubspot.js` | Movido fuera de `src/services` | Alta |
| `src/services/hubspot/associationOrchestrator.js` | Facade legacy de compatibilidad | `infrastructure/hubspot/associationOrchestrator.js` + `application/use-cases/HandleHubspotAssociations.js` | Movido fuera de `src/services` | Alta |
| `src/services/mapping.service.js` | Facade legacy de compatibilidad | `infrastructure/database/repositories/mapping.service.js` + `application/services/field-mapping.service.js` | Movido fuera de `src/services` | Alta |
| `src/services/hubspotClient.js` | Cliente externo dentro de services | `infrastructure/hubspot/hubspotClient.js` | Movido fuera de `src/services` | Alta |
| `src/services/sapSessionManager.js` | Sesion SAP dentro de services | `infrastructure/sap/sapSessionManager.js` | Movido fuera de `src/services` | Alta |
| `src/services/*` | Raiz legacy mezclaba aplicacion, dominio e infraestructura | Capas hexagonales existentes | Eliminada; imports actualizados | Alta |
| `src/queues/*.queue.js` | BullMQ vive fuera de infraestructura | `infrastructure/queue` | Movido; adapters apuntan a infraestructura | Alta |
| `src/workers/*.worker.js` | Wrapper BullMQ | `interfaces/jobs/workers` + `infrastructure/queue` | Migrado | Media |
| `src/config/*.js` | Configuracion en root legacy | `infrastructure/config` y `infrastructure/database/*` | Movido | Media |
| `src/db/models/**/*.js`, `models/**/*.js` | Modelos Mongoose fuera de infraestructura | `infrastructure/database/models` | Movido | Media |
| `src/controllers/*.js` | Facades legacy de compatibilidad | `interfaces/http/controllers` | Eliminadas | Media |
| `src/tasks/*.js` | Cron jobs llaman servicios legacy o facades | `interfaces/jobs/tasks` + `infrastructure/scheduler` | Movido | Media |
| `src/utils/*.js`, `src/lib/*.js`, `src/middleware/*.js`, `src/integrations/**/*.js` | Utilidades/adapters en roots legacy | `shared`, `interfaces` e `infrastructure` | Movido | Media |

## Reglas De Dependencia

- `domain` no importa nada de infraestructura.
- `application` puede depender de `ports` y `shared`, y recibe adaptadores desde afuera.
- `infrastructure` puede depender de librerias externas y detalles concretos.
- `interfaces` no debe contener logica de negocio compleja.
- Los modelos Mongoose deben quedar detras de repositorios o servicios de tenant.
- Las rutas test/debug no deben registrarse en el API.
- Cada controller migrado debe tener un test de arquitectura que bloquee imports
  hacia `config`, `queues`, `services`, `tasks` y `utils`.
- Los jobs en `interfaces/jobs` no deben importar `services`, `tasks`, `queues`
  ni `utils` directamente.
- Los roots legacy eliminados no deben volver a existir; cualquier nuevo
  comportamiento debe ubicarse en la capa correspondiente.

## Pendiente Para Cierre Total

- Seguir adelgazando controllers HTTP hasta que la composicion de dependencias
  viva preferiblemente en rutas/factories o container dedicado.
- Seguir refinando nombres de adapters movidos desde roots legacy para reducir
  sufijos como `.service` donde ya exista un adapter con contrato claro.
- Reducir dependencias directas desde `interfaces` hacia adapters concretos,
  moviendo composicion repetida al container/factories.
