# Smart-Connect-SAP

## 1. Descripción general
Smart-Connect-SAP es un motor SaaS basado en Fastify que sincroniza datos desde fuentes SAP/BEST hacia HubSpot CRM. La plataforma es multiinquilino: cada configuración de cliente define cómo ingerir datos SAP (llamada API, procedimiento almacenado, script SQL o SAP Business One Service Layer), cómo mapear campos SAP a propiedades de HubSpot y qué credenciales OAuth de HubSpot usar. Un motor de sincronización impulsado por cron se ejecuta en un intervalo fijo (cada minuto) para ingerir registros SAP, transformarlos mediante mapeos administrados en base de datos, enviarlos a HubSpot y, opcionalmente, escribir los IDs de HubSpot de vuelta en SAP. Las conexiones SQL externas (SQL Server/MySQL) son opcionales y quedan fuera de la migración principal a MongoDB.

Capacidades clave:
- **Motor de integración SaaS** con API HTTP en Fastify para configuración, OAuth, mapeos y disparo manual de sincronizaciones.
- **Arquitectura multiinquilino** usando filas de `ClientConfig` por cliente y mapeos compartidos asociados a `hubspotCredentialId`.
- **Opciones de ingesta SAP:** llamada API externa, ejecución de procedimiento almacenado, script SQL crudo contra una base externa o consumo de SAP Business One Service Layer con autenticación de sesión.
- **OAuth de HubSpot por cliente** con pares de `accessToken`/`refreshToken` almacenados.
- **Capa de mapeo** (Field, Pipeline, Stage, Owner) para transformar los datos SAP en propiedades y IDs de HubSpot.
- **Motor de sincronización** programado cada minuto; también admite disparo manual.
- **Configuración impulsada por base de datos** para ingesta, mapeo, tokens OAuth y bitácoras de sincronización.

## 2. Arquitectura de alto nivel
La plataforma se compone de las siguientes piezas en tiempo de ejecución:
- **Backend Fastify (`src/app.js`, `src/server.js`)**: expone rutas REST para salud, mapeos, inicio/retorno de OAuth, disparador de sincronización SAP y utilidades de prueba.
- **Programador cron (`src/tasks/sapSyncTask.js`)**: trabajo de node-cron que corre `*/1 * * * *` para ejecutar `runSapSyncOnce()` (solo se desactiva si `SAP_SYNC_CRON_ENABLED` es `false`).
- **Capa de ingesta SAP (`src/integrations/sap`)**: selecciona un modo basado en `IntegrationMode` ligado a cada `ClientConfig`:
  - **Modo API (`apiMode.js`)**: realiza un HTTP GET con token Bearer opcional.
  - **Modo Procedimiento almacenado (`spMode.js`)**: ejecuta el procedimiento configurado mediante conexión externa a BD.
  - **Modo Script SQL (`scriptMode.js`)**: ejecuta una consulta SQL arbitraria mediante conexión externa.
- **Capa de mapeo (`mapping.service.js`)**: aplica filas de `FieldMapping` para producir `properties` compatibles con HubSpot; los mapeos de deals usan `DealPipelineMapping`, `DealStageMapping` y `OwnerMapping`.
- **OAuth de HubSpot (`hubspotAuthService.js`)**: administra URL de autorización, intercambio de código, refresco y obtención de token de acceso usando valores almacenados de `accessToken`/`refreshToken`.
- **Cliente de HubSpot (`hubspotClient.js`)**: envuelve las APIs de objetos CRM v3 con utilidades de búsqueda/creación/actualización.
- **SyncService (`syncService.js`)**: ejecución por tarea: ingesta de datos SAP, mapeo de registros, upsert en HubSpot, registro de resultados y actualización de metadatos de corrida.
- **Base de datos MongoDB (Mongoose)**: almacena configuraciones, mapeos, credenciales y bitácoras.
- **Comportamiento multiinquilino**: los mapeos y filas de pipeline/etapa/owner se asocian a `hubspotCredentialId`, permitiendo que múltiples tareas `ClientConfig` compartan un mismo portal de HubSpot sin duplicar mapeos.
- **Pooling de BD SAP (`utils/externalDb.js`)**: mantiene conexiones SQL por `clientConfigId` para los modos SP/script y las actualizaciones de retorno (módulo opcional, fuera de la migración principal a MongoDB).

