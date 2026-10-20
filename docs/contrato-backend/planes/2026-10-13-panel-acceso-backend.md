# Panel — Plan 1 del backend: Acceso (usuarios, sesión y permisos) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Origen:** borrador preparado desde el chat del frontend (`smartHubPanel`), leyendo el código del backend en modo lectura. **Antes de aprobarlo, el chat del backend lo revisa contra el código** (rutas de archivos, nombres, baseline de tests) y corrige lo que no calce. Copiarlo a `docs/superpowers/plans/2026-10-13-panel-acceso.md` del repo `SAP`.

**Goal:** Que exista `/panel/api` con login por usuario y contraseña, sesión en cookie, cambio de contraseña obligatorio, permisos por cuenta y la gestión de usuarios de Smarteam, tal como lo consume el frontend ya construido.

**Architecture:** Un plugin de Fastify **encapsulado** con prefijo `/panel/api`, registrado solo si existe `PANEL_JWT_SECRET` (fail closed). Dentro: `@fastify/cookie`, un hook `onRequest` de sesión (salvo en `POST /auth/login`), la exigencia de `X-Panel-Request: 1` en mutaciones, `requirePermission(perm)` como `preHandler` por ruta y un manejador de errores con el formato `{ error, message }`. Casos de uso en `src/application/use-cases/panel/` con puertos; Mongoose, scrypt, HMAC y Redis en `src/infrastructure/`; cableado en `src/composition/`. El modelo `PanelUser` vive en la master junto a `SaaSClient`.

**Tech Stack:** Node ESM, Fastify 4.29.1, Mongoose 8, `redis` 4 (cliente existente `src/infrastructure/cache/redisClient.js`), `crypto` de Node (scrypt, HMAC-SHA256, `timingSafeEqual`), Jest 30 con `--experimental-vm-modules`, `mongodb-memory-server` 10. Dependencia nueva: **`@fastify/cookie@9.4.0`** (última de la rama 9, la compatible con Fastify 4; las 10 y 11 piden Fastify 5).

**Spec aprobado:** `docs/superpowers/specs/2026-10-12-panel-soporte-design.md` (§Cuentas, roles y permisos; §Fase 1 en detalle → 1. Acceso; §Seguridad; §Testing).

**Contrato con el front (ya implementado del lado del panel):** carpeta `contrato-backend/` del repo `smartHubPanel`, que el usuario pasa como contexto:
- `00-reglas-generales.md`: rutas, sesión, CSRF, **formato de error**, paginación, fechas, nombres.
- `01-acceso-y-usuarios.md`: supuestos **C1 a C9** (este plan los implementa todos).

## Global Constraints

- Trabajar en `main`, checkout principal. **No** `git add`, `git commit` ni `push`: el usuario commitea. Al terminar cada tarea, dejar en el chat qué cambió, en qué archivos y por qué.
- **Nada existente cambia de comportamiento.** Webhooks, syncs, rutas admin, OAuth y Bull Board siguen igual. El único cambio en `src/main/app.js` / `routes/index.js` es registrar el plugin del panel.
- Variable nueva: exactamente **`PANEL_JWT_SECRET`**. **No** usar `JWT_SECRET` (lo acepta `tenantResolver` para los webhooks: una sesión de cliente abriría los webhooks de su tenant) ni `INTERNAL_KEY`.
- Si falta `PANEL_JWT_SECRET`: no registrar `/panel/api` y loguear `logger.warn({ msg: 'Panel API disabled: PANEL_JWT_SECRET not set' })`.
- **Formato de error de `/panel/api`** (todas las respuestas no 2xx, incluidos 404 de ruta inexistente y errores de validación de Fastify): `{ "error": "<codigo_snake_case>", "message"?: "<texto en español>" }`. Nunca `{ ok: false }` dentro de `/panel/api`.
- Códigos que el front reconoce (no inventar otros sin acordarlo): `unauthorized` 401, `invalid_credentials` 401, `too_many_attempts` 429, `password_change_required` 403, `invalid_current_password` **400**, `forbidden` 403, `missing_panel_header` 403, `validation_error` 400 (con `message` legible para el usuario), `email_taken` 409, `not_found` 404.
- Cookie `panel_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`, `Max-Age=28800` (8 h). El JWT dura lo mismo.
- Nada de nombres de sistemas concretos en rutas ni en campos de respuesta de `/panel/api`.
- Ningún log con contraseñas, cookies, el header `Authorization` ni la contraseña temporal. El hook de `src/main/app.js` loguea `req.url`: nada sensible va en la URL.
- Correr jest así (en Windows `npm test` no funciona): `NODE_OPTIONS=--experimental-vm-modules npx jest <archivos> --testPathIgnorePatterns=worktrees` (la opción **al final** y con `=`).
- **Medir la baseline de la suite completa en la Tarea 0** y compararla al final. La última conocida (plan de Bull Board, 2026-10-12) era 211 suites, 5 rojas / 10 tests rojos, siempre las mismas.

