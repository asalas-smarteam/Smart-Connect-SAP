# Panel — Endurecimiento del acceso (límite de logins, auditoría, logout en el servidor) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado:** borrador. **Pendiente de aprobación explícita del usuario.** No se toca código hasta entonces.

**Goal:** Cerrar los tres pendientes de seguridad del plan 1:
- un tope global de cálculos de contraseña simultáneos y un límite de logins por IP;
- un registro de auditoría de las acciones sobre usuarios y de los logins;
- que el logout invalide esa sesión en el servidor.

**Spec:** `docs/superpowers/specs/2026-10-13-panel-acceso-endurecimiento-design.md`.

**Depende de:** el plan 1, `docs/superpowers/plans/2026-10-13-panel-acceso.md`. Su código ya está en el árbol de trabajo.

**Architecture:** Todo queda dentro del módulo del panel, con la misma estructura del plan 1:
- dominio en `src/domain/panel/`;
- puertos y casos de uso en `src/application/.../panel/`;
- Mongoose, Redis y crypto en `src/infrastructure/`;
- HTTP en `src/interfaces/http/panel/`;
- cableado en `src/composition/panel.composition.js`.

Las dos colecciones nuevas (`PanelAuditLogs`, `PanelRevokedSessions`) van en la master, junto a `PanelUsers`.

**Tech Stack:** el mismo del plan 1. Sin dependencias nuevas: `net.BlockList` y `crypto` vienen con Node.

## Global Constraints

- Trabajar en `main`, sin ramas ni worktrees. **No** `git add`, `commit` ni `push`. Al terminar cada tarea, dejar en el chat qué cambió, en qué archivos y por qué.
- **Nada existente fuera del panel cambia.** No se tocan `src/main/app.js`, `app.config.js` (`trustProxy` sigue apagado), `env.js`, `master/database.js`, modelos de tenant ni rutas fuera de `/panel/api`. Tampoco se cambia `UV_THREADPOOL_SIZE`.
- Los únicos archivos existentes que cambian son los del plan 1, el README y `.env.example`.
- Formato de error del panel sin cambios: `{ error, message? }`.
- La auditoría **nunca** guarda contraseñas, temporales, hashes, tokens, cookies ni headers.
- Jest: `NODE_OPTIONS=--experimental-vm-modules npx jest <archivos> --testPathIgnorePatterns=worktrees`. Las pruebas de integración (`mongodb-memory-server`) se corren en Windows.

## Decisiones (del spec; cambiables antes de aprobar)