## 3. Estructura de carpetas
```
src/
  app.js
  config/
    database.js
    env.js
  controllers/
    oauth.controller.js
    dealMapping.controller.js
    ownerMapping.controller.js
    mapping.controller.js
    sapSync.controller.js
    ...
  routes/
    oauth.routes.js
    dealMapping.routes.js
    ownerMapping.routes.js
    mapping.routes.js
    sapSync.routes.js
    ...
  services/
    syncService.js
    hubspotService.js
    hubspotClient.js
    hubspotAuthService.js
    sapUpdateService.js
    mapping.service.js
    objectTypeRouter.js
    dealMappingResolver.js
    ownerMapping.service.js
  integrations/
    sap/
      sapService.js
      modes/
        apiMode.js
        spMode.js
        scriptMode.js
  utils/
    externalDb.js
  db/models/
    ClientConfig.js
    FieldMapping.js
    HubspotCredentials.js
    DealPipelineMapping.js
    DealStageMapping.js
    OwnerMapping.js
    SyncLog.js
    LogEntry.js
    IntegrationMode.js
  tasks/
    sapSyncTask.js
  core/
    logger.js
  server.js
```

## 4. Esquema de base de datos (detallado)
Todos los esquemas principales usan **Mongoose/MongoDB**; los nombres de colección reflejan los modelos. Las conexiones externas SQL a SAP/BEST (SQL Server/MySQL) son opcionales y requieren dependencias adicionales, fuera de la migración principal.

### ClientConfig
- **Propósito:** Define la configuración de ingesta SAP, vínculo de credenciales HubSpot, tipo de objeto y comportamiento de sincronización/backfill de un inquilino.
- **Columnas:** `id` (PK, autoincremento), `clientName`, `integrationModeId`, `apiUrl`, `apiToken`, `storeProcedureName`, `sqlQuery`, `intervalMinutes`, `externalDbHost`, `externalDbPort`, `externalDbUser`, `externalDbPassword`, `externalDbName`, `externalDbDialect`, `hubspotCredentialId`, `objectType`, `active` (bool), `lastRun`, `lastError`, `requireUpdateHubspotID` (bool), `updateMethod`, `updateSpName`, `updateTableName`.
- **Uso en sincronización:** Seleccionado por cron o sync manual; determina modo de ingesta, credencial de HubSpot, tipo de objeto, conexión SAP y si se debe propagar el ID de HubSpot.
- **Racional de PK:** `id` identifica cada tarea/cliente y sirve como llave para los pools externos.
- **Relaciones:** Pertenece a `IntegrationMode`; referenciado por `FieldMapping`, `HubspotCredentials` y `SyncLog`.

### HubspotCredentials
- **Propósito:** Almacena tokens OAuth por portal de HubSpot vinculado a un `ClientConfig`.
- **Columnas:** `id` (PK), `clientConfigId`, `portalId`, `accessToken`, `refreshToken`, `expiresAt`, `scope`.
- **Uso en sincronización:** `hubspotAuthService.getAccessToken()` valida/refresca tokens antes de llamadas a HubSpot; `hubspotCredentialId` en `ClientConfig` referencia esta fila.
- **Racional de PK:** Identifica el set de credenciales y permite su reutilización en mapeos.
- **Relaciones:** Vinculado a `ClientConfig`; referenciado por mapeos mediante `hubspotCredentialId`.

