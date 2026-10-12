# Proteger Bull Board (`/admin/queues`) con HTTP Basic Auth

## Problema

Bull Board está expuesto **sin ninguna autenticación**. El guard existe pero está comentado:

```js
// src/bootstrap/bullBoard.js:34-39
app.register(async (instance) => {
  //instance.addHook('onRequest', internalKeyAuthOnly);
  instance.register(serverAdapter.registerPlugin(), {
    prefix: basePath,
  });
});
```

Cualquiera que conozca la URL puede:

- ver las dos colas (`sap-sync` y `webhook`), sus jobs, payloads y errores (`tenantId`, `tenantKey`, `portalId` de cada cliente);
- **operar la cola de webhooks**: agregar jobs, reintentar, promover, borrar, limpiar o vaciar la cola (rutas `/api/queues/:queueName/add`, `/empty`, `/clean/...` de `@bull-board/api` 5.21.5). El adapter de webhooks no es read-only (`src/bootstrap/bullBoard.js:24`); el de sap-sync sí (`src/bootstrap/bullBoard.js:20-23`).

Además, el README afirma lo contrario (`README.md:342-344`: "Protección: header `x-internal-key`"), lo que da una falsa sensación de seguridad.

### Por qué el guard quedó comentado

Bull Board es una **UI que se abre en el navegador**. Un navegador no manda headers propios como `x-internal-key`, así que descomentar `src/bootstrap/bullBoard.js:35` deja la UI inaccesible también para el equipo. El arreglo necesita un mecanismo de autenticación **que el navegador soporte de forma nativa**.

Este spec es parte del plan de seguridad previo al panel admin (fase "Bull Board", después de la Fase A y del enmascarado de secretos ya desplegados en `5fd5978`). La fase B1 (firma de `/webhooks/hubspot/line-items/prices`) quedó en pausa por decisión del usuario y **no** forma parte de este cambio.

## Objetivo

Que `/admin/queues` y todo lo que cuelga de esa ruta (HTML, assets y la API JSON interna de Bull Board) exijan usuario y contraseña, con el diálogo de login nativo del navegador, **sin afectar nada más del servidor**: webhooks, syncs, rutas admin y colas siguen igual.

## Decisiones tomadas

| Decisión | Detalle |
|---|---|
| **Mecanismo: HTTP Basic Auth** | Sin credenciales, la respuesta es `401` con `WWW-Authenticate: Basic realm="Bull Board", charset="UTF-8"`. El navegador muestra su propio cuadro de usuario/contraseña y reenvía el header `Authorization` en cada request siguiente (HTML, assets y llamadas a `/admin/queues/api/*`). No requiere página de login ni sesión. |
| **Credenciales propias, no `INTERNAL_KEY`** | Variables nuevas `BULL_BOARD_USER` y `BULL_BOARD_PASSWORD`. `INTERNAL_KEY` abre la administración de todos los tenants y no debe teclearse en navegadores ni quedar en su gestor de contraseñas; además, rotar una no obliga a rotar la otra. |
| **Fail closed** | Si falta `BULL_BOARD_USER` o `BULL_BOARD_PASSWORD`, Bull Board **no se registra** (la ruta da `404`) y se loguea un `warn` al arrancar: `Bull Board disabled: BULL_BOARD_USER/BULL_BOARD_PASSWORD not set`. Nunca queda abierto por olvidar configurarlo. |
| **Comparación en tiempo constante** | Usuario y contraseña se comparan con `crypto.timingSafeEqual` sobre el SHA-256 de cada valor (así ambos buffers miden lo mismo sin importar el largo del input). Se comparan **los dos siempre**, sin cortocircuito, para no revelar cuál falló. |
| **Parseo robusto del header** | `Authorization: Basic <base64>`; se divide en el **primer** `:` (la contraseña puede contener `:`). Header ausente, otro esquema, base64 inválido o sin `:` → `401`. |
| **El hook cubre todo el prefijo** | Se registra como `onRequest` dentro del mismo plugin encapsulado donde hoy está la línea comentada (`src/bootstrap/bullBoard.js:34-39`), así aplica a todas las rutas de Bull Board y a ninguna otra. |
| **Hook reutilizable en `interfaces`** | La lógica va en `src/interfaces/http/middlewares/basicAuth.js` como `createBasicAuthHook({ username, password, realm })`, junto a `internalAuth.js` y `adminAuth.js`. `bullBoard.js` solo lee el entorno y la conecta (ya lee `process.env.BULL_BOARD_PATH` en `src/bootstrap/bullBoard.js:15`). |
| **La cola de webhooks sigue escribible** | Con autenticación, las acciones de la UI quedan solo para el equipo. Los jobs de esa cola son disparadores por tenant (`jobId` por tenant, payload `{tenantId, tenantKey, portalId, triggerType}`, `src/infrastructure/queue/webhook.queue.js:77-98`); los eventos reales viven en Mongo como `waiting`, así que reintentar o borrar un job no pierde eventos: el próximo disparo los procesa. Reintentar desde la UI es útil para soporte. |
| **Se borra el import sin uso** | `internalKeyAuthOnly` (`src/bootstrap/bullBoard.js:6`) queda sin uso y se elimina junto con la línea comentada (`:35`). |
| **README corregido** | `README.md:342-344` pasa a describir Basic Auth y las dos variables; `README.md:330` (lista de variables) suma `BULL_BOARD_USER` y `BULL_BOARD_PASSWORD`. `.env.example` las suma vacías en el bloque `# ─── Auth` (`.env.example:32-34`). |