## Hechos verificados al escribir el plan (lectura del código, 2026-10-13)

| Hecho | Dónde |
|---|---|
| Las rutas se registran en `routes/index.js` con `app.register(...)`, sin prefijos ni `setErrorHandler` global. | `src/interfaces/http/routes/index.js`, `src/main/app.js` |
| Patrón de caso de uso: clase con dependencias inyectadas que devuelve `{ ok, data }` o `{ ok: false, reason, message }`; el controller traduce `reason` a HTTP. | `src/application/use-cases/ManageSapCredentials.js`, `src/interfaces/http/controllers/sapCredentials.controller.js` |
| La composición construye los casos de uso con sus adaptadores. | `src/composition/sap-credentials.composition.js` |
| Los controllers no pueden importar `mongoose`, `axios`, `bullmq`, `ioredis` ni `redis` (test de arquitectura). | `tests/unit/architecture/hexagonalBoundaries.test.js` |
| `SaaSClient` está en la master (conexión por defecto de Mongoose), `tenantKey` **en minúsculas** y `status` con `active`, `inactive` o `suspended`. | `src/infrastructure/database/models/global/SaaSClient.js`, `.../master/database.js` |
| Ya hay un JWT HS256 hecho a mano con `crypto` (sin librería) que **no verifica el header `alg`**. | `src/interfaces/http/middlewares/tenantResolver.js:18-46` |
| Redis: `getRedisClient()` (paquete `redis` v4, conexión perezosa). | `src/infrastructure/cache/redisClient.js` |
| `env.js` exporta las variables con nombre; `.env.example` tiene un bloque `# ─── Auth`. | `src/infrastructure/config/env.js`, `.env.example:32-34` |
| Fastify no tiene `trustProxy`: detrás del proxy todas las requests tienen la misma IP (por eso el límite de intentos es por email). | `src/infrastructure/config/app.config.js` |
| `routeAuthWiring.test.js` prueba el cableado de auth por ruta con controllers falsos. | `tests/unit/interfaces/routeAuthWiring.test.js` |

## Decisiones de este plan (cambiables antes de aprobar)