1. Scrypt: 2 simultáneos y 32 en cola. Con la cola llena → 429 `too_many_attempts` + `Retry-After: 5` (propuesta **R5**).
2. Límite por IP: 30 intentos en 15 min, sin reinicio al acertar. **Apagado si no hay `PANEL_TRUSTED_PROXIES`.**
3. La IP del cliente se lee de `X-Forwarded-For`, recorriendo de derecha a izquierda solo a través de proxies de confianza.
4. Auditoría *best effort*. Los eventos `auth.*` vencen a los 180 días; los `user.*` no vencen.
5. Logout: revoca el `sid` de esa sesión hasta su `exp`. Si la revocación falla, responde 204 igual y loguea `error`.
6. Token sin `sid` → 401.

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/domain/panel/errors.js` | Modificar | + `PanelHasherBusyError` (`code = 'PANEL_HASHER_BUSY'`) |
| `src/domain/panel/auditActions.js` | Crear | `AUDIT_ACTIONS`, `AUDIT_SOURCES`, `AUTH_EVENT_RETENTION_DAYS = 180`, `auditExpiresAt(action, at)` |
| `src/application/ports/panel/audit-log.port.js` | Crear | `record` (nunca lanza) |
| `src/application/ports/panel/revoked-session-store.port.js` | Crear | `revoke`, `isRevoked` |
| `src/application/use-cases/panel/panelAudit.js` | Crear | `buildAuditEntry(...)` y `actorOf(user)`: la forma única de las entradas |
| `src/application/use-cases/panel/LoginPanelUser.js` | Modificar | Límite por IP, `clientIp`, auditoría de login |
| `src/application/use-cases/panel/ResolvePanelSession.js` | Modificar | Rechaza un `sid` revocado (en paralelo con la carga del usuario) |
| `src/application/use-cases/panel/ChangePanelPassword.js` | Modificar | Auditoría `auth.password_changed` |
| `src/application/use-cases/panel/ManagePanelUsers.js` | Modificar | Auditoría `user.*`; el actor pasa a ser `{ id, email, accountType }` y se suman `ip` y `source` |
| `src/application/use-cases/panel/LogoutPanelSession.js` | Crear | Revoca el `sid` y audita |
| `src/infrastructure/auth/ConcurrencyLimiter.js` | Crear | Semáforo con cola acotada |
| `src/infrastructure/auth/ScryptPasswordHasher.js` | Modificar | Todo scrypt pasa por el limitador |
| `src/infrastructure/auth/HmacSessionToken.js` | Modificar | `sid` aleatorio en cada `sign`; `verify` lo exige |
| `src/infrastructure/auth/RedisLoginAttempts.js` | Modificar | Opciones `keyPrefix` y `maxAttempts` (renombra `maxFailures`), para reusarlo por IP |
| `src/infrastructure/config/panel.config.js` | Modificar | `trustedProxies` (de `PANEL_TRUSTED_PROXIES`) y límites |
| `src/infrastructure/database/models/global/PanelAuditLog.js` | Crear | Modelo e índices (TTL en `expiresAt`) |
| `src/infrastructure/database/models/global/PanelRevokedSession.js` | Crear | Modelo, `sid` único, TTL en `expiresAt` |
| `src/infrastructure/database/repositories/MongoosePanelAuditLog.js` | Crear | `record` *best effort* con `logger.error` |
| `src/infrastructure/database/repositories/MongooseRevokedSessionStore.js` | Crear | `revoke` (upsert idempotente) e `isRevoked` |
| `src/interfaces/http/panel/clientIp.js` | Crear | `createTrustedProxyMatcher(list)`, `resolveClientIp(...)` |
| `src/interfaces/http/panel/panelSession.js` | Modificar | Deja `req.panelClientIp` en cada request |
| `src/interfaces/http/panel/panelErrors.js` | Modificar | `PANEL_HASHER_BUSY` → 429 + `Retry-After` |
| `src/interfaces/http/panel/panelPlugin.js` | Modificar | Matcher de proxies, `warn` si el límite por IP queda apagado, logger para el logout |
| `src/interfaces/http/controllers/panelAuth.controller.js` | Modificar | IP al login, logout por caso de uso |
| `src/interfaces/http/controllers/panelUsers.controller.js` | Modificar | Actor completo e IP |
| `src/composition/panel.composition.js` | Modificar | Auditoría, sesiones revocadas, intentos por IP (o `null`), limitador |
| `scripts/create-panel-staff.mjs` | Modificar | `source: 'script'` en la auditoría |
| `docs/contrato-backend/04-endurecimiento.md` | Crear | R5 y el bloque de nginx para `smartHubPanel` |
| `README.md`, `.env.example` | Modificar | `PANEL_TRUSTED_PROXIES`, consultas de auditoría |
| Tests | Crear / modificar | Ver cada tarea |

---

### Task 0: Baseline

- [ ] Suite completa en Windows y en el espejo Linux. La última conocida, en el espejo y después del plan 1, era **215 suites, 4 rojas / 6 tests**: `sendMappedItemsToHubspot`, `lineItemPriceWebhook.service`, `serviceLayerService` y `replicateDefaultSapFilters` (esta última, solo por la descarga de `mongod`). Anotar la de Windows antes de tocar nada.

### Task 1: Tope global de scrypt

**Files:** `src/domain/panel/errors.js`, `src/infrastructure/auth/ConcurrencyLimiter.js`, `ScryptPasswordHasher.js`, `panelErrors.js`, `tests/unit/infrastructure/panelConcurrencyLimiter.test.js`, `panelAuthAdapters.test.js`, `panelApi.test.js`

**Interfaces:**
- `new ConcurrencyLimiter({ maxConcurrent = 2, maxQueue = 32 })`
  - `run(task)` → la promesa de `task()`.
  - Si hay lugar, corre. Si no, espera en cola FIFO. Con la cola llena, lanza `PanelHasherBusyError` **sin** llamar a `task`.
  - Libera el lugar al terminar, también si `task` falla.
- `new ScryptPasswordHasher({ limiter = new ConcurrencyLimiter() })`. `hash`, `verify` y `verifyDummy` derivan la clave dentro de `limiter.run`. El hash ficticio del constructor también pasa por el limitador.
- `panelErrors`: `error.code === 'PANEL_HASHER_BUSY'` → `Retry-After: 5` y `429 { error: 'too_many_attempts', message: 'Hay demasiados intentos en este momento. Intenta de nuevo en unos segundos.' }`.

- [ ] Tests del limitador:
  - nunca hay más de `maxConcurrent` corriendo a la vez;
  - el orden de la cola es FIFO;
  - con la cola llena lanza sin ejecutar la tarea;
  - un fallo libera el lugar.
- [ ] Test del hasher con un limitador lleno: lanza `PanelHasherBusyError` y no llama a scrypt.
- [ ] `panelApi.test.js`: un hasher falso que lanza `PanelHasherBusyError` en el login responde 429 con `Retry-After: 5`. Mientras tanto, `/outside` responde 200.
- [ ] Implementar. Verde.

### Task 2: IP del cliente

**Files:** `src/interfaces/http/panel/clientIp.js`, `panel.config.js`, `panelSession.js`, `panelPlugin.js`, `tests/unit/interfaces/panelClientIp.test.js`

**Interfaces:**
- `panelConfig.trustedProxies`: `PANEL_TRUSTED_PROXIES` separado por comas, sin espacios ni entradas vacías.
- `createTrustedProxyMatcher(entries)` → `{ enabled, isTrusted(ip), invalidEntries }`.
  - Arma un `net.BlockList`. Una entrada con `/` es una subred (`addSubnet`); sin `/`, una dirección (`addAddress`).
  - Las entradas inválidas no se cargan: van a `invalidEntries` y el plugin las loguea con `warn`.
  - `enabled` es `true` si quedó al menos una entrada válida.
- `normalizeIp(ip)`: quita el prefijo `::ffff:` y el puerto si viene, y trimea. Valida con `net.isIP`.
- `resolveClientIp({ socketAddress, forwardedFor, matcher })`:
  1. Arma la cadena `[...forwardedFor.split(','), socketAddress]`, normalizada y sin entradas inválidas.
  2. Desde el final, mientras la dirección sea de confianza, se mueve a la izquierda.
  3. Devuelve la primera que no es de confianza. Si todas lo son, devuelve la de más a la izquierda.
  4. Sin matcher habilitado, devuelve `normalizeIp(socketAddress)`.
- `panelSession`: el guard deja `req.panelClientIp = resolveClientIp(...)` antes del CSRF, para todas las rutas del panel.
- `panelPlugin`: recibe `trustedProxies = panelConfig.trustedProxies`. Si el matcher no quedó habilitado, `warn` `'Panel API: per-IP login limit disabled (PANEL_TRUSTED_PROXIES not set)'`.

- [ ] Tests:
  - sin proxies → IP del socket, ignorando `X-Forwarded-For` (un header falso no cambia nada);
  - socket de confianza + XFF `cliente` → `cliente`;
  - cadena `falso, cliente, proxy1` con `proxy1` y el socket de confianza → `cliente`;
  - CIDR `172.18.0.0/16` reconoce `::ffff:172.18.0.5`;
  - entrada inválida → queda en `invalidEntries` y el resto funciona;
  - XFF con basura → se descarta.
- [ ] Implementar. Verde.

### Task 3: Límite de login por IP

**Files:** `RedisLoginAttempts.js`, `LoginPanelUser.js`, `panel.composition.js`, `panelAuth.controller.js`, tests de adaptadores, casos de uso y API

**Interfaces:**
- `RedisLoginAttempts({ keyPrefix = 'panel:login:fail:', maxAttempts = 5, windowSeconds = 900, ... })`. Renombra `maxFailures` y actualiza los tests del plan 1. Mismo script Lua y mismo respaldo en memoria.
- `buildPanelUseCases({ ..., ipLoginAttempts })`. Por defecto:
  - `new RedisLoginAttempts({ keyPrefix: 'panel:login:ip:', maxAttempts: 30 })` si el plugin pasa `ipLimitEnabled: true`;
  - `null` si no.
- `LoginPanelUser.execute({ email, password, clientIp })`:
  1. Si hay `ipLoginAttempts` y `clientIp`, llama a `consume(clientIp)`. Si responde `blocked` → audita `auth.login_blocked { reason: 'ip' }` y responde `TOO_MANY_ATTEMPTS`. **Nunca** llama a `reset` del de IP.
  2. Después el de correo, como hoy. Si bloquea, audita `{ reason: 'email' }`.
  3. Recién después, scrypt.

- [ ] Tests:
  - el 31.º intento desde la misma IP es 429 aunque los correos cambien;
  - un login correcto no reinicia el contador de IP;
  - sin `ipLoginAttempts` (o sin IP) no hay límite por IP;
  - un bloqueo por IP no consume el contador de correo ni ejecuta scrypt.
- [ ] `panelApi.test.js`: con `trustedProxies: ['127.0.0.1']` y `X-Forwarded-For` distintos, cada IP cuenta por separado. Sin `trustedProxies`, aparece el `warn` y no hay 429 por IP.
- [ ] Implementar. Verde.

### Task 4: Registro de auditoría

**Files:** `auditActions.js`, `audit-log.port.js`, `panelAudit.js`, los casos de uso, `PanelAuditLog.js`, `MongoosePanelAuditLog.js`, controllers, composición, script, tests

**Interfaces:**
- `AUDIT_ACTIONS`:
  - `USER_CREATED`, `USER_UPDATED`, `USER_DEACTIVATED`, `USER_REACTIVATED`, `USER_PASSWORD_RESET`;
  - `LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `LOGIN_BLOCKED`, `PASSWORD_CHANGED`, `LOGOUT`.
  - Valores: `'user.created'`, …, `'auth.logout'`.
