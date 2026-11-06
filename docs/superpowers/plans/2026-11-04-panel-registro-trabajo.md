# Panel — Plan 10: registro de trabajo desde Claude (contrato 12, M1 a M8) — Plan de implementación

> **Estado:** aprobado por el usuario ("ejecuta el plan 12-registro-trabajo.md", usando
> subagentes) y ejecutado. El contrato `docs/contrato-backend/12-registro-trabajo.md` es la especificación;
> este archivo lo baja a tareas y registra los hechos y desvíos.

**Goal:**
- tokens personales `spn_…` para cuentas de Smarteam;
- buscar un ticket por código;
- publicar un registro de trabajo: un resumen público y horas internas, con idempotencia;
- `workLog` en el detalle de Smarteam.

## Global Constraints

- Solo la capa del panel. **No cambia el núcleo** (webhooks, syncs, rutas admin, OAuth,
  Bull Board, `src/main/app.js`).
- Las rutas y respuestas existentes no cambian, salvo `workLog` en el detalle de Smarteam (M6).
  El cliente nunca ve horas.
- `main`, sin ramas. Sin `git add`, `commit` ni `push`.
- Arquitectura hexagonal: puertos con `createPort`/`assertPort` y dominio puro. En
  `application`, `domain`, `ports` y `shared` no se importa `infrastructure`, `mongoose`,
  `fastify`, `redis`, `ioredis`, `bullmq` ni `axios` (lo prueba `hexagonalBoundaries.test.js`).
- Pruebas: `NODE_OPTIONS=--experimental-vm-modules npx jest --runTestsByPath <archivos>`, en
  tandas de menos de 170 s. Las de integración (MongoMemoryServer) solo corren en Windows.

## Aplica a qué tenant

A todos. Los tokens y las claves de idempotencia viven en la master; las entradas de horas, en
el ticket de cada tenant.

## Hechos verificados en el código

| Hecho | Dónde |
|---|---|
| El guard `createPanelRequestGuard` hace, en orden, IP → CSRF (`X-Panel-Request` en mutaciones) → `config.panelPublic` → cookie (`resolveSession.execute({ token })`) → `password_change_required` | `src/interfaces/http/panel/panelSession.js` |
| `ResolvePanelSession` carga el usuario en cada request y arma `{ id, name, email, accountType, role, tenantKey, permissions }` | `ResolvePanelSession.js` |
| `ChangePanelPassword` responde `fail(INVALID_CURRENT_PASSWORD, 'La contraseña actual no es correcta.')` → 400 `invalid_current_password` | `ChangePanelPassword.js`, `panelErrors.js` |
| `RedisLoginAttempts({ keyPrefix, maxAttempts, windowSeconds })`: `consume(key)` → `{ blocked, firstBlocked }` y `reset(key)`. Cuenta **antes** de verificar y la clave se guarda hasheada | `src/infrastructure/auth/RedisLoginAttempts.js`, `login-attempts.port.js` |
| Hoy `sendFailure` no pone headers: el 429 de login sale **sin** `Retry-After` | `panelErrors.js` |
| `StaffTickets.reply`/`resolve` usan `applyTicketChange` (CAS por `expectedStatus`), `messageEntry`, `historyEntry` y `setIfNull: { firstResponseAt }` | `StaffTickets.js`, `ticketCommon.js` |
| `MongooseTicketRepository.update`: un `findOneAndUpdate({ _id, status: expectedStatus })` con `$set`/`$inc`/`$push`. `setIfNull` va **aparte** (`updateOne` con `[campo]: null`) | `MongooseTicketRepository.js` |
| `Ticket` tiene índice único en `number`; `toTicket` mapea campo por campo | `models/panel/Ticket.js` |
| `ticketCodePrefix(tenantKey, tenantDbPrefix)` y `ticketCode(...)` existen | `src/domain/panel/tickets.js` |
| `tenantDirectory.listAll()` trae todas las empresas, también las suspendidas | `SaaSClientTenantDirectory.js` |
| `ManagePanelUsers.update` (con `deactivating`) y `resetPassword` | `ManagePanelUsers.js` |
| `AUDIT_DETAIL_KEYS` filtra `details` por acción | `src/domain/panel/auditActions.js` |

## Desvíos y decisiones del backend

1. **`firstResponseAt`:** sigue el patrón actual de `setIfNull`, una escritura condicional
   aparte después del `findOneAndUpdate` principal. Mensaje, estado, resolución interna y
   entrada de horas sí van en la misma actualización (M5).
2. **`redact` del logger de Fastify (M7): no se hace.** Es `src/main/app.js`, que pertenece al
   núcleo, así que queda pendiente de decisión del usuario.
   - Hoy Fastify no loguea headers por defecto y el manejador de errores del panel tampoco.
   - Revisar nginx (`$http_authorization`) queda como tarea de infraestructura.
