# Bull Board con HTTP Basic Auth — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `/admin/queues` (UI, assets y API JSON de Bull Board) exija usuario y contraseña con el diálogo nativo del navegador, sin tocar ninguna otra ruta.

**Architecture:** Un hook `onRequest` reutilizable (`createBasicAuthHook`) en `src/interfaces/http/middlewares/basicAuth.js`, registrado dentro del plugin encapsulado de Bull Board en `src/bootstrap/bullBoard.js` (donde hoy está el guard comentado). Credenciales por entorno (`BULL_BOARD_USER`, `BULL_BOARD_PASSWORD`); si falta alguna, Bull Board no se registra (fail closed).

**Tech Stack:** Node ESM, Fastify 4.29.1, `@bull-board/api` + `@bull-board/fastify` 5.21.5, Jest 30 con `--experimental-vm-modules` y `jest.unstable_mockModule`.

**Spec aprobado:** `docs/superpowers/specs/2026-10-12-bull-board-basic-auth-design.md` (aprobado por el usuario el 2026-10-12).

## Global Constraints

- Trabajar en `main`, checkout principal. **No** `git add`, `git commit` ni `push`: el usuario commitea. Al terminar, dejar en el chat qué cambió, en qué archivos y por qué.
- Variables de entorno: exactamente `BULL_BOARD_USER` y `BULL_BOARD_PASSWORD`. **No** usar `INTERNAL_KEY`.
- Respuesta sin credenciales válidas: `401`, header `WWW-Authenticate: Basic realm="Bull Board", charset="UTF-8"`, body `{ "error": "Unauthorized" }`.
- Si falta `BULL_BOARD_USER` o `BULL_BOARD_PASSWORD`: no registrar Bull Board y loguear `logger.warn({ msg: 'Bull Board disabled: BULL_BOARD_USER/BULL_BOARD_PASSWORD not set' })`.
- Comparación en tiempo constante con `crypto.timingSafeEqual` sobre SHA-256; comparar usuario **y** contraseña siempre, sin cortocircuito.
- Nunca loguear credenciales ni el header `Authorization`.
- La cola de webhooks **sigue escribible** (no agregar `readOnlyMode` en `src/bootstrap/bullBoard.js:24`).
- Correr jest así (en Windows `npm test` no funciona): `NODE_OPTIONS=--experimental-vm-modules npx jest <archivos> --testPathIgnorePatterns=worktrees` (la opción **al final** y con `=`; si va antes, se traga las rutas y corre toda la suite).
- Baseline de la suite completa antes de este cambio: **211 suites, 5 rojas / 10 tests rojos**, siempre las mismas: `tests/integration/internalTenant.test.js`, `tests/unit/application/sendMappedItemsToHubspot.test.js`, `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js`, `tests/unit/serviceLayerService.test.js`.

## Hechos verificados antes de escribir el plan

Medido el 2026-10-12 con un script descartable fuera del repo (Fastify 4.29.1 + `@bull-board/fastify` 5.21.5, colas falsas, hook `onRequest` dentro del plugin encapsulado):

| Request | Sin credenciales | Con credenciales |
|---|---|---|
| `GET /admin/queues` (HTML) | `401` + `WWW-Authenticate` | `200` |
| `GET /admin/queues/api/queues` (API JSON) | `401` | `200` |
| `GET /admin/queues/static/main.<hash>.css` (asset) | `401` | `200` |
| `GET /health` registrada fuera del plugin | `200`, el hook ni la ve | — |

