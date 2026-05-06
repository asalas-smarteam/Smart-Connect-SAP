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
- `config`: configuracion centralizada derivada de variables de entorno.
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
- `src/app.js` delega el ciclo de vida de conexiones, schedulers y cron jobs a
  `bootstrap/appLifecycle.bootstrap.js`.
- `interfaces/jobs/webhook.job.js` ya no importa services legacy directamente;
  usa un adapter de infraestructura.
- Los contratos de line item price fueron movidos a `src/ports` para evitar
  puertos duplicados dentro de `domain`.
- Los tests de arquitectura bloquean la reintroduccion de rutas test/debug y
  protegen el controller migrado de webhook y los jobs de interfaz contra
  imports legacy.

## Tabla De Migracion

| Archivo actual | Problema detectado | Nueva ubicacion propuesta | Accion | Prioridad |
| --- | --- | --- | --- | --- |
| `src/app.js` | Conserva bootstrap Fastify y schedulers | `interfaces/http`, `config`, `bootstrap` | Adelgazado; lifecycle movido a `bootstrap/appLifecycle.bootstrap.js` | Alta |
| rutas HTTP test/debug | Exponian endpoints no productivos y saltos a services legacy | No aplica | Eliminadas de `interfaces/http/routes` y del route index | Alta |
| `src/interfaces/http/controllers/webhook.controller.js` | Orquestaba tenant, DB y cola directamente | `application/use-cases/QueueHubspotCreateDealWebhook.js` + adapters | Migrado | Alta |
| `src/services/webhookProcessor.js` | Facade legacy de compatibilidad | `application/use-cases`, `domain/orders`, `infrastructure/sap`, `infrastructure/hubspot` | Migrado; eliminar facade cuando no haya imports externos | Alta |
| `src/services/hubspot/syncOrchestrator.js` | Facade legacy de compatibilidad | `application/use-cases/SendMappedItemsToHubspot.js` | Migrado | Alta |
| `src/services/hubspot/associationOrchestrator.js` | Facade legacy de compatibilidad | `application/use-cases/HandleHubspotAssociations.js` | Migrado | Alta |
| `src/services/mapping.service.js` | Facade legacy de compatibilidad | `application/services/field-mapping.service.js` + repositorios tenant | Migrado | Alta |
| `src/services/hubspotClient.js` | Cliente externo dentro de services | `infrastructure/hubspot` | Adapters delegados creados; cliente legacy pendiente de eliminar | Alta |
| `src/services/sapSessionManager.js` | Sesion SAP dentro de services | `infrastructure/sap` | Adapter delegado creado; manager legacy pendiente de eliminar | Alta |
| `src/queues/*.queue.js` | BullMQ vive fuera de infraestructura | `infrastructure/queue` | Adapters delegados creados | Alta |
| `src/workers/*.worker.js` | Wrapper BullMQ | `interfaces/jobs` + `infrastructure/queue` | Migrado; job webhook desacoplado de services directos | Media |
| `src/config/database.js` | Master DB no expuesta como adapter | `infrastructure/database/master` | Wrapper creado | Media |
| `src/config/tenantDatabase.js` | Tenant DB no expuesta como adapter | `infrastructure/database/tenant` | Wrapper creado | Media |
| `src/controllers/*.js` | Facades legacy de compatibilidad | `interfaces/http/controllers` | Rutas activas ya usan interfaces; queda extraer logica de controllers grandes | Media |
| `src/tasks/*.js` | Cron jobs llaman servicios legacy o facades | `interfaces/jobs` | SAP sync migrado; cron wrappers pendientes de adelgazar | Media |

## Reglas De Dependencia

- `domain` no importa nada de infraestructura.
- `application` puede depender de `ports` y `shared`, y recibe adaptadores desde afuera.
- `infrastructure` puede depender de librerias externas y modulos legacy mientras dure la transicion.
- `interfaces` no debe contener logica de negocio compleja.
- Los modelos Mongoose deben quedar detras de repositorios o servicios de tenant.
- Las rutas test/debug no deben registrarse en el API.
- Cada controller migrado debe tener un test de arquitectura que bloquee imports
  hacia `config`, `queues`, `services`, `tasks` y `utils`.
- Los jobs en `interfaces/jobs` no deben importar `services`, `tasks`, `queues`
  ni `utils` directamente.

## Pendiente Para Cierre Total

- Extraer logica de configuracion, OAuth, SAP credentials, owner mapping, deal
  mapping, line item prices e internal tenant desde controllers HTTP hacia casos
  de uso dedicados.
- Migrar SAP sync y line item price para que no importen `src/services` ni
  `src/tasks` desde controllers HTTP.
- Reemplazar imports de infraestructura que todavia delegan en `src/services/*`
  por adapters concretos, especialmente HubSpot client, SAP session, sync log y
  tenant configuration.
- Eliminar facades legacy cuando no queden imports internos ni consumidores externos.
- Endurecer gradualmente los tests de arquitectura para bloquear controllers y
  services legacy en rutas activas.
