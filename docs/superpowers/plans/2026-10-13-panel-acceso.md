# Panel — Plan 1 del backend: Acceso (usuarios, sesión y permisos) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado:** borrador revisado contra el código del backend el 2026-10-13. **Pendiente de aprobación explícita del usuario.** No se toca código hasta entonces.
> **Origen:** `docs/contrato-backend/planes/2026-10-13-panel-acceso-backend.md` (escrito desde el chat del frontend en modo lectura). Los cambios de la revisión están al final, en *Revisión contra el código*.

**Goal:** Que exista `/panel/api` con login por usuario y contraseña, sesión en cookie, cambio de contraseña obligatorio, permisos por cuenta y la gestión de usuarios de Smarteam, tal como lo consume el frontend ya construido.

**Architecture:** Un plugin de Fastify **encapsulado** con prefijo `/panel/api`, que se registra desde `routes/index.js` y **se desactiva solo** si no hay `PANEL_JWT_SECRET` (fail closed, sin romper el arranque). Dentro del plugin, y solo ahí: su propio parser JSON, `@fastify/cookie`, un hook `onRequest` de CSRF y sesión, `requirePermission(perm)` como `preHandler` por ruta y un manejador de errores con el formato `{ error, message }`. Casos de uso en `src/application/use-cases/panel/` con puertos `createPort`; Mongoose, scrypt, HMAC y Redis en `src/infrastructure/`; cableado en `src/composition/panel.composition.js`. El modelo `PanelUser` vive en la master junto a `SaaSClient`.

**Es un módulo nuevo y aislado.** No toca modelos ni bases de los tenants, ni el core de la integración (SAP B1 / S/4, HubSpot, colas, syncs, webhooks). Los únicos archivos existentes que cambian son `routes/index.js` (una línea de registro), `package.json`/`package-lock.json`, `.env.example`, `README.md` y dos archivos de test.

**Tech Stack:** Node ESM, Fastify 4.29.1, Mongoose 8, `redis` 4.7.1 (`@redis/client` 1.6.1, cliente existente `src/infrastructure/cache/redisClient.js`), `crypto` de Node (scrypt, HMAC-SHA256, `timingSafeEqual`, `randomInt`), Jest 30 con `--experimental-vm-modules`, `mongodb-memory-server` 10. Dependencia nueva: **`@fastify/cookie@9.4.0`** (verificado en npm: su `plugin.js` declara `fastify: '4.x'`; la 10 y la 11 piden Fastify 5).

**Spec aprobado:** `docs/superpowers/specs/2026-10-12-panel-soporte-design.md` (§Cuentas, roles y permisos; §Fase 1 → 1. Acceso; §Seguridad; §Testing).

**Contrato con el front:** `docs/contrato-backend/` (copia de la carpeta del repo `smartHubPanel`):
- `00-reglas-generales.md`: rutas, sesión, CSRF, formato de error, paginación, fechas, nombres.
- `01-acceso-y-usuarios.md`: supuestos **C1 a C9** (este plan los implementa todos; ver *Propuestas de ajuste al contrato*).

## Global Constraints

- Trabajar en `main`, checkout principal, sin ramas ni worktrees. **No** `git add`, `git commit` ni `push`: el usuario commitea. Al terminar cada tarea, dejar en el chat qué cambió, en qué archivos y por qué.
- **Nada existente cambia de comportamiento.** Webhooks, syncs, rutas admin, OAuth y Bull Board siguen igual. No se modifican `src/main/app.js`, `env.js`, `master/database.js`, modelos ni repositorios existentes, ni nada de `models/tenant/`.
- El parser JSON, la cookie, los hooks y el manejador de errores del panel se registran **dentro** del plugin encapsulado: no alcanzan a ninguna ruta fuera de `/panel/api`.
- Variable nueva: exactamente **`PANEL_JWT_SECRET`**, leída por un archivo nuevo `src/infrastructure/config/panel.config.js` (no se toca `env.js`). **No** usar `JWT_SECRET` (`tenantResolver.js:86-89` acepta cualquier bearer firmado con él que traiga `tenantKey`) ni `INTERNAL_KEY`.
- Si falta `PANEL_JWT_SECRET`: el plugin no registra rutas, loguea `logger.warn({ msg: 'Panel API disabled: PANEL_JWT_SECRET not set' })` y el servidor arranca igual. **Nada del panel se construye al importar módulos** (sin instancias a nivel de módulo): si el secreto falta, ningún constructor lanza durante el arranque.
- **Formato de error de `/panel/api`** (toda respuesta no 2xx, incluidos 404 de ruta inexistente, JSON mal formado y 500): `{ "error": "<codigo_snake_case>", "message"?: "<texto en español>" }`. Nunca `{ ok: false }` dentro de `/panel/api`.
- Códigos que el front reconoce (no inventar otros sin acordarlo): `unauthorized` 401, `invalid_credentials` 401, `too_many_attempts` 429, `password_change_required` 403, `invalid_current_password` **400**, `forbidden` 403, `missing_panel_header` 403, `validation_error` 400 (con `message` legible), `email_taken` 409, `not_found` 404. Además `internal_error` 500 (ver propuesta **R1**).
- Cookie `panel_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`, `Max-Age=28800` (8 h). El JWT dura lo mismo.
- `tenantKey` se devuelve **tal como está guardado** y es un identificador opaco (ver decisión 1: hoy lleva el prefijo `sap_integration_`). Nada de nombres de sistemas concretos en **rutas ni nombres de campos** de `/panel/api`.
- Ningún log con contraseñas, cookies, el header `Authorization`, el JWT ni la contraseña temporal. El hook de `src/main/app.js:23-30` loguea `req.url`: nada sensible va en la URL.
- Correr jest así (en Windows `npm test` no funciona): `NODE_OPTIONS=--experimental-vm-modules npx jest <archivos> --testPathIgnorePatterns=worktrees` (la opción **al final** y con `=`).

## Hechos verificados (lectura del código, 2026-10-13)