## Componentes

### 1. `src/interfaces/http/middlewares/basicAuth.js` — nuevo

```js
export function createBasicAuthHook({ username, password, realm }) → async (req, reply) => {...}
```

- Si `Authorization` es válido y coincide → no hace nada (sigue el request).
- Si no → `reply.code(401).header('WWW-Authenticate', 'Basic realm="<realm>", charset="UTF-8"').send({ error: 'Unauthorized' })`, y retorna `reply` para cortar la cadena en un hook async de Fastify 4.
- No loguea credenciales ni el header `Authorization`.

### 2. `src/bootstrap/bullBoard.js` — cambia

- Lee `BULL_BOARD_USER` y `BULL_BOARD_PASSWORD`. Si falta alguna: `logger.warn(...)` y `return` antes de crear el `FastifyAdapter` (`:14`), sin registrar nada.
- En `:35`, en lugar del comentario: `instance.addHook('onRequest', createBasicAuthHook({ username, password, realm: 'Bull Board' }))`.
- Elimina el import de `:6`.
- El `logger.info` de `:41-44` se mantiene (y suma `auth: 'basic'`).

### 3. Lo que no cambia

- `src/main/app.js:34` sigue llamando `registerBullBoard(app)` igual.
- Ninguna otra ruta: el hook vive en el plugin encapsulado de Bull Board. `routeAuthWiring.test.js` no se toca porque no registra Bull Board.
- `BULL_BOARD_PATH` sigue funcionando igual.
- Colas, workers, scheduler: sin cambios.

## Testing (TDD, tests primero)

**`tests/unit/interfaces/basicAuth.test.js`** (hook puro, con `reply` falso):
- sin header `Authorization` → `401` + `WWW-Authenticate` con el realm;
- esquema distinto de `Basic` (`Bearer x`) → `401`;
- base64 inválido o sin `:` → `401`;
- usuario correcto + contraseña incorrecta → `401`; usuario incorrecto + contraseña correcta → `401`;
- credenciales correctas → no llama `reply.code`;
- contraseña que contiene `:` → se acepta (split en el primer `:`).

**`tests/unit/bullBoard.bootstrap.test.js`** (cableado real con `Fastify().inject`, colas mockeadas con `jest.unstable_mockModule` sobre `src/infrastructure/queue/sapSync.queue.js` y `webhook.queue.js`):
- `GET /admin/queues` sin credenciales → `401` con `WWW-Authenticate`;
- `GET /admin/queues/api/queues` sin credenciales → `401` (cubre la API JSON, no solo el HTML);
- con credenciales correctas → distinto de `401`;
- sin `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD` → `404` y `logger.warn` llamado;
- una ruta ajena registrada en la misma app (p. ej. `GET /health` falso) **no** pide credenciales.

