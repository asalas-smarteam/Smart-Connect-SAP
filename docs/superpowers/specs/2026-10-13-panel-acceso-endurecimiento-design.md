# Panel — endurecimiento del acceso: límite de logins, auditoría y cierre de sesión en el servidor

## Contexto

El plan 1 del panel (`docs/superpowers/plans/2026-10-13-panel-acceso.md`) dejó funcionando `/panel/api`: login, sesión en cookie, cambio de contraseña y gestión de usuarios. La revisión de seguridad que se hizo al terminarlo dejó tres pendientes, que el usuario decidió atender:

1. **Saturación por logins.** Hoy el único límite es por correo (5 fallidos en 15 min). Quien pruebe correos al azar nunca choca con ese límite, y cada intento cuesta un scrypt (16 MiB, unos 50 ms) en el pool de hilos de Node. Ese pool lo comparten la resolución de DNS y el sistema de archivos, así que con unas cien solicitudes por segundo se frenan también las llamadas a HubSpot y SAP de los webhooks y las syncs.
2. **No queda registro de quién hizo qué.** Crear, restablecer, desactivar o cambiar el rol de un usuario no deja rastro. Tampoco los logins.
3. **Cerrar sesión no la invalida.** El logout solo borra la cookie del navegador. Una cookie robada sigue sirviendo hasta que vence, 8 h después.

Este spec es una extensión del plan 1. Todo vive dentro del módulo nuevo del panel: no toca tenants, el core de la integración ni ninguna ruta existente.

## Decisiones del usuario (2026-10-13)

| Tema | Decisión |
|---|---|
| Cierre de sesión | Corta **solo esa sesión**. Las demás pestañas o equipos del mismo usuario siguen abiertos. |
| Auditoría | Se **guarda sin pantalla**. Colección nueva en la master, consultada desde Mongo. Cubre las acciones sobre usuarios **y** los eventos de login. El front no cambia. |
| Límite de logins | Se resuelve **en el backend**: un tope global de cálculos de contraseña simultáneos y un límite por IP. El bloque de nginx `limit_req` queda escrito para aplicarlo después en `smartHubPanel`, que es otro repo y no se toca desde aquí. |

## 1. Límite de logins

### 1.1 Tope global de cálculos de contraseña

Es lo que protege al resto de la API, con o sin IP real del cliente.

- Todo scrypt del panel pasa por un **limitador de concurrencia** dentro de `ScryptPasswordHasher`: `hash`, `verify` y `verifyDummy`, sea del login, del cambio de contraseña o del alta y restablecimiento de usuarios.
- Corren **como máximo 2 a la vez**. El pool de libuv tiene 4 hilos por defecto, así que quedan 2 libres para DNS y archivos. Hasta **32 esperan en cola**.
- Con la cola llena, el hasher lanza `PanelHasherBusyError` (código `PANEL_HASHER_BUSY`) sin calcular nada. El manejador de errores del panel lo responde como **429 `too_many_attempts`**, con `Retry-After: 5` y el mensaje "Hay demasiados intentos en este momento. Intenta de nuevo en unos segundos.". Ver propuesta **R5**.
- El tope es por proceso. La API corre en un solo contenedor (`docker-compose.yml`), así que es global.
- No se cambia `UV_THREADPOOL_SIZE`: eso afectaría a toda la API.

### 1.2 Límite por IP en el login

- Además del límite por correo, que se mantiene: **30 intentos por IP en 15 min**, cuenten bien o mal. A diferencia del de correo, un login correcto **no** lo reinicia; si lo hiciera, quien tenga una cuenta válida podría reiniciarlo a voluntad. 30 cubre de sobra a una empresa con varios usuarios detrás de la misma IP.
- Usa el mismo contador atómico del plan 1 (script Lua en Redis, con timeout de 1 s y respaldo en memoria), con otro prefijo de clave: `panel:login:ip:<sha256(ip)>`.
- El orden en el login es: primero el límite por IP, después el de correo, y recién al final el scrypt. Un bloqueo no gasta scrypt.

### 1.3 Cómo se obtiene la IP del cliente

Fastify no tiene `trustProxy` (`src/infrastructure/config/app.config.js:26-30`), y activarlo cambiaría el `req.ip` que loguea el hook de `src/main/app.js:23-30` para todas las rutas. Por eso el panel resuelve la IP por su cuenta, solo dentro de su plugin:

- Variable nueva **`PANEL_TRUSTED_PROXIES`**: lista separada por comas de IPs o rangos CIDR de los proxies propios, por ejemplo la red Docker compartida con el contenedor del panel y el proxy con TLS.
- Algoritmo, el estándar de `proxy-addr`: se arma la cadena `[...X-Forwarded-For, dirección del socket]` y se recorre de derecha a izquierda **mientras la dirección sea de confianza**. La primera que no lo es es la del cliente. Lo que un atacante agregue a la izquierda del header nunca se lee.
- Se normaliza `::ffff:a.b.c.d` a `a.b.c.d`, porque el servidor escucha en `::`. La verificación usa `net.BlockList` de Node, sin dependencias nuevas.
- **Sin `PANEL_TRUSTED_PROXIES`, el límite por IP queda apagado**, con un `warn` al arrancar. Detrás del proxy todas las solicitudes traen la misma IP: el límite por IP se volvería un límite global, y 30 intentos bloquearían a todo el panel. El tope global de 1.1 sigue activo igual.
- La IP resuelta se usa también en la auditoría (§2).

### 1.4 nginx del panel (para aplicar en `smartHubPanel`)

Queda documentado en `docs/contrato-backend/04-endurecimiento.md`, para copiarlo al plan 4 del front. No se aplica desde este repo.

```nginx
# http {}
limit_req_zone $binary_remote_addr zone=panel_login:10m rate=10r/m;

# server {}
location = /api/auth/login {
    limit_req zone=panel_login burst=5 nodelay;
    limit_req_status 429;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://api:3000/panel/api/auth/login;
}
```

**A verificar al desplegar:** si delante del nginx del panel hay otro proxy con TLS, `$binary_remote_addr` es la IP de ese proxy y la zona limitaría a todos juntos. En ese caso hace falta `real_ip_header X-Forwarded-For` y `set_real_ip_from` con la red del proxy. Es la misma pregunta abierta del spec principal: dónde termina hoy el TLS.

## 2. Registro de auditoría

### 2.1 Modelo `PanelAuditLog` (master, colección `PanelAuditLogs`)

| Campo | Tipo | Notas |
|---|---|---|
| `at` | Date | Momento del evento. |
| `action` | String (enum) | Ver 2.2. |
| `actor` | `{ userId, email, accountType }` \| null | Quién lo hizo. `null` en los eventos de login (el actor todavía no está autenticado) y en el script. |
| `source` | `'panel'` \| `'script'` | El script de la primera cuenta registra `'script'`. |
| `target` | `{ userId, email, tenantKey }` \| null | Sobre quién. En un login fallido de un correo inexistente, solo `email`. |
| `details` | Mixed | Por acción. Ejemplos: `{ accountType, role }` al crear; `{ changes: { role: { from, to } } }` al editar; `{ reason: 'email' \| 'ip' }` en un bloqueo. |
| `ip` | String \| null | IP del cliente según §1.3, o la del socket. |
| `expiresAt` | Date \| null | Solo los eventos `auth.*`: `at + 180 días`. Los de usuarios no vencen. |

Índices: `{ at: -1 }`, `{ 'target.userId': 1, at: -1 }`, `{ action: 1, at: -1 }` y TTL `{ expiresAt: 1 }` con `expireAfterSeconds: 0`. Mongo ignora los documentos con `expiresAt: null`. El TTL existe desde Mongo 2.2, así que sirve en producción (< 5.0).

**Nunca se guarda:** contraseñas, contraseñas temporales, hashes, tokens, cookies ni headers. Hay un test que lo verifica en cada acción.

### 2.2 Acciones

| Acción | Cuándo | `details` |
|---|---|---|
| `user.created` | Alta desde el panel o desde el script. | `{ accountType, role }` |
| `user.updated` | Cambio de nombre o de rol. | `{ changes: { campo: { from, to } } }` |
| `user.deactivated` / `user.reactivated` | Cambio de `active`. | — |
| `user.password_reset` | Restablecimiento por Smarteam. | — |
| `auth.login_succeeded` | Login correcto. | — |
| `auth.login_failed` | Credenciales inválidas, incluidos el correo inexistente y el usuario inactivo. | `{ reason: 'invalid_credentials' }`. No se distingue la causa: el registro tampoco revela qué correos existen. |
| `auth.login_blocked` | 429 por correo o por IP. | `{ reason: 'email' \| 'ip' }` |
| `auth.password_changed` | Cambio de contraseña del propio usuario. | — |
| `auth.logout` | Logout con un token válido. | — |

### 2.3 Escritura