| Hecho | Dónde |
|---|---|
| Las rutas se registran en `routes/index.js` con `app.register(...)`, sin prefijos ni `setErrorHandler` global. Bull Board se registra aparte, desde `src/bootstrap/bullBoard.js` (con su auth comentada, línea 35; fuera de alcance). | `src/interfaces/http/routes/index.js`, `src/main/app.js:33-35` |
| `app.js` registra en la raíz un parser `application/json` propio con `JSON.parse` simple: un JSON inválido sale como **500** (el error no trae `statusCode`), un body vacío con ese `Content-Type` también falla y no hay protección de `__proto__`. | `src/main/app.js:13-20`, `node_modules/fastify/lib/contentTypeParser.js:190-199` |
| Patrón de caso de uso: clase con dependencias inyectadas que devuelve `{ ok, data }` o `{ ok: false, reason, message }`, con un objeto `reasons` exportado; el controller traduce `reason` a HTTP. | `src/application/use-cases/ManageSapCredentials.js`, `src/interfaces/http/controllers/sapCredentials.controller.js` |
| Los controllers existentes se crean con una factory `createXController({ dep = buildX() })` **y** una instancia por defecto a nivel de módulo, que la ruta importa. El panel usa la factory pero **no** la instancia de módulo (fail closed). | `sapCredentials.controller.js:40-112`, `sapCredentials.routes.js` |
| Los puertos se definen con `createPort({ name, methods })` y la composición los verifica con `assertPort`. | `src/application/ports/port-validator.js`, `src/composition/sap-sync.composition.js` |
| Test de arquitectura: `application`, `domain`, `ports` y `shared` no importan `infrastructure` ni `axios`, `bullmq`, `fastify`, `ioredis`, `mongoose`, `redis`; los controllers no importan `mongoose`, `axios`, `bullmq`, `ioredis` ni `redis`. Todo `.js` de `src` va bajo una raíz hexagonal. | `tests/unit/architecture/hexagonalBoundaries.test.js:21-56,184-202,295-326` |
| `SaaSClient` está en la master (conexión por defecto de Mongoose), `tenantKey` `lowercase` y único, `status` con `active` \| `inactive` \| `suspended` (default `inactive`). | `src/infrastructure/database/models/global/SaaSClient.js:29-40` |
| **El `tenantKey` real lleva el prefijo de la base:** `provisionTenant` hace `tenantKey = buildTenantDatabaseName(slug)` → `sap_integration_<slug>` (si no hay `TENANT_DB_PREFIX`). Los scripts del repo lo usan así (`sap_integration_noelito`, `sap_integration_printer`). | `src/infrastructure/tenants/tenantProvisioning.js:397-398`, `tenantDatabase.js:9-15`, `scripts/diagnose-invoice-sync.mjs:21` |
| Un tenant "operativo" para los webhooks exige `SaaSClient.status === 'active'` **y** una `Subscription` activa y pagada; el `status` del `SaaSClient` solo es la primera mitad. | `tenantResolver.js:105-118` |
| Ya hay un JWT HS256 hecho a mano con `crypto` que **no verifica el header `alg`**. | `src/interfaces/http/middlewares/tenantResolver.js:18-47` |
| Redis: `getRedisClient()` (paquete `redis` v4, singleton perezoso; hoy solo lo usa `sapSessionManager`). Con Redis caído **no falla rápido**: `connect()` reintenta para siempre (`Math.min(retries * 50, 500)`) y la promesa queda pendiente; ya conectado, los comandos se encolan offline hasta que vuelve. | `src/infrastructure/cache/redisClient.js`, `node_modules/@redis/client/dist/lib/client/socket.js:110-170` |
| `env.js` lee `process.env` una sola vez al importarse; `.env.example` tiene el bloque `# ─── Auth` en las líneas 32-34. | `src/infrastructure/config/env.js`, `.env.example` |
| Fastify no tiene `trustProxy`: detrás del proxy todas las requests llegan con la misma IP (por eso el límite de intentos es por email). | `src/infrastructure/config/app.config.js:26-30` |
| `routeAuthWiring.test.js` **mockea** `tenantResolver` y los controllers: sirve para probar qué `preHandler` protege cada ruta, no para probar el resolver real. El resolver real se prueba en `tenantResolver.test.js`. | `tests/unit/interfaces/routeAuthWiring.test.js:10-20`, `tests/unit/interfaces/tenantResolver.test.js` |
| Validador de ids: `MongooseObjectIdValidator`. Logger: `#infrastructure/logger/logger.adapter.js`. | `src/infrastructure/database/MongooseObjectIdValidator.js`, `src/main/app.js:6` |
| Scripts del repo: `.mjs`, encabezado con uso y `node --env-file=.env ...`. La imagen Docker incluye `scripts/` (`.dockerignore` no lo excluye). | `scripts/*.mjs`, `Dockerfile`, `.dockerignore` |
| El Mongo de producción es **< 5.0**; `mongodb-memory-server` es ≥ 5.0. Este plan no usa nada que dependa de la versión. | Doc del proyecto `arquitectura.md` |
| Hay **212** archivos `*.test.js` en `tests/`. La baseline conocida (plan de Bull Board, 2026-10-12) dice 211 suites con 5 rojas: `tests/integration/internalTenant.test.js`, `tests/unit/application/sendMappedItemsToHubspot.test.js`, `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js`, `tests/unit/serviceLayerService.test.js` (10 tests). `internalTenant` pasa aislado y falla en la corrida completa por carga. | `docs/superpowers/plans/2026-10-12-bull-board-basic-auth.md:23,527` |

## Decisiones de este plan (cambiables antes de aprobar)