### FieldMapping
- **Propósito:** Define mapeos SAP→HubSpot de propiedades para un tipo de objeto específico (contacto, compañía, deal, producto).
- **Columnas:** `id` (PK), `sourceField`, `targetField`, `objectType`, `clientConfigId`, `hubspotCredentialId`, `isActive`.
- **Uso en sincronización:** `mapping.service.mapRecords()` carga mapeos activos por `hubspotCredentialId` y `objectType` para construir `properties`.
- **Racional de PK:** Distingue cada fila de mapeo; permite habilitar/deshabilitar con `isActive`.
- **Relaciones:** Asociado a un `ClientConfig`; su alcance lógico es `hubspotCredentialId`.

### SyncLog
- **Propósito:** Audita cada ejecución de sincronización por `ClientConfig`.
- **Columnas:** `id` (PK), `clientConfigId`, `status`, `recordsProcessed`, `sent`, `failed`, `errorMessage`, `startedAt`, `finishedAt`.
- **Uso en sincronización:** `syncService.run()` escribe logs de éxito/error con conteos procesados y errores.
- **Racional de PK:** Identifica cada corrida para trazabilidad.

### LogEntry
- **Propósito:** Persiste eventos de log de la aplicación emitidos por Winston.
- **Columnas:** `id` (PK), `type`, `payload` (JSON), `level`, `createdAt`.
- **Uso en sincronización:** Usado por el transporte personalizado `LogEntryTransport` para guardar logs en tiempo de ejecución.

### IntegrationMode
- **Propósito:** Enumera modos de ingesta (`STORE_PROCEDURE`, `SQL_SCRIPT`, `API`, `SERVICE_LAYER`).
- **Columnas:** `id` (PK), `name` (único), `description`.
- **Uso en sincronización:** Unido en `sapService.fetchData()` para seleccionar la estrategia de ejecución.

## 5. Flujo de integración SAP
- **Pooling en externalDb.js:** Mantiene una conexión SQL por `ClientConfig.id` hacia BDs SAP; se reutiliza para reducir sobrecarga (fuera de la migración principal a MongoDB).
- **createExternalConnection vs getConnection:** `getConnection(config)` crea o reutiliza una conexión SQL identificada por `config.id`; `initializeExternalConnections()` precalienta pools para configuraciones activas al inicio de la app.
- **Almacenamiento de credenciales:** Host/puerto/usuario/contraseña/nombre/dialecto de la BD externa se almacenan en `ClientConfig` y se usan para las conexiones SQL opcionales.
- **Modos:**
  - **Modo API:** `apiMode.execute()` realiza GET a `apiUrl` con `Authorization: Bearer {apiToken}` opcional y devuelve JSON.
  - **Modo Service Layer:** `serviceLayer.service.execute()` autentica sesión en `POST {serviceLayerBaseUrl}/b1s/v2/Login`, construye una URL segura mediante `buildServiceLayerUrl(clientConfig, mappings)` y ejecuta un `GET` con `$select` dinámico derivado de los mappings activos del `clientConfigId`.
  - **Modo Procedimiento almacenado:** `spMode.execute()` ejecuta `EXEC {storeProcedureName}` mediante la conexión externa.
  - **Modo Script:** `scriptMode.execute()` ejecuta `sqlQuery` con semántica `SELECT`.
- **Punto de entrada del mapeo:** `sapService.fetchData()` carga el `ClientConfig` con `IntegrationMode` y llama el modo adecuado; los resultados se envían a `mapping.service.mapRecords()`.
- **Nota sobre SQL externo:** Para habilitar conexiones SQL externas instala dependencias opcionales (`sequelize` y el driver SQL correspondiente) y configura los campos `externalDb*`; este módulo queda fuera de la migración principal a MongoDB.