Una cola falsa con `{ name, getJobCounts, getJobs, isPaused, client }` alcanza para que `BullMQAdapter` (solo guarda la cola en el constructor) y `/api/queues` respondan `200`.

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/interfaces/http/middlewares/basicAuth.js` | Crear | Hook `onRequest` de HTTP Basic: parsea `Authorization`, compara en tiempo constante, responde `401` con el desafío |
| `tests/unit/interfaces/basicAuth.test.js` | Crear | Tests del hook puro |
| `src/bootstrap/bullBoard.js` | Modificar (`:6`, `:11-16`, `:34-44`) | Leer credenciales, fail closed, conectar el hook en el plugin encapsulado |
| `tests/unit/bullBoard.bootstrap.test.js` | Crear | Cableado real con `Fastify().inject` (junto a `tests/unit/appLifecycle.bootstrap.test.js`) |
| `README.md` | Modificar (`:330`, `:342-344`) | Documentar las variables y la protección real |
| `.env.example` | Modificar (después de `:34`) | Agregar las dos variables vacías en el bloque `# ─── Auth` |

---

### Task 1: Hook `createBasicAuthHook`

**Files:**
- Create: `src/interfaces/http/middlewares/basicAuth.js`
- Test: `tests/unit/interfaces/basicAuth.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `export function createBasicAuthHook({ username: string, password: string, realm: string }): (req, reply) => Promise<undefined | FastifyReply>`. Lanza `Error('Basic auth requires username and password')` si falta alguno. El hook devuelve `undefined` si las credenciales coinciden; si no, `reply.code(401).header('WWW-Authenticate', 'Basic realm="<realm>", charset="UTF-8"').send({ error: 'Unauthorized' })`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/interfaces/basicAuth.test.js`:

```js
import { jest } from '@jest/globals';
import { createBasicAuthHook } from '../../../src/interfaces/http/middlewares/basicAuth.js';

const USER = 'ops';
const PASSWORD = 'pa:ss-word';
const CHALLENGE = 'Basic realm="Bull Board", charset="UTF-8"';

function basic(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

function buildReply() {
  return {
    code: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

const hook = createBasicAuthHook({ username: USER, password: PASSWORD, realm: 'Bull Board' });

async function run(authorization) {
  const reply = buildReply();
  const headers = authorization === undefined ? {} : { authorization };
  const result = await hook({ headers }, reply);
  return { reply, result };
}

function expectChallenge(reply) {
  expect(reply.code).toHaveBeenCalledWith(401);
  expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', CHALLENGE);
  expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized' });
}

describe('createBasicAuthHook', () => {
  it('lets the request through with the right credentials', async () => {
    const { reply, result } = await run(basic(USER, PASSWORD));

    expect(result).toBeUndefined();
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('accepts a password that contains a colon by splitting on the first one', async () => {
    const { reply } = await run(basic(USER, PASSWORD));

    expect(PASSWORD).toContain(':');
    expect(reply.code).not.toHaveBeenCalled();
  });

  it.each([
    ['no Authorization header', undefined],
    ['another scheme', 'Bearer some-token'],
    ['a Basic header without credentials', 'Basic'],
    ['invalid base64 without a colon', 'Basic !!!'],
    ['the right user with a wrong password', basic(USER, 'wrong')],
    ['a wrong user with the right password', basic('intruder', PASSWORD)],
    ['empty user and password', basic('', '')],
  ])('challenges %s', async (_label, authorization) => {
    const { reply } = await run(authorization);

    expectChallenge(reply);
  });

  it('refuses to build a hook without credentials', () => {
    expect(() => createBasicAuthHook({ username: '', password: 'x', realm: 'Bull Board' }))
      .toThrow('Basic auth requires username and password');
    expect(() => createBasicAuthHook({ username: 'x', password: undefined, realm: 'Bull Board' }))
      .toThrow('Basic auth requires username and password');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/interfaces/basicAuth.test.js --testPathIgnorePatterns=worktrees`
Expected: FAIL — `Cannot find module '../../../src/interfaces/http/middlewares/basicAuth.js'`.

- [ ] **Step 3: Implementación mínima**

Crear `src/interfaces/http/middlewares/basicAuth.js`:

```js
import crypto from 'crypto';

// HTTP Basic para UIs que se abren en el navegador (Bull Board): el navegador no puede mandar
// headers propios como x-internal-key, pero sí muestra su diálogo de login ante un 401 con
// WWW-Authenticate y reenvía Authorization en cada request siguiente. Solo es seguro sobre HTTPS.

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// Comparar los SHA-256 deja ambos buffers del mismo largo, así timingSafeEqual no corta por
// longitud y no filtra cuánto mide la credencial esperada.
function safeEqual(actual, expected) {
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}

function parseBasicCredentials(header) {
  if (typeof header !== 'string') {
    return null;
  }

  const [scheme, encoded] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) {
    return null;
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  // Se corta en el PRIMER ':' porque la contraseña sí puede contener ':'.
  const separator = decoded.indexOf(':');
  if (separator < 0) {
    return null;
  }

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export function createBasicAuthHook({ username, password, realm }) {
  if (!username || !password) {
    throw new Error('Basic auth requires username and password');
  }

  const challenge = `Basic realm="${realm}", charset="UTF-8"`;

  return async function basicAuth(req, reply) {
    const credentials = parseBasicCredentials(req.headers?.authorization);

    // Se comparan los dos siempre, sin cortocircuito, para no revelar cuál de los dos falló.
    const usernameMatches = safeEqual(credentials?.username ?? '', username);
    const passwordMatches = safeEqual(credentials?.password ?? '', password);

    if (credentials && usernameMatches && passwordMatches) {
      return undefined;
    }

    return reply.code(401).header('WWW-Authenticate', challenge).send({ error: 'Unauthorized' });
  };
}

export default createBasicAuthHook;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/interfaces/basicAuth.test.js --testPathIgnorePatterns=worktrees`
Expected: PASS, `Tests: 10 passed, 10 total`.

- [ ] **Step 5: Sin commit**

No commitear (regla del usuario). Seguir con la Task 2.

---

### Task 2: Conectar el hook en Bull Board, fail closed y documentación

**Files:**
- Modify: `src/bootstrap/bullBoard.js:6` (import), `:11-16` (lectura de credenciales), `:34-44` (hook y log)
- Modify: `README.md:330`, `README.md:342-344`
- Modify: `.env.example` (después de `:34`)
- Test: `tests/unit/bullBoard.bootstrap.test.js`

**Interfaces:**
- Consumes: `createBasicAuthHook({ username, password, realm })` de la Task 1 (`src/interfaces/http/middlewares/basicAuth.js`).
- Produces: `registerBullBoard(app)` mantiene la firma y el export (`src/main/app.js:34` no cambia). Lee `process.env.BULL_BOARD_USER`/`BULL_BOARD_PASSWORD` **en cada llamada** (no al importar el módulo), igual que ya lee `BULL_BOARD_PATH` en `src/bootstrap/bullBoard.js:15`.

Estado actual de `src/bootstrap/bullBoard.js` (verificado):

```js
6:  import { internalKeyAuthOnly } from '#interfaces/http/middlewares/internalAuth.js';
...
11: export function registerBullBoard(app) {
12:   const sapSyncQueue = getSapSyncQueue();
13:   const webhookQueue = getWebhookQueue();
14:   const serverAdapter = new FastifyAdapter();
15:   const basePath = process.env.BULL_BOARD_PATH || DEFAULT_BULL_BOARD_PATH;
...
34:   app.register(async (instance) => {
35:     //instance.addHook('onRequest', internalKeyAuthOnly);
36:     instance.register(serverAdapter.registerPlugin(), {
37:       prefix: basePath,
38:     });
39:   });
40:
41:   logger.info({
42:     msg: 'Bull Board registered',
43:     basePath,
44:   });
```

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/bullBoard.bootstrap.test.js`:

```js
import { jest } from '@jest/globals';
import Fastify from 'fastify';