- Un puerto `PanelAuditLogPort` con `record(entry)`. Los casos de uso lo reciben inyectado y registran **después** de que la acción salió bien, o en el rechazo, en el caso de los eventos de login.
- **Best effort:** si la escritura falla, se loguea un `error` (sin datos sensibles) y la acción del usuario **no** falla. La auditoría y los usuarios viven en la misma base master: si esa base cae, la acción falla de todas formas. Decisión cambiable: ver "Decisiones por defecto".
- Sin endpoint. Para consultar, el README deja ejemplos de `mongosh`. Por ejemplo, "historial de un usuario": `db.PanelAuditLogs.find({ 'target.userId': '<id>' }).sort({ at: -1 })`.

## 3. Cierre de sesión en el servidor (solo esa sesión)

- El JWT suma un **`sid`**: 16 bytes aleatorios en base64url, distinto en cada login y en cada cambio de contraseña. `HmacSessionToken.verify` exige `sid`, así que un token sin `sid` se rechaza. Afecta solo a las sesiones abiertas antes del despliegue: el panel todavía no está en producción.
- **Colección nueva `PanelRevokedSessions` (master):** `{ sid (único), userId, expiresAt }` con TTL en `expiresAt`. Cada documento se borra solo cuando el token habría vencido de todas formas.
- **Logout** (sigue siendo público y siempre responde 204, decisión 10 del plan 1): si la cookie trae un token con firma válida y no vencido, se revoca su `sid` hasta su `exp` y se registra `auth.logout`. Después se borra la cookie. Sin cookie, o con un token inválido, solo se borra la cookie.
- **Cada request:** `ResolvePanelSession` además consulta si el `sid` está revocado. Es una búsqueda por índice único en la master y corre en paralelo con la carga del usuario, así que no suma una ida y vuelta. Revocado → 401 `unauthorized`.
- Si la revocación falla (master caída), el logout responde igual 204 con la cookie borrada y loguea `error`. Decisión cambiable.
- `tokenVersion` sigue igual. Cambiar o restablecer la contraseña y desactivar un usuario cortan **todas** sus sesiones; el logout corta **solo una**.

Alternativa descartada: guardar los `sid` revocados en Redis. Funciona y es más rápido, pero con Redis caído el respaldo en memoria se pierde al reiniciar, y una sesión revocada volvería a servir. Mongo ya es dependencia de cada request del panel.

## Impacto

- **Variables nuevas:** `PANEL_TRUSTED_PROXIES` (opcional). Sin ella, el límite por IP queda apagado con un `warn`.
- **Colecciones nuevas en la master:** `PanelAuditLogs` y `PanelRevokedSessions`. Se crean al primer uso, con sus índices vía `autoIndex`, sin migración.
- **Contrato con el front:** solo la propuesta **R5** (un 429 nuevo en las rutas que calculan contraseñas). Lo demás es transparente.
- **Nada existente cambia:** ni `app.js`, ni `trustProxy`, ni `UV_THREADPOOL_SIZE`, ni las rutas fuera de `/panel/api`.

## Seguridad: reglas que el plan debe testear

1. Con la cola del hasher llena, se responde 429 **sin** ejecutar scrypt, y los demás endpoints de la API no se ven afectados.
2. Un `X-Forwarded-For` falso que llega directo, sin pasar por un proxy de confianza, no cambia la IP resuelta.
3. Sin `PANEL_TRUSTED_PROXIES`, el límite por IP no bloquea a nadie.
4. Un login correcto no reinicia el contador por IP.
5. Ninguna entrada de auditoría contiene contraseñas, temporales, hashes, tokens ni cookies.
6. Después del logout, la cookie vieja da 401 aunque se reenvíe a mano. Otra sesión del mismo usuario sigue funcionando.
7. Un token sin `sid` da 401.
8. Que la auditoría falle no hace fallar la acción.

## Decisiones por defecto (cambiables antes de aprobar)

1. 2 scrypt simultáneos y 32 en cola.
2. 30 intentos por IP cada 15 min, sin reinicio al acertar.
3. Auditoría *best effort* (no bloquea la acción si falla).
4. Los eventos `auth.*` se conservan 180 días; los de usuarios, siempre.
5. El logout responde 204 aunque la revocación falle (con log de error).
6. Al ocupado del hasher le corresponde el código `too_many_attempts` (429), no uno nuevo.

## Fuera de alcance

- Bloqueo por (correo, IP) en lugar de solo por correo: el usuario no lo pidió en esta ronda.
- Pantalla o endpoint de auditoría.
- Aplicar el bloque de nginx en `smartHubPanel`.