## 6. Motor de mapeo (SAP → HubSpot)
- **mapRecords():** Carga filas activas de `FieldMapping` por `hubspotCredentialId` y `objectType`, luego proyecta cada registro SAP a `{ properties: { targetField: value } }` preservando el orden del mapeo.
- **Almacenamiento:** Las filas de `FieldMapping` guardan `sourceField` (columna/clave SAP) a `targetField` (propiedad HubSpot) por `objectType` (`contact`, `company`, `deal`, `product`).
- **Lógica multiinquilino:** Los mapeos se obtienen por `hubspotCredentialId`; los mismos mapeos sirven a cualquier `ClientConfig` ligado a esa credencial, habilitando la reutilización.
- **Enriquecimiento de deals:** Durante el procesamiento de deals, los IDs de pipeline, etapa y owner se resuelven mediante `DealPipelineMapping`, `DealStageMapping` y `OwnerMapping` antes del upsert en HubSpot.
- **Propiedades dinámicas:** Cualquier campo SAP mapeado se convierte en propiedad de HubSpot en el payload saliente; los campos no mapeados se omiten.

## 7. Flujo OAuth de HubSpot
1. **Endpoint de inicio:** `GET /oauth/hubspot/init/:clientConfigId` construye la URL de autorización de HubSpot con el `clientConfigId` como parámetro `state` y redirige al navegador.
2. **Consentimiento en HubSpot:** El usuario aprueba los scopes.
3. **Endpoint de callback:** `GET /oauth/hubspot/callback?code=...&state=...` intercambia el código por tokens.
4. **Intercambio de código:** `hubspotAuthService.exchangeCodeForTokens()` hace POST a `https://api.hubapi.com/oauth/v1/token` con `grant_type=authorization_code`, guardando `accessToken`, `refreshToken`, `expiresAt` y `portalId` en `HubspotCredentials` (inserta o actualiza por `clientConfigId`).
5. **Ciclo de refresco:** `hubspotAuthService.getAccessToken()` revisa `expiresAt`; si expiró, `refreshAccessToken()` intercambia el refresh token por un nuevo access token (y actualiza `refreshToken` si HubSpot entrega uno nuevo).
6. **Almacenamiento:** Los tokens persisten en la tabla `HubspotCredentials`; `clientConfig.hubspotCredentialId` vincula las tareas de sincronización con estas credenciales.

## 8. Motor de sincronización con HubSpot (hubspotService)
### processSingleItem()
- **Buscar/crear/actualizar:** Para cada elemento mapeado, selecciona manejadores por `objectType`:
  - **contact:** busca por email; actualiza si existe o crea si no.
  - **company:** busca por dominio; actualiza si existe o crea si no.
  - **deal:** el preproceso resuelve mapeos de pipeline/etapa/owner; busca por `dealname`; actualiza o crea según corresponda.
  - **product:** busca por `hs_sku`; actualiza o crea.
- **Mapeo de owner/pipeline/etapa:** El preproceso de deals sustituye IDs de HubSpot antes de llamar a la API.
- **Propagación a SAP:** En creación, invoca `sapUpdateService.updateHubspotIdInSap()` para escribir el nuevo ID de HubSpot en SAP cuando está habilitado.
- **Manejo de errores:** Se capturan excepciones; se registran en consola y se retorna `{ ok: false }` para contabilizar fallas.

### sendToHubSpot()
- Obtiene un access token vía el servicio OAuth.
- Valida el tipo de objeto soportado mediante `objectTypeRouter`.
- Itera registros mapeados llamando a `processSingleItem()` por registro.
- Cuenta `sent` vs `failed` y retorna estadísticas agregadas.

## 9. Flujo de actualización SAP (propagación de ID)
- **Bandera:** `ClientConfig.requireUpdateHubspotID` habilita actualizaciones en SAP después de crear objetos en HubSpot.
- **Modo:** Usa la misma conexión externa de BD con:
  - **Procedimiento almacenado:** `updateMethod === 'sp'` ejecuta `updateSpName` con parámetros `@idSap` y `@idHubspot`.
  - **Script:** `updateMethod === 'script'` actualiza `updateTableName` estableciendo el campo SAP mapeado a `hs_object_id` usando el identificador SAP mapeado a `sap_id`.