1. **`tenantKey` tal como está guardado** (minúsculas) en todas las respuestas. El front lo trata como texto opaco; los ejemplos del contrato con `ACME` son ilustrativos. El código de ticket (plan 2) es el que va en mayúsculas.
2. **`status` del tenant tal cual** (`active`, `inactive`, `suspended`) en `GET /staff/tenants`. El front lo acepta como texto.
3. **Redis caído en el login:** el límite de intentos *falla abierto* (deja intentar y loguea `warn`). Alternativa: fallar cerrado (`503`), que bloquearía a todos si Redis cae.
4. **Usuario inexistente:** se calcula igual un scrypt contra un hash fijo, para que el tiempo de respuesta no revele qué correos existen.
5. **Contraseña temporal:** 14 caracteres de un alfabeto sin ambiguos (sin `0/O/1/l/I`), con `crypto.randomInt`.
6. **Smarteam con tenant suspendido:** puede ver todo. **Cliente de tenant suspendido o inactivo:** puede entrar (decisión del spec, §1 "Estado del tenant").
7. **La sesión no se renueva sola** (8 h fijas desde el login o el último cambio de contraseña).

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `package.json` / `package-lock.json` | Modificar | `@fastify/cookie@9.4.0` (exacta) |
| `src/infrastructure/config/env.js` | Modificar | Exportar `PANEL_JWT_SECRET` |
| `.env.example` | Modificar | `PANEL_JWT_SECRET=` en el bloque `# ─── Auth` |
| `src/domain/panel/permissions.js` | Crear | Constantes de permisos y `permissionsFor({ accountType, role })` (tabla del spec, Fase 1) |
| `src/domain/panel/passwordPolicy.js` | Crear | Largo mínimo (10) y reglas de la contraseña nueva |
| `src/application/ports/panel/*.port.js` | Crear | Puertos: `panel-user-repository`, `password-hasher`, `session-token`, `login-attempts`, `tenant-directory`, `temporary-password-generator` |
| `src/application/use-cases/panel/LoginPanelUser.js` | Crear | Login con límite de intentos |
| `src/application/use-cases/panel/ResolvePanelSession.js` | Crear | De un token a un usuario de sesión válido (o motivo de rechazo) |
| `src/application/use-cases/panel/ChangePanelPassword.js` | Crear | Cambio de contraseña (C2, C3) |
| `src/application/use-cases/panel/ManagePanelUsers.js` | Crear | Listar, crear, actualizar, restablecer (C6, C8, C9) |
| `src/application/use-cases/panel/ListPanelTenants.js` | Crear | Empresas para los selectores (C7) |
| `src/application/use-cases/panel/panelUserView.js` | Crear | Proyección pública del usuario (C6) y cuerpo de `/auth/me` |
| `src/infrastructure/database/models/global/PanelUser.js` | Crear | Modelo `PanelUser`, colección `PanelUsers`, índice único en `email` |
| `src/infrastructure/database/master/database.js` | Modificar | Exportar `PanelUser` como los demás modelos globales |
| `src/infrastructure/database/repositories/MongoosePanelUserRepository.js` | Crear | Adaptador del repositorio |
| `src/infrastructure/database/repositories/SaaSClientTenantDirectory.js` | Crear | Empresas desde `SaaSClient` (solo `tenantKey`, `companyName`, `status`) |
| `src/infrastructure/auth/ScryptPasswordHasher.js` | Crear | Hash y verificación con `crypto.scrypt` |
| `src/infrastructure/auth/HmacSessionToken.js` | Crear | JWT HS256 propio (firma y verificación, **con** chequeo de `alg`/`typ`) |
| `src/infrastructure/auth/RedisLoginAttempts.js` | Crear | Contador de fallidos por email (Redis, ventana de 15 min) |
| `src/infrastructure/auth/RandomTemporaryPassword.js` | Crear | Generador de temporales |
| `src/composition/panel.composition.js` | Crear | Construye los casos de uso del panel |
| `src/interfaces/http/panel/panelPlugin.js` | Crear | Plugin encapsulado: cookie, hooks, errores, rutas |
| `src/interfaces/http/panel/panelSession.js` | Crear | Hook de sesión, `requirePermission`, `requirePanelHeader`, restricción de `pwdChange` |
| `src/interfaces/http/panel/panelErrors.js` | Crear | `reason` → `{ status, error, message }` y el `setErrorHandler`/`setNotFoundHandler` del prefijo |
| `src/interfaces/http/controllers/panelAuth.controller.js` | Crear | login, logout, me, change-password |
| `src/interfaces/http/controllers/panelUsers.controller.js` | Crear | CRUD de usuarios y tenants de staff |
| `src/interfaces/http/routes/index.js` | Modificar | Registrar el plugin con `prefix: '/panel/api'` (si hay secreto) |
| `scripts/create-panel-staff.js` | Crear | Alta de la primera cuenta de Smarteam (imprime la temporal) |
| `tests/unit/domain/panelPermissions.test.js` | Crear | Matriz cuenta × rol × permiso |
| `tests/unit/application/panel/*.test.js` | Crear | Casos de uso con fakes |
| `tests/unit/infrastructure/panelAuthAdapters.test.js` | Crear | scrypt, token (alg, firma, exp), temporales |
| `tests/unit/interfaces/panelApi.test.js` | Crear | Plugin completo con `Fastify().inject` y fakes: cookie, CSRF, errores, permisos, C1–C9 |
| `tests/unit/interfaces/routeAuthWiring.test.js` | Modificar | Rutas del panel: sesión y permiso de cada una; sesión del panel rechazada en rutas existentes y `x-internal-key` rechazada en `/panel/api` |
| `tests/integration/panelUsers.test.js` | Crear | `mongodb-memory-server`: índice único de email, paginación y orden, flujo login → cambio → me |
| `README.md` | Modificar | Sección del panel: variable, script de la primera cuenta, rutas |