- `auditExpiresAt(action, at)`: `at + 180 días` si la acción empieza con `auth.`; `null` si no.
- `buildAuditEntry({ action, actor, target, details, ip, source = 'panel', now })` arma el documento.
  - `actor`: `{ userId, email, accountType }` o `null`.
  - `target`: `{ userId, email, tenantKey }` o `null`.
  - `details` solo acepta claves permitidas por acción. Los secretos no tienen dónde entrar.
- `PanelAuditLogPort.record(entry)`: nunca lanza. El adaptador captura el error y loguea `error({ msg: 'Panel audit log write failed', action, error: message })`.
- **Modelo `PanelAuditLog`**: colección `PanelAuditLogs`.
  - Campos: `at`, `action` (enum), `source` (enum), `actor`, `target`, `details` (Mixed), `ip`, `expiresAt`.
  - Índices: `{ at: -1 }`, `{ 'target.userId': 1, at: -1 }`, `{ action: 1, at: -1 }` y `{ expiresAt: 1 }` con `expireAfterSeconds: 0`.
- **Casos de uso:** reciben `auditLog` y `now`. Cada método de `ManagePanelUsers` suma `ip` y `source`. El actor pasa a ser `{ id, email, accountType }`; los controllers lo arman desde `req.panelUser`.
  - `create` → `user.created { accountType, role }`.
  - `update` → `user.updated { changes }`, solo con los campos que de verdad cambiaron, más `user.deactivated` o `user.reactivated` si cambió `active`.
  - `resetPassword` → `user.password_reset`.
  - Login: éxito, fallo (sin distinguir la causa) y bloqueo.
  - `ChangePanelPassword` → `auth.password_changed`.