1. **`tenantKey` tal como está guardado, como identificador opaco.** Es minúsculas (lo fuerza el schema) **y hoy incluye el prefijo de la base** (`sap_integration_printer`). No se transforma: un segundo identificador habría que traducirlo de vuelta en cada request. Consecuencias: el front muestra siempre `companyName` y nunca `tenantKey` (propuesta **C6/C7-a**); el código de ticket del plan 2 se arma quitando el prefijo (`PRINTER-0007`). **A confirmar antes de implementar:** leer los `tenantKey` reales de la master de producción (solo lectura: `db.SaaSClients.find({}, { _id: 0, tenantKey: 1, companyName: 1, status: 1 })`).
2. **`status` del tenant tal cual** (`active`, `inactive`, `suspended`) en `GET /staff/tenants`. Es el estado del `SaaSClient`, no el de la suscripción: sirve para el selector, no para decir si la integración está operativa (eso es E5, Fase 2).
3. **Redis caído en el login:** cada operación con Redis tiene un **timeout de 1 s**. Si falla o vence, el adaptador usa un **contador en memoria del proceso** con el mismo límite (5 en 15 min) y loguea `warn` (sin el email en claro). No se responde 503. La API corre en un solo contenedor, así que el contador en memoria protege de verdad mientras Redis vuelve. *Alternativas:* fallar abierto sin límite (lo que decía el borrador; con el cliente actual ni siquiera fallaría: colgaría el login) o fallar cerrado con 503 (bloquea a todos si Redis cae).
4. **Usuario inexistente o inactivo:** se calcula igual un scrypt contra un hash fijo, para que el tiempo de respuesta no revele qué correos existen.
5. **Contraseña temporal:** 14 caracteres de un alfabeto sin ambiguos (sin `0/O/1/l/I`), con `crypto.randomInt`.
6. **Smarteam con tenant suspendido:** puede ver todo. **Cliente de tenant suspendido o inactivo:** puede entrar (spec, §1 "Estado del tenant").
7. **La sesión no se renueva sola** (8 h fijas desde el login o el último cambio de contraseña).
8. **La fuente de verdad es el `PanelUser`, no el JWT:** rol, tenant, `active` y `mustChangePassword` se leen de la base en cada request. El JWT lleva `pwdChange` (lo pide el spec) pero el hook decide con `user.mustChangePassword`.
9. **Desactivar sube `tokenVersion`** aunque `active: false` ya corta la sesión: así una reactivación no revive las sesiones viejas. Cambiar el rol **no** la sube (rige en el request siguiente igual).
10. **`POST /auth/logout` no exige sesión válida:** siempre `204` y borra la cookie (con el header CSRF). Una sesión vencida no deja al usuario sin poder "salir". Ver propuesta **R3**.
11. **Parser JSON propio del panel** (solo en el plugin): body vacío → `{}`; JSON inválido o con `__proto__`/`constructor` → `400 validation_error`. Usa `app.getDefaultJsonParser('error', 'error')` de Fastify; no agrega dependencias.
12. **Nadie se restablece la contraseña a sí mismo** desde `/staff/users/:id/reset-password` (`400 validation_error`): cortaría su propia sesión. Para eso está el cambio de contraseña. Ver propuesta **C9-a**.
13. Contraseña: mínimo 10, **máximo 200** caracteres (evita cuerpos enormes contra scrypt).

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `package.json` / `package-lock.json` | Modificar | `@fastify/cookie@9.4.0` (exacta) |
| `.env.example` | Modificar | `PANEL_JWT_SECRET=` en el bloque `# ─── Auth` |
| `README.md` | Modificar | Sección del panel |
| `src/interfaces/http/routes/index.js` | Modificar | **Solo** `import panelPlugin from '../panel/panelPlugin.js'` y `app.register(panelPlugin, { prefix: '/panel/api' })` |
| `src/infrastructure/config/panel.config.js` | Crear | `dotenv.config()`; exporta `{ jwtSecret: process.env.PANEL_JWT_SECRET \|\| null, sessionTtlSeconds: 28800, cookieName: 'panel_session', cookiePath: '/api' }` |
| `src/domain/panel/permissions.js` | Crear | Constantes de permisos y `permissionsFor({ accountType, role })` |
| `src/domain/panel/accounts.js` | Crear | `ACCOUNT_TYPES`, `CLIENT_ROLES`, `normalizeEmail`, `isValidEmail` |
| `src/domain/panel/passwordPolicy.js` | Crear | Largo 10–200 y reglas de la contraseña nueva |
| `src/domain/panel/errors.js` | Crear | `PanelEmailTakenError` (el repositorio lo lanza ante `E11000`) |
| `src/application/ports/panel/panel-user-repository.port.js` | Crear | `createPort` |
| `src/application/ports/panel/password-hasher.port.js` | Crear | `hash`, `verify`, `verifyDummy` |
| `src/application/ports/panel/session-token.port.js` | Crear | `sign`, `verify` |
| `src/application/ports/panel/login-attempts.port.js` | Crear | `isBlocked`, `registerFailure`, `reset` |
| `src/application/ports/panel/tenant-directory.port.js` | Crear | `findByKey`, `findManyByKeys`, `listAll` |
| `src/application/ports/panel/temporary-password-generator.port.js` | Crear | `generate` |
| `src/application/use-cases/panel/panelReasons.js` | Crear | `panelReasons` (congelado) |
| `src/application/use-cases/panel/panelUserView.js` | Crear | Proyección pública (C6) y cuerpo de `/auth/me` |
| `src/application/use-cases/panel/LoginPanelUser.js` | Crear | Login con límite de intentos |
| `src/application/use-cases/panel/ResolvePanelSession.js` | Crear | De un token a un usuario de sesión válido |
| `src/application/use-cases/panel/GetPanelSession.js` | Crear | Cuerpo de `/auth/me` (resuelve `companyName`) |
| `src/application/use-cases/panel/ChangePanelPassword.js` | Crear | Cambio de contraseña (C2, C3) |
| `src/application/use-cases/panel/ManagePanelUsers.js` | Crear | Listar, crear, actualizar, restablecer (C6, C8, C9) |
| `src/application/use-cases/panel/ListPanelTenants.js` | Crear | Empresas para los selectores (C7) |
| `src/infrastructure/database/models/global/PanelUser.js` | Crear | Modelo `PanelUser`, colección `PanelUsers` |
| `src/infrastructure/database/repositories/MongoosePanelUserRepository.js` | Crear | Adaptador; importa el modelo **directo** (no se toca `master/database.js`) |
| `src/infrastructure/database/repositories/SaaSClientTenantDirectory.js` | Crear | `SaaSClient` con `.select('tenantKey companyName status').lean()`: nunca toca `hubspot.*` |
| `src/infrastructure/auth/ScryptPasswordHasher.js` | Crear | Hash y verificación con `crypto.scrypt` |
| `src/infrastructure/auth/HmacSessionToken.js` | Crear | JWT HS256 propio, **con** chequeo de `alg`/`typ` |
| `src/infrastructure/auth/RedisLoginAttempts.js` | Crear | Contador por email en Redis, timeout y respaldo en memoria |
| `src/infrastructure/auth/RandomTemporaryPassword.js` | Crear | Generador de temporales |
| `src/composition/panel.composition.js` | Crear | `buildManagePanelUsers()` (sin secreto, la usa el script) y `buildPanelUseCases({ secret })`, con `assertPort` |
| `src/interfaces/http/panel/panelPlugin.js` | Crear | Plugin: fail closed, parser JSON, cookie, hooks, errores, rutas |
| `src/interfaces/http/panel/panelSession.js` | Crear | Hook CSRF + sesión, `requirePermission`, `requireAnyPermission`, restricción de `pwdChange` |
| `src/interfaces/http/panel/panelErrors.js` | Crear | `reason` → `{ status, error, message }`; `setErrorHandler` / `setNotFoundHandler` del prefijo |
| `src/interfaces/http/controllers/panelAuth.controller.js` | Crear | `createPanelAuthController(useCases)`: login, logout, me, change-password |
| `src/interfaces/http/controllers/panelUsers.controller.js` | Crear | `createPanelUsersController(useCases)`: usuarios y tenants de staff |
| `scripts/create-panel-staff.mjs` | Crear | Alta de la primera cuenta de Smarteam (`.mjs` como el resto de `scripts/`) |
| `tests/unit/domain/panelPermissions.test.js` | Crear | Matriz cuenta × rol × permiso y política de contraseña |
| `tests/unit/application/panel/*.test.js` | Crear | Casos de uso con fakes |
| `tests/unit/infrastructure/panelAuthAdapters.test.js` | Crear | scrypt, token, temporales, intentos (Redis falso, lento y que lanza) |
| `tests/unit/interfaces/panelApi.test.js` | Crear | Plugin completo con `Fastify().inject` y fakes: cookie, CSRF, parser, errores, permisos, C1–C9 |
| `tests/unit/interfaces/routeAuthWiring.test.js` | Modificar | Tabla de rutas del panel con su sesión y permiso; cookie del panel rechazada en rutas admin/master; `x-internal-key` rechazada en `/panel/api` |
| `tests/unit/interfaces/tenantResolver.test.js` | Modificar | Un token del panel como bearer no resuelve tenant en el resolver real |
| `tests/integration/panelUsers.test.js` | Crear | `mongodb-memory-server`: índice único, paginación y orden, flujo login → cambio → me, script |