---

### Task 0: Baseline

- [ ] Correr la suite completa y anotar suites/tests rojos. Debe coincidir con la última conocida o se anota la nueva antes de tocar nada.
- [ ] `npm install @fastify/cookie@9.4.0 --save-exact` y verificar que `npm ls fastify` sigue en 4.29.x.

### Task 1: Dominio — permisos y política de contraseña

**Files:** `src/domain/panel/permissions.js`, `src/domain/panel/passwordPolicy.js`, `tests/unit/domain/panelPermissions.test.js`

**Interfaces:**
- `PANEL_PERMISSIONS` (congelado): `TICKETS_READ 'tickets.read'`, `TICKETS_CREATE`, `TICKETS_REPLY`, `TICKETS_REOPEN`, `EVENTS_READ`, `SYNCS_READ`, `STAFF_TICKETS 'staff.tickets'`, `STAFF_USERS 'staff.users'`, `STAFF_EVENTS_RAW 'staff.events.raw'`.
- `permissionsFor({ accountType, role }): string[]` — Fase 1:
  - `smarteam` → `events.read`, `syncs.read`, `staff.tickets`, `staff.users`, `staff.events.raw`;
  - `cliente` (`admin` o `usuario`, iguales en Fase 1) → `tickets.read`, `tickets.create`, `tickets.reply`, `tickets.reopen`, `events.read`, `syncs.read`;
  - cualquier otra combinación → `[]`.
- `PASSWORD_MIN_LENGTH = 10`; `validateNewPassword({ newPassword, currentPassword }) → null | message` (mensajes del contrato C2: "Debe tener al menos 10 caracteres." / "La contraseña nueva debe ser distinta de la actual.").

- [ ] Test de la matriz (cada cuenta y rol, y que Smarteam **no** tiene `tickets.*`).
- [ ] Implementar. Verde.

### Task 2: Modelo `PanelUser` y repositorio

**Files:** `models/global/PanelUser.js`, `master/database.js`, `repositories/MongoosePanelUserRepository.js`, puerto `panel-user-repository.port.js`, `tests/integration/panelUsers.test.js` (parte del repo)

**Modelo** (spec §1): `email` (String, requerido, único, `lowercase`, `trim`), `name`, `accountType` (`smarteam`|`cliente`), `tenantKey` (String|null, `lowercase`), `role` (`admin`|`usuario`|null), `passwordHash`, `mustChangePassword` (Boolean), `active` (Boolean, default `true`), `tokenVersion` (Number, default 0), `lastLoginAt`, `createdBy` (ObjectId|null), `timestamps: true`, `collection: 'PanelUsers'`. Validación: si `cliente`, `tenantKey` y `role` obligatorios; si `smarteam`, ambos `null`. Índices: `{ email: 1 }` único y `{ tenantKey: 1, createdAt: -1 }`.

**Puerto:** `findByEmail(email)`, `findById(id)`, `create(data)` (lanza un error de dominio `EMAIL_TAKEN` ante el `E11000`), `update(id, patch)`, `incrementTokenVersion(id, extraPatch)`, `list({ tenantKey, page, pageSize }) → { items, total }` ordenado por `createdAt` desc (C8), `touchLastLogin(id, date)`.

- [ ] Integración con memoria: índice único (dos altas con el mismo correo en distinta capitalización → `EMAIL_TAKEN`), paginación y orden, filtro por `tenantKey`.
- [ ] Implementar. Verde.

### Task 3: Adaptadores de seguridad

**Files:** `infrastructure/auth/ScryptPasswordHasher.js`, `HmacSessionToken.js`, `RedisLoginAttempts.js`, `RandomTemporaryPassword.js`, sus puertos, `tests/unit/infrastructure/panelAuthAdapters.test.js`