- **Script:** `create({ actor: null, source: 'script', ... })`.

- [ ] Tests de casos de uso, con un `auditLog` falso que guarda las entradas:
  - cada acción registra la entrada esperada;
  - nada se registra si la acción falla por validación;
  - `JSON.stringify` de todas las entradas no contiene la contraseña, la temporal, el hash ni el token;
  - un `auditLog` que falla no cambia el resultado.
- [ ] Test del modelo (solo validación e índices, sin base) y del adaptador (*best effort*).
- [ ] Integración (`tests/integration/panelUsers.test.js`):
  - el alta por el script deja `source: 'script'`;
  - un login fallido deja `expiresAt` a 180 días;
  - una acción de usuario deja `expiresAt: null`.
- [ ] Implementar. Verde.

### Task 5: Logout que invalida la sesión

**Files:** `HmacSessionToken.js`, `revoked-session-store.port.js`, `PanelRevokedSession.js`, `MongooseRevokedSessionStore.js`, `ResolvePanelSession.js`, `LogoutPanelSession.js`, `panelAuth.controller.js`, `panelPlugin.js`, composición, tests

**Interfaces:**
- `HmacSessionToken.sign` suma `sid = crypto.randomBytes(16).toString('base64url')` (22 caracteres). `verify` exige `sid` string de 22 caracteres base64url; si no, devuelve `null`.
- `RevokedSessionStorePort`:
  - `revoke({ sid, userId, expiresAt })`: idempotente, `updateOne({ sid }, { $setOnInsert }, { upsert: true })`; ante `E11000` de una carrera, lo da por hecho.
  - `isRevoked(sid)` → boolean.