- **Dependencia de mapeo:** `sapUpdateService` revisa entradas de `FieldMapping` para `hs_object_id` y `sap_id` a fin de ubicar campos de origen SAP.
- **Caso de uso:** Después de crear un registro en HubSpot, el nuevo ID de objeto se escribe en SAP/BEST.

## 10. Ciclo de ejecución de syncService
1. **Disparo:** Cron (`sapSyncTask`) o POST manual `/sap-sync/run` llama `runSapSyncOnce()`.
2. **Carga de configuraciones:** Obtiene todas las filas activas de `ClientConfig`.
3. **Ingesta SAP:** Para cada config, `sapService.fetchData()` ejecuta el modo configurado y devuelve registros SAP.
4. **Mapeo:** `mapping.service.mapRecords()` convierte registros SAP en payloads de HubSpot basados en `hubspotCredentialId` y `objectType`.
5. **Upsert en HubSpot:** `hubspotService.sendToHubSpot()` realiza upsert de cada registro; preprocesa deals; opcionalmente regresa el ID de HubSpot a SAP.
6. **Registro:** `SyncLog` guarda estado, conteos, errores y tiempos; `ClientConfig.lastRun`/`lastError` se actualizan acorde.

## 11. Comportamiento multiinquilino
- **Credenciales por cliente:** Cada `ClientConfig` referencia un `hubspotCredentialId`; los tokens OAuth se almacenan en `HubspotCredentials`.
- **Tarea por ingesta:** Múltiples filas `ClientConfig` pueden apuntar a diferentes fuentes/modos SAP compartiendo credenciales de HubSpot.
- **Ámbito de mapeo:** Todos los mapeos (campo/pipeline/etapa/owner) se asocian a `hubspotCredentialId`, no a `clientConfigId`, evitando duplicación entre tareas que usan el mismo portal de HubSpot.

## 12. Manejo de errores
- **Errores de ingesta SAP:** Los ejecutores de modo capturan y registran errores, devolviendo arreglos vacíos para evitar caídas.
- **Errores de API HubSpot:** `hubspotClient` envuelve las solicitudes y registra metadatos detallados; los errores se propagan a servicios que contabilizan fallos.
- **Registro de sincronización:** `syncService` escribe entradas `SyncLog` con `status='error'` y `errorMessage`; `lastError` se guarda en `ClientConfig`.
- **Mapeos faltantes:** El preproceso de deals lanza errores cuando no existen mapeos de pipeline/etapa, haciendo que el elemento se cuente como fallido.

## 13. Variables de entorno

### Resumen
- `HUBSPOT_CLIENT_ID` – ID de cliente de la app HubSpot para OAuth.
- `HUBSPOT_CLIENT_SECRET` – Secreto de cliente de la app HubSpot para OAuth.
- `HUBSPOT_REDIRECT_URI` – URI de redirección usada en la URL de autorización e intercambio de token.
- `HUBSPOT_SCOPES` – Scopes opcionales separados por coma/espacio agregados a la URL de autorización.
- `MONGODB_URI` – Cadena de conexión MongoDB para metadatos de la aplicación.
- `SAP_SYNC_CRON_ENABLED` – Si es `false`, desactiva el cron; el disparo manual sigue disponible.
- Las credenciales de BD externa SAP se guardan por `ClientConfig` (`externalDbHost`, `externalDbPort`, `externalDbUser`, `externalDbPassword`, `externalDbName`, `externalDbDialect`) y solo aplican si se habilitan conexiones SQL externas.
- `PORT` – Puerto del servidor HTTP (por defecto 3000).

### Tabla `.env`
| Variable | Descripción |
| --- | --- |
| `HUBSPOT_CLIENT_ID` | ID de cliente de la aplicación de HubSpot para el flujo OAuth. |
| `HUBSPOT_CLIENT_SECRET` | Secreto de cliente de la aplicación de HubSpot para el flujo OAuth. |
| `HUBSPOT_REDIRECT_URI` | URI de redirección registrada en HubSpot usada en init/callback. |
| `HUBSPOT_SCOPES` | Lista opcional de scopes separados por coma o espacio para la URL de autorización. |
| `MONGODB_URI` | URI de MongoDB que almacena configuraciones, mapeos, credenciales y logs. |
| `SAP_SYNC_CRON_ENABLED` | Si está en `false`, evita que el cron arranque; permite solo disparo manual. |
| `PORT` | Puerto en el que se levanta Fastify (3000 por defecto). |