- **Hasher:** formato `scrypt$N$r$p$<salt base64>$<hash base64>` con `N=16384, r=8, p=1`, sal de 16 bytes, clave de 64 bytes; `verify` con `timingSafeEqual`; `hash` y `verify` asíncronos (`util.promisify(crypto.scrypt)`). Incluye un `DUMMY_HASH` para el caso "usuario no existe" (decisión 4).
- **Token:** `sign({ sub, tv, pwdChange }, { expiresInSeconds: 28800 }) → string` con header `{"alg":"HS256","typ":"JWT"}`; `verify(token) → payload | null`: rechaza si el header no es exactamente HS256/JWT, firma inválida (comparación en tiempo constante), `exp` vencido o payload mal formado. Secreto inyectado (`PANEL_JWT_SECRET`); constructor lanza si falta.
- **Intentos:** clave `panel:login:fail:<sha256(email en minúsculas)>`; `isBlocked(email)` (≥ 5), `registerFailure(email)` (`INCR` + `EXPIRE 900` si es el primero), `reset(email)`. Ante error de Redis: `isBlocked` devuelve `false` y loguea `warn` (decisión 3).
- **Temporales:** 14 caracteres, `crypto.randomInt`, alfabeto sin ambiguos.

- [ ] Tests: hash ≠ contraseña y verifica; dos hashes de la misma contraseña difieren; token con `alg: none` o `HS512` → `null`; firma alterada → `null`; vencido → `null`; temporales con largo y alfabeto correctos. `RedisLoginAttempts` con un cliente falso (incluido el que lanza).
- [ ] Implementar. Verde.

### Task 4: Casos de uso

**Files:** `application/use-cases/panel/*.js`, `tests/unit/application/panel/*.test.js` (con repositorios y adaptadores falsos)

**`panelUserView.js`:** `toPublicUser(user, companyName)` → forma de **C6** (sin `passwordHash` ni `tokenVersion`); `toSessionBody(user, companyName)` → forma de `/auth/me` (`name, email, accountType, role, tenantKey, companyName, permissions, mustChangePassword`).

**`LoginPanelUser.execute({ email, password })`**
1. Validar forma (`email` y `password` presentes) → `VALIDATION_ERROR`.
2. `isBlocked(email)` → `TOO_MANY_ATTEMPTS` (aunque la contraseña sea correcta: así lo prueba el front).
3. Buscar usuario; si no existe o `active === false`, verificar contra `DUMMY_HASH`, `registerFailure` → `INVALID_CREDENTIALS` (mismo error en los tres casos).
4. Contraseña incorrecta → `registerFailure` → `INVALID_CREDENTIALS`.
5. Éxito: `reset(email)`, `touchLastLogin`, token `{ sub, tv: tokenVersion, pwdChange: mustChangePassword }`, devuelve `{ token, session: toSessionBody(...) }` (**C4**).

**`ResolvePanelSession.execute({ token })`** → `{ ok, user, permissions, pwdChange }` o `UNAUTHORIZED` si: no hay token, token inválido, usuario inexistente, `active === false` o `tokenVersion !== tv`. Así un cambio de rol o una desactivación rigen en el request siguiente (Seguridad 5).

**`ChangePanelPassword.execute({ userId, currentPassword, newPassword })`**
- `currentPassword` incorrecta → `INVALID_CURRENT_PASSWORD` (**400, no 401**: C2).
- `validateNewPassword` → `VALIDATION_ERROR` con el mensaje.
- Éxito: nuevo hash, `mustChangePassword: false`, `tokenVersion + 1`, y devuelve un **token nuevo** con el `tv` vigente y `pwdChange: false` (**C3**).

**`ManagePanelUsers`**
- `list({ tenantKey, page, pageSize })`: `page ≥ 1`, `1 ≤ pageSize ≤ 100` (si no, `VALIDATION_ERROR`); `{ items: toPublicUser[], page, pageSize, total }` con `companyName` resuelto desde el directorio de tenants (una consulta por página, no por fila).
- `create({ actor, email, name, accountType, tenantKey, role })`: validar (`email` con formato, `name` 1–100, `accountType` válido; `cliente` exige `tenantKey` **existente en `SaaSClient`** y `role`; `smarteam` no los admite) → `VALIDATION_ERROR`; temporal nueva; `mustChangePassword: true`; `EMAIL_TAKEN` → 409. Devuelve `{ user, temporaryPassword }` (**201**).
- `update({ actor, id, patch })`: solo `name`, `role`, `active`. `tenantKey` o `accountType` en el patch → `VALIDATION_ERROR`. `role` en una cuenta `smarteam` → `VALIDATION_ERROR`. `active: false` sobre sí mismo → `VALIDATION_ERROR` "No puedes desactivar tu propia cuenta" (**C9**). Desactivar sube `tokenVersion` (corta la sesión abierta). Id inexistente o mal formado → `NOT_FOUND`.
- `resetPassword({ id })`: temporal nueva, `mustChangePassword: true`, `tokenVersion + 1`. Devuelve `{ temporaryPassword }`.