---

### Task 0: Baseline y dependencia

- [ ] En Windows, suite completa: `NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees`. Anotar suites y tests rojos. Se esperan 212 suites y las 5 rojas listadas en *Hechos verificados*; si difiere, se anota la nueva baseline en el chat **antes** de tocar nada.
- [ ] `npm install @fastify/cookie@9.4.0 --save-exact`, y `npm ls fastify @fastify/cookie`: `fastify` sigue en 4.29.x y no aparece una segunda copia.

### Task 1: Dominio — cuentas, permisos y política de contraseña

**Files:** `src/domain/panel/{accounts,permissions,passwordPolicy,errors}.js`, `tests/unit/domain/panelPermissions.test.js`

**Interfaces:**
- `ACCOUNT_TYPES = { SMARTEAM: 'smarteam', CLIENTE: 'cliente' }`, `CLIENT_ROLES = ['admin', 'usuario']`; `normalizeEmail(v)` → `String(v ?? '').trim().toLowerCase()`; `isValidEmail(v)` (formato simple, ≤ 254).
- `PANEL_PERMISSIONS` (congelado): `TICKETS_READ 'tickets.read'`, `TICKETS_CREATE`, `TICKETS_REPLY`, `TICKETS_REOPEN`, `EVENTS_READ`, `SYNCS_READ`, `STAFF_TICKETS 'staff.tickets'`, `STAFF_USERS 'staff.users'`, `STAFF_EVENTS_RAW 'staff.events.raw'`.
- `permissionsFor({ accountType, role }): string[]` — Fase 1:
  - `smarteam` → `events.read`, `syncs.read`, `staff.tickets`, `staff.users`, `staff.events.raw`;
  - `cliente` con `admin` o `usuario` (iguales en Fase 1) → `tickets.read`, `tickets.create`, `tickets.reply`, `tickets.reopen`, `events.read`, `syncs.read`;
  - cualquier otra combinación → `[]`.
- `PASSWORD_MIN_LENGTH = 10`, `PASSWORD_MAX_LENGTH = 200`; `validateNewPassword({ newPassword, currentPassword }) → null | message` ("Debe tener al menos 10 caracteres." / "Debe tener como máximo 200 caracteres." / "La contraseña nueva debe ser distinta de la actual.").
- `PanelEmailTakenError extends Error` (`code = 'PANEL_EMAIL_TAKEN'`).

- [ ] Test de la matriz (cada cuenta y rol; Smarteam **no** tiene `tickets.*`; `cliente` sin rol → `[]`) y de la política.
- [ ] Implementar. Verde.

### Task 2: Modelo `PanelUser` y repositorio

**Files:** `models/global/PanelUser.js`, `repositories/MongoosePanelUserRepository.js`, `ports/panel/panel-user-repository.port.js`, `tests/integration/panelUsers.test.js` (parte del repo)

**Modelo** (spec §1): `email` (String, requerido, único, `lowercase`, `trim`), `name` (String, requerido, `trim`), `accountType` (`smarteam`\|`cliente`), `tenantKey` (String\|null, `lowercase`), `role` (`admin`\|`usuario`\|null), `passwordHash` (String, requerido), `mustChangePassword` (Boolean, default `true`), `active` (Boolean, default `true`), `tokenVersion` (Number, default 0), `lastLoginAt` (Date\|null), `createdBy` (ObjectId\|null), `timestamps: true`, `collection: 'PanelUsers'`. Validación en el schema: si `cliente`, `tenantKey` y `role` obligatorios; si `smarteam`, ambos `null`. Índices: `{ email: 1 }` único y `{ tenantKey: 1, createdAt: -1 }`. Se registra con `mongoose.model('PanelUser', …)` en la conexión por defecto (la master), igual que `SaaSClient`.

**Puerto:** `findByEmail(email)`, `findById(id)`, `create(data)` (lanza `PanelEmailTakenError` ante `E11000`), `update(id, patch)`, `incrementTokenVersion(id, extraPatch)` (`$inc` + `$set` atómico, devuelve el documento nuevo), `list({ tenantKey, page, pageSize }) → { items, total }` ordenado por `createdAt` desc (C8), `touchLastLogin(id, date)`. Todo con `.lean()`; ids mal formados → `null` (sin lanzar `CastError`).

- [ ] Integración con memoria (`await PanelUser.init()` antes de probar el índice): dos altas con el mismo correo en distinta capitalización → `PanelEmailTakenError`; paginación y orden; filtro por `tenantKey`; `findById('no-es-un-id')` → `null`.
- [ ] Implementar. Verde.