- **Modelo `PanelRevokedSession`**: colección `PanelRevokedSessions`. Índices `{ sid: 1 }` único y `{ expiresAt: 1 }` con `expireAfterSeconds: 0`.
- `ResolvePanelSession`: `Promise.all([findById(sub), isRevoked(sid)])`. Revocado → `UNAUTHORIZED`.
- `LogoutPanelSession.execute({ token, ip })`:
  1. `verify(token)`; si no es válido → `{ ok: true, data: { revoked: false } }`.
  2. Si es válido: `revoke({ sid, userId: sub, expiresAt: new Date(exp * 1000) })` y audita `auth.logout` con actor y target `{ userId: sub }`.
  3. Si `revoke` lanza → `{ ok: true, data: { revoked: false, failed: true } }`. El controller loguea `error` (sin el token) y responde 204 igual.
- El controller del logout siempre borra la cookie y responde 204.

- [ ] Tests:
  - dos logins del mismo usuario; logout con la primera cookie → esa da 401 y la segunda sigue en 200;
  - reenviar la cookie después del logout → 401;
  - token sin `sid` (firmado a mano con el secreto) → 401;
  - `revoke` que falla → 204, cookie borrada y `logger.error` sin el token;
  - logout sin cookie → 204 y sin escritura;
  - cambiar la contraseña emite un `sid` distinto.
- [ ] Integración: `sid` único, upsert idempotente y TTL declarado.
- [ ] Implementar. Verde.

### Task 6: Cableado

**Files:** `tests/unit/interfaces/routeAuthWiring.test.js`

- [ ] La tabla `PANEL_ROUTES` sigue verde con los tokens nuevos, que ahora llevan `sid`. Hay que pasar un `revokedSessions` falso y un `auditLog` falso a `buildPanelUseCases`.
- [ ] Una cookie del panel revocada da 401 en `GET /panel/api/auth/me`.

### Task 7: Documentación

**Files:** `README.md`, `.env.example`, `docs/contrato-backend/04-endurecimiento.md`

- `.env.example`: `PANEL_TRUSTED_PROXIES=`, con un comentario. Ejemplo: la subred de la red Docker que comparten el proxy y el contenedor del panel. Sin ella, el límite por IP queda apagado.
- README, sección 20:
  - el tope de scrypt y el 429;
  - `PANEL_TRUSTED_PROXIES`;
  - la auditoría, con consultas de ejemplo:

    ```js
    // historial de un usuario
    db.PanelAuditLogs.find({ 'target.userId': '<id>' }).sort({ at: -1 })
    // quién restableció contraseñas esta semana
    db.PanelAuditLogs.find({ action: 'user.password_reset', at: { $gte: ISODate('...') } })
    ```

  - el logout por sesión.