**`ListPanelTenants.execute()`** → `{ items: [{ tenantKey, companyName, status }] }` sin paginar, **incluidos** suspendidos e inactivos (**C7**), ordenados por `companyName`.

- [ ] Tests por cada regla de arriba (incluido: el sexto intento se bloquea con la contraseña correcta; un usuario desactivado o con `tv` viejo no resuelve sesión; cambiar el rol cambia `permissions` en la siguiente resolución).
- [ ] Implementar. Verde.

### Task 5: Plugin HTTP `/panel/api`

**Files:** `interfaces/http/panel/panelPlugin.js`, `panelSession.js`, `panelErrors.js`, `controllers/panelAuth.controller.js`, `controllers/panelUsers.controller.js`, `composition/panel.composition.js`, `routes/index.js`, `tests/unit/interfaces/panelApi.test.js`

**Plugin** (`async function panelPlugin(app, { useCases, cookieSecure = true })`):
- `app.register(cookie)` (sin firmar la cookie: el JWT ya va firmado).
- `setErrorHandler`: errores de validación de Fastify → `400 { error: 'validation_error', message }`; resto → `500 { error: 'internal_error' }` y log del error **sin** headers ni body.
- `setNotFoundHandler` → `404 { error: 'not_found' }`.
- Hook `onRequest` en este orden:
  1. **CSRF:** métodos `POST/PUT/PATCH/DELETE` sin `X-Panel-Request: 1` → `403 missing_panel_header` (también en login).
  2. **Sesión:** todo menos `POST /auth/login`. Lee `panel_session`, `ResolvePanelSession`; si falla → `401 unauthorized` (y limpia la cookie). Deja `req.panelUser = { id, name, email, accountType, role, tenantKey, permissions }` y `req.panelPwdChange`.
  3. **Cambio pendiente:** con `pwdChange`, solo pasan `GET /auth/me` (**C1**: responde 200 con `mustChangePassword: true`), `POST /auth/change-password` y `POST /auth/logout`; el resto → `403 password_change_required`.
- `requirePermission(perm)` como `preHandler` de cada ruta protegida → `403 forbidden`.

**Rutas:**

| Método y ruta | preHandler | Respuesta |
|---|---|---|
| `POST /auth/login` | — | 200 cuerpo de `/me` + `Set-Cookie` (C4); 400/401/429 |
| `POST /auth/logout` | sesión | 204 y cookie borrada (`Max-Age=0`, mismo `Path`) |
| `GET /auth/me` | sesión | 200 cuerpo de `/me` (C1) |
| `POST /auth/change-password` | sesión | 204 + **cookie nueva** (C3); 400 `invalid_current_password` / `validation_error` |
| `GET /staff/users` | `staff.users` | `{ items, page, pageSize, total }` (C6, C8) |
| `POST /staff/users` | `staff.users` | 201 `{ user, temporaryPassword }`; 409 `email_taken` |
| `PATCH /staff/users/:id` | `staff.users` | 200 `{ user }`; 400 (C9, campos prohibidos); 404 |
| `POST /staff/users/:id/reset-password` | `staff.users` | 200 `{ temporaryPassword }`; 404 |
| `GET /staff/tenants` | `staff.users` **o** `staff.tickets` **o** `staff.events.raw` | 200 `{ items }` (C7; lo usan Usuarios, Bandeja y Eventos/Syncs) |

- Respuestas con datos de sesión o temporales: `Cache-Control: no-store`.
- `routes/index.js`: `if (env.PANEL_JWT_SECRET) app.register(panelPlugin, { prefix: '/panel/api', useCases: buildPanelUseCases() }) else logger.warn(...)`.