## 14. Migraciones de base de datos (MongoDB)
La aplicación **no ejecuta migraciones Sequelize** (se eliminaron los stubs de `src/db/migrations`). Todas las migraciones de esquema/semilla para MongoDB se administran con **migrate-mongo** en `scripts/migrations`.

### Comandos disponibles
- Crear migración: `npm run migrate:create -- <nombre>`
- Ver estado: `npm run migrate:status`
- Aplicar migraciones: `npm run migrate:up`
- Revertir la última migración: `npm run migrate:down`

> Asegúrate de exportar `MONGODB_URI` antes de ejecutar los comandos. Las migraciones son módulos ESM (`export async function up/down`).

## 15. Futuras funcionalidades (roadmap)
- Frontend Next.js con autenticación y botón de conexión a HubSpot.
- UI para configurar objetos, campos y pipelines por inquilino.
- UI para gestión de mapeo de owners de deals.
- Tablero para logs y analítica.
- Sincronización bidireccional (HubSpot → SAP).
- Sincronización masiva y colas de reintento.
- Ingesta vía webhooks para actualizaciones casi en tiempo real.
- Colas de error mejoradas y manejo de dead-letter.
- Publicación en el marketplace de HubSpot.

## 16. Guía de despliegue
- **Requisitos:** Node.js (soporte ESM), instancia MongoDB accesible desde la app, acceso de red a APIs de HubSpot. Acceso a BDs SAP/BEST y dependencias SQL externas solo si se habilitan conexiones SQL opcionales.
- **Configurar `.env`:** Define `MONGODB_URI`, valores OAuth de HubSpot y opcionalmente `SAP_SYNC_CRON_ENABLED`. Las credenciales de BD externa SAP viven en filas de BD, no en `.env`.
- **Instalar e iniciar:**
  ```bash
  npm install
  node src/server.js
  ```
- **Ejecución del cron:** El proceso Fastify inicia el trabajo node-cron automáticamente salvo que esté deshabilitado; no se requiere worker separado.
- **Firewall:** Garantiza acceso saliente a HubSpot y conectividad entrante/saliente a hosts/puertos SQL de SAP definidos en `ClientConfig` si usas conexiones SQL externas.
- **SSL/HTTPS:** Termina TLS con un proxy inverso o ubica Fastify detrás de un terminador HTTPS según necesidad.

## 17. Provisionamiento y pruebas
- **Estrategia de provisioning:** al crear un tenant solo se crean las colecciones MongoDB; no se insertan documentos iniciales para evitar violar `required` en los schemas multi-tenant.
- **Pruebas:** los escenarios de prueba deben crear explícitamente los documentos que usan (por ejemplo `ClientConfig`, `HubspotCredentials`, mapeos y registros de log), sin depender de semillas automáticas.

## 18. Ejemplos de uso
Se asume el servidor en `localhost:3000` y la BD poblada con `ClientConfig` y mapeos.

- **Crear `ClientConfig` en modo `SERVICE_LAYER` (sin `apiUrl` manual):**
  ```bash
  curl -X POST http://localhost:3000/config/client \
       -H "Content-Type: application/json" \
       -d '{
         "clientName": "Obtener Clientes",
         "integrationModeId": "<integrationModeId SERVICE_LAYER>",
         "objectType": "contact",
         "intervalMinutes": 5,
         "serviceLayerBaseUrl": "https://201.7.208.10:23052",
         "serviceLayerPath": "/BusinessPartners",
         "serviceLayerUsername": "manager",
         "serviceLayerPassword": "secret",
         "serviceLayerCompanyDB": "SBODEMOCL",
         "active": true,
         "hubspotCredentialId": "<hubspotCredentialId>",
         "requireUpdateHubspotID": false
       }'
  ```
  > El backend normaliza y construye internamente `apiUrl = {serviceLayerBaseUrl}/b1s/v2{serviceLayerPath}`.