### Task 3: Adaptadores de seguridad

**Files:** `infrastructure/auth/{ScryptPasswordHasher,HmacSessionToken,RedisLoginAttempts,RandomTemporaryPassword}.js`, sus puertos, `tests/unit/infrastructure/panelAuthAdapters.test.js`

- **Hasher:** formato `scrypt$N$r$p$<salt base64>$<hash base64>` con `N=16384, r=8, p=1`, sal de 16 bytes, clave de 64 bytes; `hash` y `verify` asíncronos (`util.promisify(crypto.scrypt)`); `verify` con `timingSafeEqual` y `false` ante un formato desconocido. `verifyDummy(password)` corre un scrypt contra un hash fijo calculado una sola vez y perezosamente (decisión 4).
- **Token:** `sign({ sub, tv, pwdChange }) → string` con header `{"alg":"HS256","typ":"JWT"}`, `iat` y `exp = iat + 28800`; `verify(token) → payload | null`: rechaza si no tiene 3 partes, si el header no es exactamente HS256/JWT, si la firma no coincide (comparación en tiempo constante, chequeo de largo antes), si `exp` venció o falta, o si el payload no trae `sub` (string) y `tv` (número). Constructor lanza si falta el secreto (solo se construye dentro del plugin, ya con el secreto verificado).
- **Intentos:** recibe `getClient` (por defecto `getRedisClient`), `timeoutMs = 1000` y un `clock`. Clave `panel:login:fail:<sha256(normalizeEmail)>`; `isBlocked(email)` (≥ 5), `registerFailure(email)` (`INCR`; si devuelve 1, `EXPIRE 900`), `reset(email)` (`DEL`). Cada llamada, incluida la obtención del cliente, va en `Promise.race` con el timeout. Si falla o vence: misma lógica sobre un `Map` en memoria con vencimiento a 15 min, y `logger.warn({ msg: 'Panel login attempts: Redis unavailable, using in-memory counter' })` como máximo una vez por minuto (decisión 3).
- **Temporales:** 14 caracteres con `crypto.randomInt`, alfabeto `ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789`.

- [ ] Tests: el hash no contiene la contraseña y verifica; dos hashes de la misma contraseña difieren; formato desconocido → `false`. Token con `alg: none`, `HS512` o sin `typ` → `null`; firma alterada → `null`; vencido → `null`; sin `tv` → `null`. Temporales con largo y alfabeto correctos. Intentos con un cliente falso: el 5º fallo bloquea; `reset` desbloquea; un cliente que **lanza** y uno que **nunca responde** caen al contador en memoria y bloquean igual al 5º fallo, en menos de ~1 s cada llamada.
- [ ] Implementar. Verde.

### Task 4: Casos de uso

**Files:** `application/use-cases/panel/*.js`, `tests/unit/application/panel/*.test.js` (repositorios y adaptadores falsos)

**`panelReasons`:** `VALIDATION_ERROR`, `INVALID_CREDENTIALS`, `TOO_MANY_ATTEMPTS`, `UNAUTHORIZED`, `INVALID_CURRENT_PASSWORD`, `EMAIL_TAKEN`, `NOT_FOUND`.

**`panelUserView.js`:** `toPublicUser(user, companyName)` → forma de **C6** (`id` como string, sin `passwordHash` ni `tokenVersion`, fechas ISO o `null`); `toSessionBody(user, companyName)` → forma de `/auth/me` (`name, email, accountType, role, tenantKey, companyName, permissions, mustChangePassword`). Para Smarteam, `role`, `tenantKey` y `companyName` en `null`.

**`LoginPanelUser.execute({ email, password })`**
1. Normalizar el email; sin `email` o `password` string → `VALIDATION_ERROR` ("Correo y contraseña son obligatorios.").
2. `isBlocked(email)` → `TOO_MANY_ATTEMPTS` (aunque la contraseña sea correcta).
3. Buscar usuario; si no existe o `active === false`: `verifyDummy`, `registerFailure` → `INVALID_CREDENTIALS` (mismo error en los tres casos).
4. Contraseña incorrecta → `registerFailure` → `INVALID_CREDENTIALS`.
5. Éxito: `reset(email)`, `touchLastLogin`, token `{ sub, tv: tokenVersion, pwdChange: mustChangePassword }`, devuelve `{ token, session: toSessionBody(...) }` (**C4**).

**`ResolvePanelSession.execute({ token })`** → `{ ok: true, user: { id, name, email, accountType, role, tenantKey, permissions }, mustChangePassword }` o `UNAUTHORIZED` si: no hay token, token inválido, usuario inexistente, `active === false` o `tokenVersion !== tv`. `mustChangePassword` sale del usuario, no del token (decisión 8).

**`GetPanelSession.execute({ userId })`** → cuerpo de `/auth/me` con `companyName` del directorio.

**`ChangePanelPassword.execute({ userId, currentPassword, newPassword })`**
- `currentPassword` incorrecta → `INVALID_CURRENT_PASSWORD` (**400, no 401**: C2). No suma intentos de login.
- `validateNewPassword` → `VALIDATION_ERROR` con el mensaje.
- Éxito: nuevo hash, `mustChangePassword: false`, `tokenVersion + 1` (atómico), y devuelve un **token nuevo** con el `tv` vigente y `pwdChange: false` (**C3**).

**`ManagePanelUsers`** (recibe `objectIdValidator`)
- `list({ tenantKey, page, pageSize })`: defaults `page=1`, `pageSize=25`; enteros con `page ≥ 1` y `1 ≤ pageSize ≤ 100` (si no, `VALIDATION_ERROR`); `tenantKey` se normaliza a minúsculas; `{ items: toPublicUser[], page, pageSize, total }` con `companyName` resuelto con **una** consulta `findManyByKeys` por página.
- `create({ actor, email, name, accountType, tenantKey, role })`: `email` con formato, `name` 1–100, `accountType` válido; `cliente` exige `tenantKey` **existente en `SaaSClient`** (`findByKey`) y `role` válido; `smarteam` no admite `tenantKey` ni `role` → `VALIDATION_ERROR` con mensaje legible. Temporal nueva, `mustChangePassword: true`, `createdBy: actor?.id ?? null`. `PanelEmailTakenError` → `EMAIL_TAKEN`. Devuelve `{ user, temporaryPassword }` (**201**).
- `update({ actor, id, patch })`: solo `name`, `role`, `active`. `tenantKey` o `accountType` en el patch → `VALIDATION_ERROR`. Patch vacío → `VALIDATION_ERROR`. `role` en una cuenta `smarteam` o fuera de `admin`/`usuario` → `VALIDATION_ERROR`. `active: false` sobre sí mismo → `VALIDATION_ERROR` "No puedes desactivar tu propia cuenta." (**C9**). `active: false` sube `tokenVersion` (decisión 9). Id mal formado o inexistente → `NOT_FOUND`.
- `resetPassword({ actor, id })`: sobre sí mismo → `VALIDATION_ERROR` "No puedes restablecer tu propia contraseña desde aquí." (decisión 12). Temporal nueva, `mustChangePassword: true`, `tokenVersion + 1`. Devuelve `{ temporaryPassword }`. Id mal formado o inexistente → `NOT_FOUND`.