3. **`Retry-After`:** `fail()` acepta un `retryAfterSeconds` opcional y `sendFailure` lo pone como
   header. Solo lo usan los límites nuevos; el login no cambia.
   - Por token: 60 s.
   - `pwdcheck` y la IP: 900 s.
4. **Revocación al desactivar o restablecer:** se hace después de guardar el cambio del usuario.
   Si falla, el error se propaga (500) y el admin reintenta. El estado del usuario igual corta el
   token en cada uso.
5. **Límite de tokens inválidos por IP:** solo con proxies de confianza (`ipLimitEnabled`, como
   el login). Se cuenta cada token inválido.

## Tareas (ejecución con subagentes, una por vez)

**T1. Dominio y errores.**
- `src/domain/panel/apiTokens.js`: constantes, formato y `isActiveToken`.
- `src/domain/panel/workLog.js`:
  - `checkWorkLogInput`: tabla de M5, devuelve campos normalizados o mensaje;
  - `checkIdempotencyKey`;
  - `workLogFingerprintSource`: JSON canónico, sin hash;
  - `toWorkLogView` y `totalHours`.
- `parseTicketCode` en `tickets.js`.
- Acciones de auditoría y sus `AUDIT_DETAIL_KEYS`.
- `panelReasons`: `INVALID_TOKEN`, `TOKEN_LIMIT`, `AMBIGUOUS_CODE`, `REQUEST_IN_PROGRESS` e
  `IDEMPOTENCY_KEY_REUSED`, con su mapeo en `panelErrors.js`, más `retryAfterSeconds` (decisión 3).
- Pruebas unitarias del dominio.

**T2. Infraestructura y puertos.**
- Puertos `api-token-repository`, `api-token-codec` e `idempotency-store`.
- `ticket-repository`: `findByNumber` y, en `update`, `pushWorkLog` e `idempotencyGuard`.
- Modelos `PanelApiToken` y `PanelIdempotencyKey`, con sus índices (M2 y M5).
- Adaptadores `MongoosePanelApiTokenRepository`, `MongooseIdempotencyStore` y `RandomApiToken`.
- `Ticket`: subesquema `workLog`; `toTicket` lo mapea.
- Fakes en memoria en `tests/unit/application/panel/` y pruebas de los adaptadores.

**T3. Casos de uso.**
- `ManageApiTokens`: listar, crear (con contraseña y contador `pwdcheck`), revocar y
  `revokeAllForUser`.
- `ResolveApiToken`: token → usuario y `touchLastUsed`.
- `StaffWorkLog`: `findByCode` y `publish` con idempotencia (pasos 1 a 7 de M5).
- `ManagePanelUsers`: revocar al desactivar y al restablecer.
- `toStaffDetail` con `workLog`. Pruebas unitarias de todo.

**T4. HTTP y composición.**
- Guard con `config.panelTokenAuth` (M3): `Bearer` sin distinguir mayúsculas, regex, 401
  `invalid_token` con `WWW-Authenticate`, sin CSRF ni cookie si hay `Authorization`, límite por
  token y por IP.
- Controllers y rutas de M2, M4 y M5; armado en `panel.composition.js`.
- Pruebas HTTP y filas nuevas en `routeAuthWiring`.

**T5. Integración y documentos.**
- Prueba de integración (Windows).
- Nota del backend en el contrato, README sección 20 y sección "Ejecución" de este plan.

## Ejecución

Hecho por tareas, con subagentes, una por vez. Sin `git add`, `commit` ni `push`.

- **T1. Dominio y motivos.** `src/domain/panel/apiTokens.js` y `workLog.js` (nuevos);
  `tickets.js` (`parseTicketCode`), `auditActions.js` (acciones y `details` nuevos),
  `panelReasons.js` y `panelErrors.js` (motivos nuevos y `Retry-After`). Pruebas
  `panelApiTokens.test.js`, `panelWorkLog.test.js` (dominio) y `panelErrors.test.js`.
- **T2. Infraestructura y puertos.** Puertos `api-token-repository`, `api-token-codec` e
  `idempotency-store`; `ticket-repository` con `findByNumber`, `pushWorkLog` e
  `idempotencyGuard`. Modelos `PanelApiToken` y `PanelIdempotencyKey`; subesquema `workLog` en
  `Ticket`. Adaptadores `MongoosePanelApiTokenRepository`, `MongooseIdempotencyStore`,
  `RandomApiToken` y cambios en `MongooseTicketRepository`. Fakes (`apiTokenFakes.js`,
  `ticketFakes.js`) y pruebas `panelApiTokenAdapters.test.js`, `panelIdempotencyStore.test.js` y
  `panelTicketAdapters.test.js`.