- **Crear mappings para `$select` dinámico por `clientConfigId`:**
  ```bash
  curl -X POST http://localhost:3000/mapping \
       -H "Content-Type: application/json" \
       -d '{
         "sourceField": "CardName",
         "targetField": "firstname",
         "objectType": "contact",
         "clientConfigId": "<clientConfigId>",
         "hubspotCredentialId": "<hubspotCredentialId>"
       }'
  ```
  > Durante la sincronización, el modo `SERVICE_LAYER` consulta mappings activos del `clientConfigId` y arma automáticamente `?$select=...` eliminando duplicados y rechazando campos inválidos.

- **Ejemplo de URL construida automáticamente por el sistema:**
  - `serviceLayerBaseUrl`: `https://201.7.208.10:23052`
  - `serviceLayerPath`: `/BusinessPartners`
  - mappings activos: `CardCode`, `CardName`, `Phone1`, `EmailAddress`
  - URL final de lectura SAP: `https://201.7.208.10:23052/b1s/v2/BusinessPartners?$select=CardCode,CardName,Phone1,EmailAddress`

- **Seguridad OData en Service Layer:**
  - El usuario **no** envía query params OData en `serviceLayerPath`; el backend elimina cualquier `?`/`#` incluido.
  - `$select` se genera únicamente desde `FieldMapping.sourceField` válidos (`[A-Za-z_][A-Za-z0-9_]*`).
  - `$filter` sólo se permite como parámetro interno controlado por backend (`controlledFilter`), con validación estricta de formato.

- **Ejecutar sincronización manual:**
  ```bash
  curl -X POST http://localhost:3000/sap-sync/run
  ```

- **Probar conexión SAP (conceptual):** Usa un `ClientConfig` existente para validar credenciales externas invocando los endpoints del modo configurado o agregando una ruta temporal que llame `testExternalConnection()`.

- **Iniciar OAuth de HubSpot:**
  ```bash
  curl -i http://localhost:3000/oauth/hubspot/init/<<clientConfigId>>
  # Sigue el redirect a HubSpot y luego el redirect a /oauth/hubspot/callback
  ```

- **Probar mapeo:**
  ```bash
  curl -X POST http://localhost:3000/mapping/test \
       -H "Content-Type: application/json" \
       -d '{"data": {"sap_field": "value"}, "hubspotCredentialId": 1, "objectType": "contact"}'
  ```

- **Upsert de mapeo de pipeline de deals:**
  ```bash
  curl -X POST http://localhost:3000/mappings/deals/pipelines/1 \
       -H "Content-Type: application/json" \
       -d '{"sapPipelineKey":"SAP_PIPE","hubspotPipelineId":"default","hubspotPipelineLabel":"Sales"}'
  ```

## 19. Guía de contribución
- **Estilo de código:** ES Modules; preferir async/await y logging estructurado con Winston.
- **Convenciones de carpetas:** Servicios en `src/services`, integraciones bajo `src/integrations`, modelos Mongoose en `src/db/models`, y rutas/controladores en `src/routes`/`src/controllers`.
- **Agregar nuevos tipos de objeto:** Extiende `objectTypeRouter.js`, agrega manejadores de búsqueda/creación/actualización en `hubspotService.js` y asegúrate de tener entradas `FieldMapping` para el nuevo tipo.
- **Agregar nuevos modos SAP:** Crea un modo en `src/integrations/sap/modes`, regístralo en `sapService.fetchData()` mediante una nueva entrada `IntegrationMode`.
- **Flujo de PR:** Incluye pruebas o pasos reproducibles, sigue las prácticas de logging existentes y documenta nuevas variables de entorno al introducirlas.