**`ListPanelTenants.execute()`** → `{ items: [{ tenantKey, companyName, status }] }` sin paginar, **incluidos** suspendidos e inactivos (**C7**), ordenados por `companyName`.

- [ ] Tests por cada regla de arriba (incluido: el sexto intento se bloquea con la contraseña correcta; un usuario desactivado o con `tv` viejo no resuelve sesión; cambiar el rol cambia `permissions` en la siguiente resolución; `toPublicUser` nunca tiene `passwordHash` ni `tokenVersion`).
- [ ] Implementar. Verde.

### Task 5: Plugin HTTP `/panel/api`

**Files:** `interfaces/http/panel/{panelPlugin,panelSession,panelErrors}.js`, `controllers/panelAuth.controller.js`, `controllers/panelUsers.controller.js`, `composition/panel.composition.js`, `routes/index.js`, `tests/unit/interfaces/panelApi.test.js`

**Composición:** `buildManagePanelUsers()` (repositorio, directorio, hasher, temporales, validador de ids) y `buildPanelUseCases({ secret })` (todo lo anterior + token e intentos). Verifica cada adaptador con `assertPort`. Ningún módulo construye nada al importarse.

**Plugin** (`export default async function panelPlugin(app, { secret = panelConfig.jwtSecret, useCases, cookieSecure = true } = {})`):
- Sin `secret`: `logger.warn(...)` y `return` (no registra rutas: `/panel/api/*` da el 404 por defecto de Fastify).
- `useCases ??= buildPanelUseCases({ secret })` (los tests pasan los suyos).
- Parser JSON del panel (decisión 11): `app.removeContentTypeParser('application/json')` y `app.addContentTypeParser('application/json', { parseAs: 'string' }, …)` con body vacío → `{}` y el resto a `app.getDefaultJsonParser('error', 'error')`. Queda encapsulado: el parser de `app.js` sigue igual para el resto.
- `app.register(cookie)` (`@fastify/cookie`, sin firmar: el JWT ya va firmado).
- `onSend`: `Cache-Control: no-store` en todas las respuestas del panel.
- `setErrorHandler`: errores con `statusCode` 400 (validación de Fastify, parser) → `400 { error: 'validation_error', message: 'La solicitud no es válida.' }`; 413 → `413 { error: 'validation_error' }`; resto → `500 { error: 'internal_error' }` y log del error con `req.method` y `req.routeOptions.url`, **sin** headers ni body.
- `setNotFoundHandler` → `404 { error: 'not_found' }`.
- Hook `onRequest`, en este orden:
  1. **CSRF:** `POST/PUT/PATCH/DELETE` sin `X-Panel-Request: 1` → `403 missing_panel_header` (también en login y logout).
  2. **Sesión:** salvo rutas con `config.public` (login y logout). Lee `panel_session`, `ResolvePanelSession`; si falla → `401 unauthorized` y borra la cookie. Deja `req.panelUser` y `req.panelMustChangePassword`. Corre también para rutas inexistentes: sin sesión dan 401, con sesión 404 (propuesta **R2**).
  3. **Cambio pendiente:** con `mustChangePassword`, solo pasan las rutas con `config.allowPendingPasswordChange` (`GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout`); el resto → `403 password_change_required`.
- `requirePermission(perm)` y `requireAnyPermission([...])` como `preHandler` → `403 forbidden`.
- Cookie al emitir: `reply.setCookie('panel_session', token, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/api', maxAge: 28800 })`; al borrar: `reply.clearCookie('panel_session', { path: '/api' })`.

**Rutas** (las flags van en `config` de la ruta, no se compara la URL):

| Método y ruta | `config` / preHandler | Respuesta |
|---|---|---|
| `POST /auth/login` | `public` | 200 cuerpo de `/me` + `Set-Cookie` (C4); 400 / 401 / 429 |
| `POST /auth/logout` | `public`, `allowPendingPasswordChange` | 204 y cookie borrada, con o sin sesión válida (decisión 10) |
| `GET /auth/me` | `allowPendingPasswordChange` | 200 cuerpo de `/me` (C1) |
| `POST /auth/change-password` | `allowPendingPasswordChange` | 204 + **cookie nueva** (C3); 400 `invalid_current_password` / `validation_error` |
| `GET /staff/users` | `staff.users` | `{ items, page, pageSize, total }` (C6, C8) |
| `POST /staff/users` | `staff.users` | 201 `{ user, temporaryPassword }`; 409 `email_taken` |
| `PATCH /staff/users/:id` | `staff.users` | 200 `{ user }`; 400 (C9, campos prohibidos); 404 |
| `POST /staff/users/:id/reset-password` | `staff.users` | 200 `{ temporaryPassword }`; 400 (decisión 12); 404 |
| `GET /staff/tenants` | **cualquiera de** `staff.users`, `staff.tickets`, `staff.events.raw` | 200 `{ items }` (C7) |

`routes/index.js`: `app.register(panelPlugin, { prefix: '/panel/api' })`, sin condición (el plugin decide).