Verificación de suite: comparar contra la baseline vigente (211 suites, 5 rojas preexistentes / 10 tests). Comando: `NODE_OPTIONS=--experimental-vm-modules npx jest <archivos> --testPathIgnorePatterns=worktrees`.

## Despliegue

1. **Antes** del deploy, agregar al `.env` del servidor `BULL_BOARD_USER` y `BULL_BOARD_PASSWORD` (contraseña larga y aleatoria, p. ej. `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`). Si se despliega sin ellas, Bull Board queda en `404` (fail closed) hasta configurarlas y reiniciar la API.
2. Desplegar y reiniciar la API (el worker no registra Bull Board).
3. Abrir `/admin/queues` en el navegador → debe aparecer el cuadro de login; con las credenciales, la UI carga y las colas se ven igual que antes.
4. Confirmar en logs que webhooks y syncs siguen respondiendo igual (nada más cambió).

**Impacto en tenants: ninguno.** Solo cambia el acceso a la UI de colas.

## Riesgo conocido, fuera de alcance

Basic Auth manda las credenciales en base64 (no cifradas): **solo es seguro sobre HTTPS**. `docker-compose.yml:7-8` publica el puerto `3000` del contenedor en el host. Si ese puerto es alcanzable desde internet por HTTP plano (y no solo a través de nginx con HTTPS), las credenciales podrían viajar sin cifrar y, de paso, toda la API queda expuesta por HTTP. Verificar en el servidor que `3000` solo escuche hacia nginx o esté cerrado en el firewall. No se cambia en este spec.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Descomentar `internalKeyAuthOnly`** (`src/bootstrap/bullBoard.js:35`) | El navegador no puede mandar `x-internal-key`: la UI quedaría inaccesible para el equipo. Es, con alta probabilidad, la razón por la que se comentó. |
| **Llave en la URL** (`/admin/queues?key=...`) | El hook global de `src/main/app.js:23-30` loguea `req.url` en cada request: la llave quedaría en los logs, además del historial del navegador. |
| **Usar `INTERNAL_KEY` como contraseña de Basic** | Esa llave abre la administración de todos los tenants; tipearla en navegadores y guardarla en su gestor de contraseñas amplía su exposición, y ata la rotación de ambas. |
| **Página de login con cookie de sesión** | Formulario, secreto de sesión, expiración y CSRF para una UI que usan una o dos personas del equipo. Basic resuelve lo mismo con el diálogo nativo del navegador. |
| **Restringir por IP en nginx** | Vive fuera del repo, no queda versionado ni testeado; si el puerto `3000` es alcanzable directo (`docker-compose.yml:7-8`) se saltea; y las IPs del equipo cambian. Puede sumarse después como capa extra, no reemplaza esto. |
| **Volver read-only la cola de webhooks** | Quita la posibilidad de reintentar desde la UI, que es útil para soporte, a cambio de proteger jobs que solo son disparadores (los eventos persisten en Mongo). Si el usuario lo prefiere, es una línea (`readOnlyMode: true` en `src/bootstrap/bullBoard.js:24`). |
| **Apagar Bull Board en producción** | Descartada si el equipo lo usa para soporte. Si no lo usa, sería la opción más simple: pendiente de confirmar con el usuario (ver abajo). |

## Pendiente de confirmar con el usuario antes del plan

1. **¿El equipo usa Bull Board en producción?** Si no, se evalúa apagarlo en lugar de protegerlo.
2. **¿La cola de webhooks debe quedar escribible?** (decisión tomada: sí; se revierte con una línea).
3. **¿El puerto `3000` es accesible desde internet o solo vía nginx/HTTPS?** No bloquea este cambio, pero condiciona qué tan seguro es Basic Auth.