// Cableado real de Bull Board sobre Fastify con colas falsas: lo que se prueba es que el hook
// Basic cubre HTML, assets y API JSON de Bull Board, que no toca otras rutas, y que sin
// credenciales configuradas Bull Board no se registra.

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function fakeQueue(name) {
  return {
    name,
    getJobCounts: async () => ({}),
    getJobs: async () => [],
    isPaused: async () => false,
    client: Promise.resolve({ info: async () => '' }),
  };
}

jest.unstable_mockModule('../../src/infrastructure/queue/sapSync.queue.js', () => ({
  getSapSyncQueue: () => fakeQueue('sap-sync'),
}));

jest.unstable_mockModule('../../src/infrastructure/queue/webhook.queue.js', () => ({
  getWebhookQueue: () => fakeQueue('webhook-events'),
}));

jest.unstable_mockModule('../../src/infrastructure/logger/logger.js', () => ({
  default: mockLogger,
}));

const { registerBullBoard } = await import('../../src/bootstrap/bullBoard.js');

const USER = 'ops';
const PASSWORD = 'pa:ss-word';
const CHALLENGE = 'Basic realm="Bull Board", charset="UTF-8"';
const DISABLED_MSG = 'Bull Board disabled: BULL_BOARD_USER/BULL_BOARD_PASSWORD not set';