**Tests** (`Fastify().inject`, casos de uso reales con repositorios en memoria, intentos con un Redis falso, `cookieSecure: true`):
- [ ] Login: cookie con `HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=28800`; 401 `invalid_credentials` igual para "no existe", "desactivado" e "incorrecta"; 6º intento → 429; sin `X-Panel-Request` → 403 `missing_panel_header`.
- [ ] `pwdChange`: `/auth/me` 200 con `mustChangePassword: true`; `/staff/users` → 403 `password_change_required`; cambio → 204 con cookie nueva que ya entra a `/staff/users` (cuenta Smarteam); la cookie vieja → 401.
- [ ] C2: actual incorrecta → **400** `invalid_current_password`; corta, larga o igual → 400 `validation_error` con el mensaje.
- [ ] Sesión: sin cookie → 401; cookie con `tv` viejo (tras reset o desactivación) → 401 y `Set-Cookie` que la borra; cambio de rol → `permissions` nuevos en el request siguiente.
- [ ] Logout: con sesión, sin sesión y con sesión vencida → 204 y cookie borrada.
- [ ] Permisos: cuenta `cliente` → 403 `forbidden` en **cada** ruta `/staff/*`; Smarteam → 200 en `/staff/tenants`.
- [ ] Usuarios: C6 sin `passwordHash`/`tokenVersion`; 201 con temporal; 409 `email_taken`; `tenantKey`/`accountType` en PATCH → 400; desactivarse a sí mismo → 400 (C9); restablecerse a sí mismo → 400; id inexistente o mal formado → 404 `not_found`; `pageSize=101` → 400; `tenantKey` inexistente al crear → 400.
- [ ] Parser y errores: body vacío con `Content-Type: application/json` en logout → 204; JSON mal formado → 400 `validation_error`; `{"__proto__":…}` → 400; ruta inexistente con sesión → 404 `{ error: 'not_found' }`; ninguna respuesta con `ok: false`; un error inesperado de un caso de uso → 500 `{ error: 'internal_error' }`.
- [ ] Todas las respuestas llevan `Cache-Control: no-store`; ninguna lleva `passwordHash`, `tokenVersion` ni campos con "sap" o "hubspot" en el nombre.
- [ ] Sin secreto (`panelPlugin` con `secret: null`): `/panel/api/auth/me` → 404 de Fastify y el `warn` logueado; el resto de la app no cambia.

### Task 6: Cableado y aislamiento con las rutas existentes

**Files:** `tests/unit/interfaces/routeAuthWiring.test.js`, `tests/unit/interfaces/tenantResolver.test.js`

- [ ] `routeAuthWiring`: nuevo bloque que registra `panelPlugin` con casos de uso falsos y recorre una tabla `PANEL_ROUTES` (`[método, url, permiso | 'public']`): sin cookie → 401 (salvo `public`); con una cuenta sin el permiso → 403; con el permiso → 2xx (Seguridad 8).
- [ ] `routeAuthWiring`: una cookie `panel_session` válida **no** abre ninguna ruta de `ADMIN_TENANT_ROUTES` ni de `INTERNAL_ONLY_ROUTES` (403, con el `internalKeyAuthOnly` real) (Seguridad 6).
- [ ] `routeAuthWiring`: `x-internal-key` válida **no** abre ninguna ruta de `/panel/api` (401).
- [ ] `tenantResolver.test.js` (resolver real, con `SaaSClient` mockeado): un token del panel como `Authorization: Bearer` no resuelve tenant: no se busca por `tenantKey` ni `portalId` y la respuesta es 403. Nota: los webhooks no tienen autenticación propia todavía (Fase B), así que este test prueba que la sesión del panel no **agrega** un camino, no que los webhooks estén cerrados.

### Task 7: Script de la primera cuenta y documentación

**Files:** `scripts/create-panel-staff.mjs`, `README.md`, `.env.example`