- **T3. Casos de uso.** `ManageApiTokens`, `ResolveApiToken` y `StaffWorkLog` (nuevos);
  `ManagePanelUsers` revoca al desactivar y al restablecer; `toStaffDetail` con `workLog`.
  Pruebas `manageApiTokens`, `resolveApiToken`, `staffWorkLog`, `managePanelUsers` y
  `staffTickets`.
- **T4. HTTP y composición.** Guard con `panelTokenAuth` en `panelSession.js`; controllers
  `panelApiTokens.controller.js` y `panelWorkLog.controller.js`; rutas en `panelPlugin.js`;
  `buildPanelApiTokenUseCases` y `buildPanelWorkLogUseCases` en `panel.composition.js`. Pruebas
  `panelApiTokensApi.test.js`, `panelWorkLogApi.test.js` (con `panelTokenHarness.js`),
  `panelApi.test.js` y `routeAuthWiring.test.js`.
- **T5. Integración y documentos.** `tests/integration/panelWorkLog.test.js` (MongoMemoryServer,
  adaptadores reales y limitadores falsos; solo corre en Windows): token solo con hash e índices,
  token → usuario, búsqueda por código, idempotencia, `resolve: true`, `workLog` solo para
  Smarteam e índice de `number`. `panelTickets.test.js` y `panelUsers.test.js` no necesitaron
  cambios (no comparan tickets ni detalles completos). Nota del backend en el contrato y
  README sección 20.

### Desvíos respecto del plan y del contrato

- `firstResponseAt` con `setIfNull`, en una escritura aparte (decisión 1).
- `redact` del logger de Fastify no aplicado: es núcleo (`src/main/app.js`), pendiente de
  decisión. Revisar el `log_format` de nginx queda para infraestructura.
- `Retry-After`: 60 s por token; 900 s en `pwdcheck` y en el límite por IP. `fail()` acepta
  `retryAfterSeconds`.
- `Authorization` vacío en las rutas `by-code` → 401 `invalid_token`.
- `Content-Type` no JSON en `POST …/work-log` → 400 `validation_error`, aunque Fastify daría
  415. `createJsonOnlyErrorHandler` se aplica solo en esa ruta.
- `crmProjectId` debe ser texto: un número → 400. `resolve: null` → 400.
- `ManageApiTokens.revokeAllForUser` recibe `target` (el dueño) además de `actor`, para no
  releer el usuario al auditar.
- `StaffWorkLog.publish` recibe `ip` para la auditoría.
- `buildManagePanelUsers` usa por defecto un `apiTokens` no-op (`NO_API_TOKENS`), así
  `scripts/create-panel-staff.mjs` no cambia; `buildPanelUseCases` le pasa `ManageApiTokens`.

### Revisión de seguridad

Arreglos (cada uno con pruebas que fallaban antes):

1. **IP bloqueada no consulta la base.** `RedisLoginAttempts.isBlocked(key)` (nuevo; GET con el
   mismo timeout y respaldo en memoria, sin sumar; el puerto `LoginAttemptsPort` y el login no
   cambian). El guard responde 429 (`Retry-After: 900`) antes de `resolveApiToken.execute` si
   la IP ya está bloqueada; con la IP bloqueada, ni un token válido pasa.
2. **Sin IP utilizable no hay límite por IP.** Si `req.panelClientIpKey` es null o vacío, el
   guard no usa `invalidTokenIpAttempts` (como `LoginPanelUser`): no hay un contador `null`
   compartido.
3. **Clave reusada con otro cuerpo pasadas las 24 h → 422.** La entrada de `workLog` guarda
   `idempotencyFingerprint` (subesquema de `Ticket`, `toTicket`, `StaffWorkLog`); en el paso 4,
   una huella distinta da `idempotency_key_reused` y libera la reserva propia. Entradas sin
   huella, como antes. La huella no sale en `toWorkLogEntryView`/`toWorkLogView`.
4. **`MongooseIdempotencyStore.find` solo devuelve claves vigentes** (`expiresAt: { $gt: now }`,
   `now` opcional o reloj inyectable del adaptador); `StaffWorkLog` pasa la hora del request.
   Puerto y fake actualizados.
5. **Restablecer contraseña no pierde la temporal si falla la revocación de tokens.** Se registra
   `logger.error({ msg: 'Panel API tokens: revoke on password reset failed', userId })` y se
   devuelve la temporal; `logger` llega desde `buildManagePanelUsers`/`buildPanelUseCases`. La
   desactivación sigue propagando el error (decisión 4).

Pendientes no corregidos:

- **B5.** Carrera muy chica entre crear un token y desactivar o restablecer al usuario: un token
  creado en ese instante puede quedar activo. El estado del usuario igual lo corta al desactivar.
- **B6.** Un hasher saturado al crear un token cuenta como intento de contraseña. Aceptable.