function basic(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

let app;

async function buildApp() {
  app = Fastify();
  registerBullBoard(app);
  app.get('/health', async () => ({ ok: true }));
  await app.ready();
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BULL_BOARD_USER = USER;
  process.env.BULL_BOARD_PASSWORD = PASSWORD;
  delete process.env.BULL_BOARD_PATH;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

afterAll(() => {
  delete process.env.BULL_BOARD_USER;
  delete process.env.BULL_BOARD_PASSWORD;
});

describe('registerBullBoard with HTTP Basic auth', () => {
  it.each([
    ['the UI', '/admin/queues'],
    ['the JSON API', '/admin/queues/api/queues'],
  ])('challenges %s without credentials', async (_label, url) => {
    await buildApp();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
  });

  it('challenges a wrong password', async () => {
    await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/queues',
      headers: { authorization: basic(USER, 'wrong') },
    });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['the UI', '/admin/queues'],
    ['the JSON API', '/admin/queues/api/queues'],
  ])('serves %s with valid credentials', async (_label, url) => {
    await buildApp();

    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: basic(USER, PASSWORD) },
    });

    expect(response.statusCode).toBe(200);
  });

  it('protects the static assets the UI loads', async () => {
    await buildApp();
    const ui = await app.inject({
      method: 'GET',
      url: '/admin/queues',
      headers: { authorization: basic(USER, PASSWORD) },
    });
    const assetPath = ui.body.match(/(?:src|href)="(static\/[^"]+\.(?:js|css))"/)[1];

    const response = await app.inject({ method: 'GET', url: `/admin/queues/${assetPath}` });

    expect(response.statusCode).toBe(401);
  });

  it('leaves routes outside Bull Board alone', async () => {
    await buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['BULL_BOARD_USER', 'BULL_BOARD_USER'],
    ['BULL_BOARD_PASSWORD', 'BULL_BOARD_PASSWORD'],
  ])('stays unregistered and warns when %s is missing', async (_label, variable) => {
    delete process.env[variable];
    await buildApp();

    const response = await app.inject({ method: 'GET', url: '/admin/queues' });

    expect(response.statusCode).toBe(404);
    expect(mockLogger.warn).toHaveBeenCalledWith({ msg: DISABLED_MSG });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/bullBoard.bootstrap.test.js --testPathIgnorePatterns=worktrees`
Expected: FAIL. Con el código actual Bull Board queda abierto: los casos "challenges …" reciben `200` en vez de `401`, "protects the static assets" recibe `200`, y "stays unregistered …" recibe `200` en vez de `404` y `mockLogger.warn` no se llama. Los casos "serves … with valid credentials" y "leaves routes outside Bull Board alone" pasan desde ya (son regresión). Si falla por otra causa (módulo no encontrado, error de import), corregir el test antes de seguir.

- [ ] **Step 3: Implementación en `src/bootstrap/bullBoard.js`**

Reemplazar el contenido completo del archivo por:

```js
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { FastifyAdapter } from '@bull-board/fastify';
import { getSapSyncQueue } from '#infrastructure/queue/sapSync.queue.js';
import { getWebhookQueue } from '#infrastructure/queue/webhook.queue.js';
import { createBasicAuthHook } from '#interfaces/http/middlewares/basicAuth.js';
import logger from '#infrastructure/logger/logger.js';

const DEFAULT_BULL_BOARD_PATH = '/admin/queues';

export function registerBullBoard(app) {
  // Fail closed: sin credenciales configuradas Bull Board no se registra (404), en vez de
  // quedar abierto. Antes estaba expuesto sin auth porque x-internal-key no sirve para una UI
  // de navegador; ver docs/superpowers/specs/2026-10-12-bull-board-basic-auth-design.md.
  const username = process.env.BULL_BOARD_USER;
  const password = process.env.BULL_BOARD_PASSWORD;
  if (!username || !password) {
    logger.warn({ msg: 'Bull Board disabled: BULL_BOARD_USER/BULL_BOARD_PASSWORD not set' });
    return;
  }

  const sapSyncQueue = getSapSyncQueue();
  const webhookQueue = getWebhookQueue();
  const serverAdapter = new FastifyAdapter();
  const basePath = process.env.BULL_BOARD_PATH || DEFAULT_BULL_BOARD_PATH;
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: [
      new BullMQAdapter(sapSyncQueue, {
        readOnlyMode: true,
        description: 'Managed by BullMQ schedulers and internal SAP sync admin APIs.',
      }),
      new BullMQAdapter(webhookQueue),
    ],
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: 'SAP Sync Queues',
      },
    },
  });

  // El hook vive en este plugin encapsulado: cubre HTML, assets y la API JSON de Bull Board
  // y ninguna otra ruta del servidor.
  app.register(async (instance) => {
    instance.addHook('onRequest', createBasicAuthHook({ username, password, realm: 'Bull Board' }));
    instance.register(serverAdapter.registerPlugin(), {
      prefix: basePath,
    });
  });

  logger.info({
    msg: 'Bull Board registered',
    basePath,
    auth: 'basic',
  });
}
```

Diferencias contra el original: se elimina el import de `internalKeyAuthOnly` (`:6`) y la línea comentada (`:35`); se agrega el chequeo de credenciales antes de crear las colas; el hook Basic reemplaza al comentario; el log suma `auth: 'basic'`. Las colas, el adapter de webhooks sin `readOnlyMode` y `BULL_BOARD_PATH` quedan igual.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/bullBoard.bootstrap.test.js tests/unit/interfaces/basicAuth.test.js tests/unit/appLifecycle.bootstrap.test.js --testPathIgnorePatterns=worktrees`
Expected: PASS en las tres suites (`bullBoard.bootstrap`: 9 tests; `basicAuth`: 10 tests; `appLifecycle.bootstrap` sin cambios).

- [ ] **Step 5: Documentar en `README.md`**

Primero las líneas `342-344` (para que el insert de la línea 330 no las corra). Reemplazar exactamente:

```markdown
### Bull Board
- Ruta: `/admin/queues`
- Protección: header `x-internal-key` (usa la misma clave interna del proyecto).
```

por:

```markdown
### Bull Board
- Ruta: `/admin/queues`
- Protección: HTTP Basic Auth. El navegador pide usuario y contraseña (`BULL_BOARD_USER` / `BULL_BOARD_PASSWORD`). No usa `x-internal-key`: un navegador no puede mandar ese header.
- Si falta alguna de las dos variables, Bull Board no se registra (`404`) y la API loguea `Bull Board disabled: BULL_BOARD_USER/BULL_BOARD_PASSWORD not set` al arrancar.
- Solo es seguro sobre HTTPS: Basic Auth manda las credenciales en base64, no cifradas.
```