- `node --env-file=.env scripts/create-panel-staff.mjs <email> "<nombre>"` (en producción: `docker compose exec api node scripts/create-panel-staff.mjs <email> "<nombre>"`, el contenedor ya tiene el `.env`). Conecta con `connect()` de `master/database.js`, usa `buildManagePanelUsers().create({ actor: null, accountType: 'smarteam', … })`, imprime **solo** la temporal y desconecta. Correo existente → sale con código 1 y un mensaje claro, sin tocar la cuenta. Encabezado de uso como los demás scripts.
- `.env.example`: `PANEL_JWT_SECRET=` en el bloque `# ─── Auth`, con un comentario de cómo generarla.
- README: `PANEL_JWT_SECRET` (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`), que sin ella el panel queda apagado, el script, la lista de rutas y que la cookie es `Secure` (fuera de `localhost` exige HTTPS; Safari no la acepta en `http://localhost`).

- [ ] Integración: la lógica vive en `ManagePanelUsers` (ya probada); el script se prueba con `mongodb-memory-server` en `tests/integration/panelUsers.test.js` lanzándolo con `child_process` contra la `MONGODB_URI` en memoria: alta → imprime una temporal de 14 caracteres y el usuario queda con `mustChangePassword: true`; segunda corrida con el mismo correo → código 1.

### Task 8: Prueba contra el front y cierre

- [ ] Suite completa: solo pueden quedar rojos los de la baseline de la Tarea 0.
- [ ] Prueba manual con el panel: en `smartHubPanel`, `npm run dev` (proxy de Vite `/api` → `http://localhost:3000/panel/api`), backend con `PANEL_JWT_SECRET`. Crear la cuenta Smarteam con el script, entrar, cambiar la contraseña, crear un usuario de cliente, restablecerlo, cambiarle el rol, desactivarlo y verificar que su sesión abierta se corta. Usar Chrome o Firefox (cookie `Secure` en `localhost`).
- [ ] Dejar en el chat: qué cambió y dónde, y **cualquier diferencia con C1–C9** (para que el front ajuste).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| `@fastify/cookie` 10/11 se instala por error (piden Fastify 5). | Versión exacta `9.4.0` y `npm ls` en la Tarea 0. |
| El parser JSON de `app.js` devuelve 500 ante un JSON inválido y falla con body vacío. | Parser propio dentro del plugin (decisión 11); hay tests. El de `app.js` no se toca. |
| Redis caído cuelga el login (el cliente `redis` v4 reintenta para siempre). | Timeout de 1 s y contador en memoria (decisión 3); hay test con un cliente que nunca responde. |
| Un import del panel construye adaptadores con el secreto vacío y tumba el arranque. | Nada se construye a nivel de módulo; el plugin construye después de verificar el secreto; test sin secreto. |
| `tenantKey` con prefijo `sap_integration_` en las respuestas. | Decisión 1: opaco, el front muestra `companyName`; confirmar los valores reales antes de implementar. |
| Rendimiento: una consulta a la master por request para validar la sesión. | Aceptado por el spec para un panel; búsqueda por `_id`. |
| Cookie `Secure` en desarrollo. | Chrome y Firefox la aceptan en `http://localhost`; Safari no. Documentado. |
| La baseline real difiere de la conocida (212 archivos de test hoy). | Se mide en la Tarea 0 antes de tocar nada. |

## Revisión contra el código (2026-10-13)

Cambios hechos al borrador del front después de leer el código:

1. **Sin tocar archivos del core:** el borrador modificaba `env.js` y `master/database.js`. Ahora la variable la lee `panel.config.js` (nuevo) y el repositorio importa el modelo `PanelUser` directo. El único archivo de `src/` que cambia es `routes/index.js` (registro).
2. **Fail closed sin romper el arranque:** el borrador construía los casos de uso en `routes/index.js` y seguía el patrón de controllers con instancia a nivel de módulo; con el secreto vacío, el constructor del token lanzaría al importar. Ahora el plugin decide si se registra y construye todo adentro.
3. **Parser JSON propio del panel** (nuevo): el de `app.js` responde 500 ante un JSON inválido y rompe con body vacío (logout, reset-password).
4. **Redis caído:** el cliente actual no falla, cuelga. Se agrega timeout de 1 s y respaldo en memoria (decisión 3, distinta de la del borrador).
5. **`tenantKey` real lleva `sap_integration_`:** decisión 1 reescrita y verificación pedida antes de implementar.
6. **Tests de aislamiento reubicados:** `routeAuthWiring` mockea `tenantResolver`, así que la prueba "la sesión del panel no abre webhooks" va en `tenantResolver.test.js`. El 404 de ruta inexistente se prueba con sesión (sin sesión da 401).
7. **Patrones del repo:** puertos con `createPort` y `assertPort`; `panelReasons` exportado; `MongooseObjectIdValidator` para ids; logger `logger.adapter.js`; script `.mjs` con `--env-file` como el resto de `scripts/`.
8. **Flags por `config` de ruta** (`public`, `allowPendingPasswordChange`) en vez de comparar URLs.
9. **Decisiones nuevas:** 8 (el usuario es la fuente de verdad, no el JWT), 9 (desactivar sube `tokenVersion`, cambiar rol no), 10 (logout sin sesión válida), 11 (parser), 12 (no restablecerse a sí mismo), 13 (máximo 200 caracteres).
10. **`GetPanelSession`** separado de `ResolvePanelSession`: el hook de cada request no consulta `SaaSClient`; solo `/auth/me` resuelve `companyName`.
11. **`Cache-Control: no-store`** en todas las respuestas del panel, no solo en las de sesión.
12. **Baseline:** se agregan las 5 suites rojas conocidas y el dato de 212 archivos de test.

## Propuestas de ajuste al contrato (para el front)

| Id | Propuesta | Impacto en el front |
|---|---|---|
| **C6/C7-a** | `tenantKey` es un identificador opaco y hoy trae el prefijo de la base (`sap_integration_printer`). El front lo usa solo para filtrar y enviar; **en pantalla muestra siempre `companyName`**. | Revisar que ninguna columna, chip o texto muestre `tenantKey`. |
| **C9-a** | Además de C9, `POST /staff/users/:id/reset-password` sobre el propio usuario → `400 validation_error` ("No puedes restablecer tu propia contraseña desde aquí."). | Ninguno: el front ya oculta las acciones de la fila propia. |
| **R1** (00-reglas) | Errores inesperados: `500 { "error": "internal_error" }`. No está en la tabla de códigos. | El front trata cualquier código desconocido como error genérico. |
| **R2** (00-reglas) | Una ruta inexistente bajo `/panel/api` da `401 unauthorized` sin sesión y `404 not_found` con sesión (el hook de sesión corre antes). | Ninguno: el front no llama rutas inexistentes. |
| **R3** (01, tabla de endpoints) | `POST /auth/logout` responde `204` y borra la cookie **aunque la sesión ya no sea válida** (sigue exigiendo `X-Panel-Request: 1`). | Ninguno; si hoy trata un 401 en logout, deja de recibirlo. |
| **R4** (C2) | La contraseña nueva tiene además un máximo de 200 caracteres (`400 validation_error` con mensaje). | Opcional: validarlo también en el formulario. |

## Ejecución (2026-10-13)

Plan aprobado y ejecutado en `main`, sin commits. Diferencias con lo escrito arriba, todas por una revisión de seguridad hecha al terminar:

1. **Límite de intentos atómico.** El puerto `login-attempts` quedó con `consume(email) → { blocked }` y `reset(email)` en lugar de `isBlocked` + `registerFailure`. El intento se cuenta **antes** de verificar la contraseña con un script Lua (`INCR` + `EXPIRE` en una sola operación, y repone el TTL si una clave quedó sin él). Con el diseño anterior, una ráfaga de logins en paralelo pasaba toda junta antes del primer fallo, y un corte entre `INCR` y `EXPIRE` dejaba un bloqueo sin vencimiento. El comportamiento visible no cambia: el 6º intento en 15 min da 429.
2. **Cambio de contraseña con compare-and-set.** `incrementTokenVersion(id, patch, { expectedVersion })`: si Smarteam restablece la contraseña mientras el usuario la está cambiando, el cambio del usuario no pisa el restablecimiento (responde 401).
3. **Hash ficticio calculado al arrancar** el plugin, no en el primer login (evita un primer "usuario no existe" más lento).
4. **Validación de `PANEL_JWT_SECRET`:** además de faltar, el panel queda apagado si tiene menos de 32 caracteres o si es igual a `JWT_SECRET`.
5. `ManagePanelUsers` no recibe `objectIdValidator`: el repositorio devuelve `null` ante un id mal formado y el caso de uso responde `NOT_FOUND`.

Verificación: suite unitaria en un espejo Linux del repo, 215 suites, mismas 4 rojas que antes de empezar (`sendMappedItemsToHubspot`, `lineItemPriceWebhook.service`, `serviceLayerService` y `replicateDefaultSapFilters`, esta última solo porque ahí no se puede descargar `mongod`). Los 4 tests de integración (incluido `tests/integration/panelUsers.test.js`) necesitan `mongodb-memory-server` y se corren en Windows.

Pendientes que no entran en este plan (decisión del usuario): límite global de logins concurrentes o `limit_req` en el proxy para evitar saturar scrypt con correos al azar; bloqueo por (correo, IP) para que un tercero no pueda dejar bloqueada una cuenta; log de auditoría de acciones de usuarios; revocar la sesión en el logout.