- `04-endurecimiento.md`, para el front:
  - **R5**: el 429 `too_many_attempts` con `Retry-After`, que puede aparecer en login, cambio de contraseña y alta o restablecimiento de usuarios;
  - el 429 por IP en el login;
  - el bloque `limit_req` de nginx del spec §1.4, con la nota del proxy con TLS.

### Task 8: Verificación y cierre

- [ ] Suite completa. Solo pueden quedar las rojas de la Tarea 0.
- [ ] Revisión de seguridad con un subagente sobre los archivos tocados: bypass del límite por IP, spoofing de `X-Forwarded-For`, secretos en la auditoría, revocación.
- [ ] Prueba manual con el panel:
  - dos navegadores con el mismo usuario; logout en uno → el otro sigue;
  - revisar `PanelAuditLogs` después de crear, restablecer y desactivar un usuario.
- [ ] Anotar en el plan las diferencias con lo escrito, como en el plan 1.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| `PANEL_TRUSTED_PROXIES` mal puesta, demasiado amplia (`0.0.0.0/0`): cualquiera falsifica su IP. | Documentar que solo van las redes de los proxies propios. Con una lista amplia, el límite por correo y el tope de scrypt siguen activos. |
| `PANEL_TRUSTED_PROXIES` vacía en producción: no hay límite por IP. | `warn` al arrancar. El tope global de scrypt protege igual al resto de la API. |
| Proxy con TLS delante del nginx del panel: todas las IP parecen la misma. | Incluir también la red de ese proxy en `PANEL_TRUSTED_PROXIES`. Verificar al desplegar (spec §1.4). |
| `PanelAuditLogs` crece con los logins. | TTL de 180 días en los eventos `auth.*`. |
| Una consulta más por request (`isRevoked`). | Índice único y en paralelo con `findById`. |
| Los tokens del plan 1 sin `sid` dejan de servir. | El panel no está en producción; solo obliga a volver a entrar. |

## Ejecución (2026-10-13)

Plan aprobado y ejecutado en `main`, sin commits. Verificación en el espejo Linux: suite unitaria de 221 suites, con las mismas 4 rojas de la baseline. La integración (`tests/integration/panelUsers.test.js`, que ahora también cubre la auditoría y el logout) se corre en Windows.

Diferencias con lo escrito, todas por la revisión de seguridad final:

1. **IPv6 por /64 en el límite por IP.** La clave del contador es la dirección IPv4 o el prefijo /64 de la IPv6 (`rateLimitKeyForIp` en `clientIp.js`). Con la dirección IPv6 completa, quien tiene un bloque podía cambiarla en cada request y no chocar nunca con el límite. La auditoría sigue guardando la IP completa.
2. **Un "correo" inválido no se guarda en la auditoría** (`target.email: null`), porque puede ser una contraseña escrita en el campo equivocado. Además, `email` tiene un máximo de 254 caracteres en el modelo.
3. **Solo se audita el primer bloqueo de la ventana.** `consume` devuelve además `firstBlocked`, y los reintentos ya bloqueados no escriben en la base.
4. **Un logout repetido con el mismo token no se audita de nuevo.** `revoke` devuelve `true` solo si esa llamada revocó la sesión.
5. Los casos de uso envuelven la escritura de auditoría (`recordAudit`), además del adaptador: un fallo nunca llega a la acción del usuario.

Pendiente de despliegue: confirmar que el nginx del panel agrega la IP con `$proxy_add_x_forwarded_for`, no reenviando el header tal cual. También poner en `PANEL_TRUSTED_PROXIES` todas las redes de los proxies propios, incluido el que termina el TLS si existe. Si falta uno, todos los usuarios comparten su IP y el límite por IP los bloquea juntos.