Después, en la lista de variables, debajo de la línea `README.md:330` (``- `BULL_BOARD_PATH` (default `/admin/queues`)``) agregar:

```markdown
- `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` (obligatorias para usar Bull Board; si falta alguna, `/admin/queues` no se registra)
```

- [ ] **Step 6: Agregar las variables a `.env.example`**

En el bloque `# ─── Auth` (`.env.example:32-34`), debajo de `JWT_SECRET=test` (`.env.example:34`), agregar:

```
BULL_BOARD_USER=
BULL_BOARD_PASSWORD=
```

- [ ] **Step 7: Verificar la suite completa contra la baseline**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=worktrees 2>&1 | grep -E "^FAIL|^Tests:|^Test Suites:" | sort -u`
Expected: `Test Suites: 5 failed, 208 passed, 213 total` y `Tests: 10 failed, …`. Las 5 rojas deben ser exactamente las de la baseline (ver Global Constraints). Si `internalTenant.test.js` falla, correrlo solo para confirmar que pasa aislado (4/4); falla en la corrida completa por carga paralela.

- [ ] **Step 8: Sin commit — dejar el resumen**

No commitear. Dejar en el chat: archivos creados (`src/interfaces/http/middlewares/basicAuth.js`, `tests/unit/interfaces/basicAuth.test.js`, `tests/unit/bullBoard.bootstrap.test.js`), modificados (`src/bootstrap/bullBoard.js`, `README.md`, `.env.example`), por qué (Bull Board expuesto sin auth y con la cola de webhooks operable; el guard estaba comentado porque `x-internal-key` no sirve en un navegador), y los pasos de despliegue del spec:

1. Antes del deploy, agregar `BULL_BOARD_USER` y `BULL_BOARD_PASSWORD` al `.env` del servidor (contraseña: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`). Sin ellas, Bull Board queda en `404`.
2. Desplegar y reiniciar la API.
3. Abrir `/admin/queues`: debe aparecer el login del navegador y, con las credenciales, la UI igual que antes.
4. Confirmar en logs que webhooks y syncs siguen igual.

---

## Self-review contra el spec

| Requisito del spec | Dónde se cumple |
|---|---|
| Basic Auth con `WWW-Authenticate: Basic realm="Bull Board", charset="UTF-8"` | Task 1, Step 3; probado en Task 1 Step 1 y Task 2 Step 1 |
| Credenciales `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD`, no `INTERNAL_KEY` | Task 2, Step 3 |
| Fail closed (no registrar + `warn`) | Task 2, Step 3; probado en "stays unregistered…" |
| `timingSafeEqual` sobre SHA-256, sin cortocircuito | Task 1, Step 3 |
| Split en el primer `:`; header ausente / otro esquema / base64 inválido → 401 | Task 1, Steps 1 y 3 |
| El hook cubre HTML, assets y API, y ninguna otra ruta | Task 2, Step 1 (UI, API, assets, `/health`) |
| Hook reutilizable en `src/interfaces/http/middlewares/basicAuth.js` | Task 1 |
| Cola de webhooks escribible | Task 2, Step 3 (sin `readOnlyMode` en el adapter de webhooks) |
| Eliminar import sin uso (`:6`) y línea comentada (`:35`) | Task 2, Step 3 |
| README `:330` y `:342-344`, `.env.example` | Task 2, Steps 5 y 6 |
| `src/main/app.js:34` sin cambios; `routeAuthWiring.test.js` sin cambios | Task 2, Interfaces (firma de `registerBullBoard` igual) |
| Verificación contra baseline | Task 2, Step 7 |