**Tests** (`Fastify().inject`, casos de uso reales con repositorios en memoria, Redis falso):
- [ ] Login: cookie con `HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=28800`; 401 mismo error para "no existe", "desactivado" e "incorrecta"; 6º intento → 429; sin `X-Panel-Request` → 403.
- [ ] `pwdChange`: `/auth/me` 200 con `mustChangePassword: true`; `/staff/users` → 403 `password_change_required`; cambio → 204 con cookie nueva que ya pasa a `/staff/users` (si es Smarteam).
- [ ] C2: actual incorrecta → **400** `invalid_current_password`; corta o igual → 400 `validation_error` con el mensaje.
- [ ] Sesión: sin cookie → 401; cookie con `tv` viejo (tras reset o desactivación) → 401; cambio de rol → `permissions` nuevos en el request siguiente.
- [ ] Permisos: cuenta `cliente` → 403 en **cada** ruta `/staff/*`; Smarteam con solo `staff.events.raw` → 200 en `/staff/tenants`.
- [ ] Usuarios: C6 sin `passwordHash`/`tokenVersion`; 201 con temporal; 409 `email_taken`; `tenantKey`/`accountType` en PATCH → 400; desactivarse a sí mismo → 400 (C9); id inexistente → 404 `not_found`; `pageSize=101` → 400.
- [ ] Errores: ruta inexistente bajo `/panel/api` → 404 `{ error: 'not_found' }`; JSON mal formado → 400 `validation_error`; ninguna respuesta con `ok: false`.
- [ ] Sin `PANEL_JWT_SECRET`: `/panel/api/auth/me` → 404 de Fastify y el `warn` logueado.

### Task 6: Cableado y aislamiento con las rutas existentes

**Files:** `tests/unit/interfaces/routeAuthWiring.test.js`

- [ ] Cada ruta del panel aparece con su hook de sesión y su permiso (Seguridad 8).
- [ ] Una cookie `panel_session` válida **no** abre `/webhooks/*`, rutas admin (`/config/*`, `/mapping/*`) ni master (Seguridad 6).
- [ ] `x-internal-key` válida **no** abre ninguna ruta de `/panel/api` (401).
- [ ] Un token firmado con `JWT_SECRET` (el de los webhooks) no sirve como `panel_session`.

### Task 7: Script de la primera cuenta y documentación

**Files:** `scripts/create-panel-staff.js`, `README.md`, `.env.example`, `env.js`

- `node scripts/create-panel-staff.js <email> "<nombre>"`: conecta con `MONGODB_URI`, crea un `PanelUser` `smarteam` con temporal y `mustChangePassword: true`, imprime **solo** la temporal y sale. Si el correo existe, sale con código 1 y un mensaje claro (no la sobrescribe). En producción: `docker compose exec api node scripts/create-panel-staff.js ...`.
- README: variable `PANEL_JWT_SECRET` (cómo generarla: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`), el script, la lista de rutas y que la cookie exige HTTPS fuera de `localhost`.

- [ ] Test del script con memoria (alta y correo repetido) o, si el script no es importable sin efectos, un caso de uso `CreateFirstStaffUser` probado y el script como envoltorio mínimo.

### Task 8: Prueba contra el front y cierre

- [ ] Suite completa: solo pueden quedar rojos los de la baseline de la Tarea 0.
- [ ] Prueba manual con el panel: en `smartHubPanel`, `npm run dev` (proxy de Vite `/api` → `http://localhost:3000/panel/api`). Crear la cuenta Smarteam con el script, entrar, cambiar la contraseña, crear un usuario de cliente, restablecerlo, cambiarle el rol, desactivarlo y verificar que su sesión abierta se corta.
- [ ] Dejar en el chat: qué cambió y dónde, y **cualquier diferencia con C1–C9** (para que el front ajuste).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| `@fastify/cookie` 10/11 se instala por error (piden Fastify 5). | Versión exacta `9.4.0` y `npm ls fastify` en la Tarea 0. |
| El parser JSON propio de `app.js` (`addContentTypeParser`) responde con un error con otro formato. | El `setErrorHandler` del plugin lo traduce a `validation_error`; hay test. |
| Redis caído deja sin límite de intentos. | Decisión 3 (falla abierto con `warn`); reversible a cerrado si se prefiere. |
| Rendimiento: una consulta a la master por request para validar la sesión. | Aceptado por el spec para un panel; índice por `_id`. |
| Cookie `Secure` en desarrollo. | Los navegadores la aceptan en `http://localhost`; en otros hosts hace falta HTTPS (documentado). |
| `tenantKey` en minúsculas vs ejemplos en mayúsculas del contrato. | Decisión 1; el front no depende del formato. |
