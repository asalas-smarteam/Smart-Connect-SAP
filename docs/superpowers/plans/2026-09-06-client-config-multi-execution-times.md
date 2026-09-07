# Múltiples horas de ejecución por ClientConfig — Plan de implementación

> **Para quien ejecute esto:** los pasos usan checkbox (`- [ ]`). Cada tarea termina en un punto de
> corte con el árbol en verde.

**Spec:** `docs/superpowers/specs/2026-09-06-client-config-multi-execution-times-design.md`

**Goal:** que `executionTime` de una ClientConfig sea un array de horas `HH:mm` y que BullMQ registre
un job scheduler por cada hora, para que una misma tarea corra N veces al día.

**Architecture:** un normalizador puro en `src/domain/sync/execution-times.js` es la única fuente de
verdad sobre el formato. El schema lo usa para validar; el scheduler lo usa para leer (tolerando el
string crudo que devuelve `.lean()`); `resolveSchedulePlan` pasa de devolver un `repeatPattern`
suelto a devolver `slots[]`, y cada slot se registra en BullMQ con el nombre
`sap-sync:<tenantKey>:<configId>:<índice>`. El borrado enumera una lista fija de nombres (`:0`…`:23`)
en vez de derivarla del estado anterior.

**Tech Stack:** Node ESM, Mongoose 8.21, BullMQ (`upsertJobScheduler`), Fastify, Jest 30 con
`unstable_mockModule`.

## Global Constraints

- **No commitear.** El dueño del repo hace `git add`/`commit`/`push`. Cada tarea trae un mensaje de
  commit **sugerido**, para que él lo use; no ejecutar git más allá de `status`/`diff`.
- **Trabajar en el checkout principal**, `C:\Users\ale_1\OneDrive\Escritorio\Proyectos\SAP`, rama
  `main`. Nada de ramas ni worktrees.
- **Comando de tests** (`npm test` no funciona en Windows: npm lanza `cmd.exe`, que no entiende el
  prefijo `VAR=valor`). Desde Git Bash:
  ```
  NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]'
  ```
  Las dos opciones van **con `=`**: sin el `=`, yargs se traga la ruta siguiente como otro patrón y
  corre las 977 suites de los worktrees en silencio.
- **Baseline de la suite en `main`: 178 suites, 5 rojas / 10 tests.** Son
  `tests/integration/internalTenant.test.js`,
  `tests/unit/application/sendMappedItemsToHubspot.test.js`,
  `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js` y
  `tests/unit/serviceLayerService.test.js`. "Verde" significa esas cinco y sólo esas cinco.
- `MAX_EXECUTION_TIMES = 24`. Es una sola constante y es *load-bearing*: define además el rango de
  nombres que se enumeran al borrar.
- Todo mensaje de error de validación debe contener la subcadena `executionTime`, porque
  `isConfigValidationError` (`src/application/use-cases/ManageClientConfigs.js:33`) y el handler del
  master (`src/interfaces/http/controllers/master/masterClientConfig.controller.js:4`) lo matchean
  por regex para devolver 400 en vez de 500.
- Timezone de los cron: `America/Costa_Rica` (constante `SAP_SYNC_SCHEDULER_TIMEZONE` ya existente).

## Estructura de archivos

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/domain/sync/execution-times.js` | Normalizar/validar horas. Puro, sin imports. | Crear |
| `tests/unit/domain/executionTimes.test.js` | Tabla de reglas del normalizador. | Crear |
| `src/infrastructure/database/models/tenant/ClientConfig.js` | `executionTime: [String]` + validador. | Modificar |
| `tests/unit/clientConfigSchema.test.js` | Validación del path a nivel schema. | Crear |
| `src/infrastructure/queue/sapSync.queue.js` | Nombre del scheduler con `slotIndex`. | Modificar |
| `tests/unit/sapSyncQueue.test.js` | Nombre con y sin `slotIndex`. | Modificar |
| `src/infrastructure/scheduler/sapSyncScheduler.service.js` | `slots[]`, alta N, borrado fijo, bootstrap. | Modificar |
| `tests/unit/sapSyncScheduler.service.test.js` | Multihora, baja de slots, legacy, bootstrap. | Modificar |
| `src/infrastructure/scheduler/sapSyncQueueAdmin.service.js` | `serializeConfig` devuelve array. | Modificar |
| `src/infrastructure/config/masterClientConfig.service.js` | Sanitizar y requerir array. | Modificar |
| `src/infrastructure/tenants/replicateMasterClientConfigs.js` | Normalizar al replicar. | Modificar |
| `src/infrastructure/database/seeds/masterClientConfigs.seed.js` | Semillas a array. | Modificar |
| `scripts/migrate-client-config-execution-times.mjs` | Migración por base, dry run por defecto. | Crear |

---

### Task 1: Normalizador de horas en el dominio

**Files:**
- Create: `src/domain/sync/execution-times.js`
- Test: `tests/unit/domain/executionTimes.test.js`

**Interfaces:**
- Consumes: nada. Módulo puro, sin imports.
- Produces:
  - `normalizeExecutionTimes(value: unknown) => string[]` — lanza `Error` si algo no es `HH:mm` o si
    hay más de `MAX_EXECUTION_TIMES` horas **distintas**.
  - `MAX_EXECUTION_TIMES: number` (24)
  - `EXECUTION_TIME_PATTERN: RegExp`

- [ ] **Paso 1: escribir el test que falla**

Crear `tests/unit/domain/executionTimes.test.js`:

```js
import {
  EXECUTION_TIME_PATTERN,
  MAX_EXECUTION_TIMES,
  normalizeExecutionTimes,
} from '../../../src/domain/sync/execution-times.js';

describe('normalizeExecutionTimes', () => {
  it('treats empty values as no schedule', () => {
    expect(normalizeExecutionTimes(null)).toEqual([]);
    expect(normalizeExecutionTimes(undefined)).toEqual([]);
    expect(normalizeExecutionTimes('')).toEqual([]);
    expect(normalizeExecutionTimes([])).toEqual([]);
    expect(normalizeExecutionTimes([''])).toEqual([]);
  });

  it('wraps a single string, the shape stored before this change', () => {
    expect(normalizeExecutionTimes('07:00')).toEqual(['07:00']);
  });

  it('trims, deduplicates and sorts ascending', () => {
    expect(normalizeExecutionTimes([' 12:00 ', '07:00', '12:00'])).toEqual(['07:00', '12:00']);
  });

  it('keeps midnight and end-of-day boundaries', () => {
    expect(normalizeExecutionTimes(['23:59', '00:00'])).toEqual(['00:00', '23:59']);
  });

  it('rejects anything that is not zero-padded HH:mm', () => {
    expect(() => normalizeExecutionTimes(['7:00'])).toThrow(/executionTime/);
    expect(() => normalizeExecutionTimes(['24:00'])).toThrow(/executionTime/);
    expect(() => normalizeExecutionTimes(['07:60'])).toThrow(/executionTime/);
    expect(() => normalizeExecutionTimes(['07:00:00'])).toThrow(/executionTime/);
  });

  it('rejects more distinct times than the cap', () => {
    const tooMany = Array.from(
      { length: MAX_EXECUTION_TIMES + 1 },
      (unused, index) => `${String(index).padStart(2, '0')}:0${index % 2}`
    );

    expect(() => normalizeExecutionTimes(tooMany)).toThrow(/executionTime/);
  });

  it('counts distinct times against the cap, not repeated ones', () => {
    const repeated = Array.from({ length: MAX_EXECUTION_TIMES + 5 }, () => '07:00');

    expect(normalizeExecutionTimes(repeated)).toEqual(['07:00']);
  });

  it('exposes the pattern used everywhere else', () => {
    expect(EXECUTION_TIME_PATTERN.test('00:00')).toBe(true);
    expect(EXECUTION_TIME_PATTERN.test('23:59')).toBe(true);
    expect(EXECUTION_TIME_PATTERN.test('24:00')).toBe(false);
  });
});
```

- [ ] **Paso 2: correr el test y ver que falla**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='executionTimes'
```

Esperado: FAIL, `Cannot find module '../../../src/domain/sync/execution-times.js'`.

- [ ] **Paso 3: implementar**

Crear `src/domain/sync/execution-times.js`:

```js
// Única fuente de verdad sobre el formato de las horas de ejecución de una ClientConfig.
// Puro y sin imports a propósito: lo consumen el schema de Mongoose, el scheduler de BullMQ, el
// servicio del master y el script de migración, y ninguno debe arrastrar el grafo de módulos de
// otro.
//
// El orden ascendente y la deduplicación NO son cosmética: el nombre del job scheduler de BullMQ se
// deriva del índice dentro del array, así que un array desordenado o con repetidos produciría
// nombres distintos para la misma configuración.
export const EXECUTION_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// El tope acota además el rango de nombres que se enumeran al borrar schedulers
// (ver buildRemovalKeyCandidates en sapSyncScheduler.service.js). Si sube este número, sube esa
// enumeración con él.
export const MAX_EXECUTION_TIMES = 24;

export function normalizeExecutionTimes(value) {
  if (value === null || value === undefined || value === '') {
    return [];
  }

  const entries = Array.isArray(value) ? value : [value];
  const times = [];

  for (const entry of entries) {
    const time = String(entry ?? '').trim();

    if (!time) {
      continue;
    }

    if (!EXECUTION_TIME_PATTERN.test(time)) {
      throw new Error('executionTime must use HH:mm format');
    }

    if (!times.includes(time)) {
      times.push(time);
    }
  }

  if (times.length > MAX_EXECUTION_TIMES) {
    throw new Error(`executionTime cannot have more than ${MAX_EXECUTION_TIMES} entries`);
  }

  // 'HH:mm' con cero a la izquierda ordena lexicográficamente igual que cronológicamente.
  return times.sort();
}
```

- [ ] **Paso 4: correr el test y ver que pasa**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='executionTimes'
```

Esperado: PASS, 8 tests.

- [ ] **Paso 5: punto de corte**

Mensaje de commit sugerido:

```
feat: add executionTimes domain normalizer for multi-hour schedules
```

---

### Task 2: `executionTime` pasa a `[String]` en el schema

**Files:**
- Modify: `src/infrastructure/database/models/tenant/ClientConfig.js:1-10` (imports) y `:116-125`
  (path `executionTime`)
- Test: `tests/unit/clientConfigSchema.test.js` (crear)

**Interfaces:**
- Consumes: `MAX_EXECUTION_TIMES`, `EXECUTION_TIME_PATTERN` de la Task 1.
- Produces: `clientConfigSchema` con `executionTime` de tipo `[String]`. El schema del master
  (`src/infrastructure/database/models/master/ClientConfig.js:6`) es `clientConfigSchema.clone()` y
  hereda el cambio sin tocarlo.

- [ ] **Paso 1: escribir el test que falla**

Crear `tests/unit/clientConfigSchema.test.js`:

```js
import mongoose from 'mongoose';
import { clientConfigSchema } from '../../src/infrastructure/database/models/tenant/ClientConfig.js';

const ClientConfigTestModel = mongoose.model('ClientConfigSchemaTest', clientConfigSchema.clone());

function build(overrides) {
  return new ClientConfigTestModel({ mode: 'FULL', ...overrides });
}

describe('clientConfigSchema.executionTime', () => {
  it('accepts an array of times', () => {
    const doc = build({ executionTime: ['07:00', '12:00', '15:00'] });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.executionTime).toEqual(['07:00', '12:00', '15:00']);
  });

  it('wraps a bare string, the shape stored before this change', () => {
    const doc = build({ executionTime: '07:00' });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.executionTime).toEqual(['07:00']);
  });

  it('hydrates a document stored with a bare string without casting errors', () => {
    const doc = ClientConfigTestModel.hydrate({ mode: 'FULL', executionTime: '01:00' });

    expect(doc.executionTime).toEqual(['01:00']);
  });

  it('defaults to an empty array', () => {
    expect(build({}).executionTime).toEqual([]);
  });

  it('rejects a badly formatted time with a message naming the field', () => {
    const error = build({ executionTime: ['7:00'] }).validateSync();

    expect(error.errors.executionTime.message).toMatch(/executionTime/);
  });

  it('rejects more times than the cap', () => {
    const tooMany = Array.from(
      { length: 25 },
      (unused, index) => `${String(index % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
    );
    const error = build({ executionTime: tooMany }).validateSync();

    expect(error.errors.executionTime.message).toMatch(/executionTime/);
  });
});
```

- [ ] **Paso 2: correr el test y ver que falla**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='clientConfigSchema'
```

Esperado: FAIL en `accepts an array of times` — hoy el path es `String` y castea el array a la cadena
`"07:00,12:00,15:00"`, que no matchea el validador.

- [ ] **Paso 3: implementar**

En `src/infrastructure/database/models/tenant/ClientConfig.js`, agregar el import junto a los que ya
existen (el archivo ya importa de `#domain/sync/dropdown-options.constants.js`, así que el alias
`#domain` está disponible):

```js
import {
  EXECUTION_TIME_PATTERN,
  MAX_EXECUTION_TIMES,
} from '#domain/sync/execution-times.js';
```

Reemplazar el path `executionTime` (hoy en `:116-125`) por:

```js
    // Array de horas 'HH:mm'. Antes era un String único; Mongoose envuelve solo un escalar tanto al
    // asignar como al hidratar, así que los documentos viejos que guardan "01:00" se siguen leyendo
    // como ['01:00'] sin migrar. Ojo: .lean() NO castea, ahí llega el string crudo -- por eso el
    // scheduler normaliza al leer.
    executionTime: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          if (value === null || value === undefined) {
            return true;
          }

          if (!Array.isArray(value) || value.length > MAX_EXECUTION_TIMES) {
            return false;
          }

          return value.every((entry) => EXECUTION_TIME_PATTERN.test(String(entry ?? '').trim()));
        },
        message: `executionTime must use HH:mm format and have at most ${MAX_EXECUTION_TIMES} entries`,
      },
    },
```

No tocar `startTime`/`endTime`: siguen siendo `String` con el `TIME_PATTERN` local.

- [ ] **Paso 4: correr el test y ver que pasa**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='clientConfigSchema'
```

Esperado: PASS, 6 tests.

- [ ] **Paso 5: punto de corte**

```
feat: store ClientConfig executionTime as an array of times
```

---

### Task 3: nombre del job scheduler con `slotIndex`

**Files:**
- Modify: `src/infrastructure/queue/sapSync.queue.js:14-16` (`buildScheduledJobId`) y `:98-135`
  (`buildScheduledSapSyncJobTemplate`)
- Test: `tests/unit/sapSyncQueue.test.js`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `buildScheduledJobId({ tenantKey, configId, slotIndex? }) => string`. Sin `slotIndex` (o con
    `null`) devuelve `sap-sync:<tenantKey>:<configId>`, exactamente el nombre de hoy. Con un entero
    devuelve `sap-sync:<tenantKey>:<configId>:<slotIndex>`.
  - `buildScheduledSapSyncJobTemplate({ ..., slotIndex })` propaga `slotIndex` al `schedulerId`.
  - `addScheduledSapSyncJob(schedule)` acepta `slotIndex` dentro de `schedule`.

- [ ] **Paso 1: escribir el test que falla**

Agregar `buildScheduledJobId` a la lista de imports del `await import(...)` que ya está arriba de
`tests/unit/sapSyncQueue.test.js`, y agregar estos tests dentro del `describe('sapSync.queue', ...)`:

```js
  it('keeps the flat scheduler id when there is no slot index', () => {
    expect(buildScheduledJobId({ tenantKey: 'tenant-a', configId: 'cfg-1' }))
      .toBe('sap-sync:tenant-a:cfg-1');
    expect(buildScheduledJobId({ tenantKey: 'tenant-a', configId: 'cfg-1', slotIndex: null }))
      .toBe('sap-sync:tenant-a:cfg-1');
  });

  it('suffixes the scheduler id with the slot index', () => {
    expect(buildScheduledJobId({ tenantKey: 'tenant-a', configId: 'cfg-1', slotIndex: 0 }))
      .toBe('sap-sync:tenant-a:cfg-1:0');
    expect(buildScheduledJobId({ tenantKey: 'tenant-a', configId: 'cfg-1', slotIndex: 2 }))
      .toBe('sap-sync:tenant-a:cfg-1:2');
  });

  it('registers each hour of a multi-hour FULL schedule under its own scheduler id', async () => {
    mockUpsertJobScheduler.mockResolvedValue({ id: 'scheduled-job' });

    await addScheduledSapSyncJob({
      tenantKey: 'printer',
      configId: 'cfg-multi',
      objectType: 'product',
      mode: 'FULL',
      executionTime: '12:00',
      executionDays: ['Monday'],
      slotIndex: 1,
      repeatPattern: '0 12 * * 1',
      repeatTimezone: 'America/Costa_Rica',
    });

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'sap-sync:printer:cfg-multi:1',
      { pattern: '0 12 * * 1', tz: 'America/Costa_Rica' },
      {
        name: SAP_SYNC_JOB_NAME,
        data: expect.objectContaining({
          tenantKey: 'printer',
          configId: 'cfg-multi',
          executionTime: '12:00',
          triggerType: 'scheduled',
        }),
      }
    );
  });
```

- [ ] **Paso 2: correr el test y ver que falla**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncQueue'
```

Esperado: FAIL en los dos últimos — el id sale `sap-sync:tenant-a:cfg-1` y
`sap-sync:printer:cfg-multi`, sin sufijo.

- [ ] **Paso 3: implementar**

En `src/infrastructure/queue/sapSync.queue.js`, reemplazar `buildScheduledJobId`:

```js
// slotIndex identifica cada hora de una config FULL multihora. Sin slotIndex el nombre queda igual
// que antes de multihora, y así lo siguen usando las configs INCREMENTAL.
export function buildScheduledJobId({ tenantKey, configId, slotIndex = null }) {
  const base = `sap-sync:${tenantKey}:${String(configId)}`;
  return Number.isInteger(slotIndex) ? `${base}:${slotIndex}` : base;
}
```

En `buildScheduledSapSyncJobTemplate`, agregar `slotIndex` a los parámetros desestructurados (justo
después de `configId`) y pasarlo al id:

```js
  const schedulerId = buildScheduledJobId({ tenantKey, configId, slotIndex });
```

`buildSapSyncPayload` no cambia: `slotIndex` no viaja en el payload del job, sólo en el nombre. El
job ya lleva su propia hora en `executionTime`.

- [ ] **Paso 4: correr el test y ver que pasa**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncQueue'
```

Esperado: PASS, 5 tests. Los dos tests que ya existían siguen verdes porque no pasan `slotIndex`.

- [ ] **Paso 5: punto de corte**

```
feat: name BullMQ sap-sync schedulers per execution slot
```

---

### Task 4: `resolveSchedulePlan` devuelve `slots[]` y se registra uno por hora

**Files:**
- Modify: `src/infrastructure/scheduler/sapSyncScheduler.service.js` — imports, `buildDailyPattern`
  (`:101`), `resolveSchedulePlan` (`:172`), `createScheduledJob` (`:340`), log de
  `registerScheduledJob` (`:407`)
- Test: `tests/unit/sapSyncScheduler.service.test.js`

**Interfaces:**
- Consumes: `normalizeExecutionTimes` (Task 1), `buildScheduledJobId` con `slotIndex` (Task 3).
- Produces: `resolveSchedulePlan(config)` devuelve `null` o
  ```
  {
    mode: 'FULL' | 'INCREMENTAL',
    intervalMinutes: number | null,
    executionTimes: string[],
    executionDays: string[],
    startTime: string | null,
    endTime: string | null,
    slots: [{ slotIndex: number | null, executionTime: string | null,
              repeatEvery: number | null, repeatPattern: string | null,
              repeatTimezone: string | null }]
  }
  ```
  Las tareas 5 y 6 dependen de `slots` y de `executionTimes`.

- [ ] **Paso 1: escribir el test que falla**

En `tests/unit/sapSyncScheduler.service.test.js`, primero **actualizar el mock** de
`buildScheduledJobId` en el bloque `jest.unstable_mockModule` de arriba del archivo, que hoy ignora
el slot:

```js
jest.unstable_mockModule('../../src/infrastructure/queue/sapSync.queue.js', () => ({
  SAP_SYNC_JOB_NAME: 'sap-sync-job',
  addScheduledSapSyncJob: mockAddScheduledSapSyncJob,
  buildScheduledJobId: ({ tenantKey, configId, slotIndex = null }) => (
    Number.isInteger(slotIndex)
      ? `sap-sync:${tenantKey}:${String(configId)}:${slotIndex}`
      : `sap-sync:${tenantKey}:${String(configId)}`
  ),
  getSapSyncQueue: mockGetSapSyncQueue,
}));
```

Luego agregar estos tests dentro del `describe`:

```js
  it('registers one scheduler per hour for a multi-hour FULL config', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    const config = {
      _id: 'cfg-printer',
      active: true,
      mode: 'FULL',
      executionTime: ['15:00', '07:00', '12:00'],
      executionDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      objectType: 'product',
    };

    const result = await syncScheduledJob({ tenantKey: 'printer', config });

    expect(result).toEqual({ action: 'registered' });
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledTimes(3);

    const calls = mockAddScheduledSapSyncJob.mock.calls.map(([schedule]) => ({
      slotIndex: schedule.slotIndex,
      executionTime: schedule.executionTime,
      repeatPattern: schedule.repeatPattern,
      repeatTimezone: schedule.repeatTimezone,
    }));

    expect(calls).toEqual([
      { slotIndex: 0, executionTime: '07:00', repeatPattern: '0 7 * * 1,2,3,4,5,6', repeatTimezone: 'America/Costa_Rica' },
      { slotIndex: 1, executionTime: '12:00', repeatPattern: '0 12 * * 1,2,3,4,5,6', repeatTimezone: 'America/Costa_Rica' },
      { slotIndex: 2, executionTime: '15:00', repeatPattern: '0 15 * * 1,2,3,4,5,6', repeatTimezone: 'America/Costa_Rica' },
    ]);
  });

  it('schedules a legacy string executionTime as slot 0', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    const config = {
      _id: 'cfg-legacy',
      active: true,
      mode: 'FULL',
      executionTime: '05:00',
      objectType: 'Items',
    };

    await syncScheduledJob({ tenantKey: 'tenant-legacy', config });

    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledTimes(1);
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      slotIndex: 0,
      executionTime: '05:00',
      repeatPattern: '0 5 * * *',
    }));
  });

  it('removes the job when a FULL config has no valid execution times', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);

    const config = {
      _id: 'cfg-empty',
      active: true,
      mode: 'FULL',
      executionTime: [],
      objectType: 'Items',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-empty', config });

    expect(result).toEqual({ action: 'removed' });
    expect(mockAddScheduledSapSyncJob).not.toHaveBeenCalled();
  });

  it('logs and skips scheduling when executionTime holds garbage', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);

    const config = {
      _id: 'cfg-garbage',
      active: true,
      mode: 'FULL',
      executionTime: ['not-a-time'],
      objectType: 'Items',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-garbage', config });

    expect(result).toEqual({ action: 'removed' });
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Invalid executionTime on ClientConfig, schedule skipped',
    }));
  });
```

- [ ] **Paso 2: correr el test y ver que falla**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncScheduler'
```

Esperado: FAIL. `registers one scheduler per hour` recibe 0 llamadas porque
`String(['15:00','07:00','12:00'])` no matchea `parseTime` y el plan sale `null`. Ese es exactamente
el modo de fallo silencioso que describe el spec.

- [ ] **Paso 3: implementar**

En `src/infrastructure/scheduler/sapSyncScheduler.service.js`:

**3a.** Agregar el import junto a los que ya están arriba:

```js
import { normalizeExecutionTimes } from '#domain/sync/execution-times.js';
```

**3b.** Reemplazar `buildDailyPattern` (`:101-111`) por su versión plural y agregar el lector
tolerante:

```js
// Lee executionTime de un documento que puede venir de tres formas: array (lo normal a partir de
// ahora), string suelto (documentos anteriores a la migración, y también cualquier lectura hecha con
// .lean(), que NO pasa por el casteo de Mongoose) o null.
// No propaga la excepción a propósito: un documento con basura debe dejar esa config sin programar y
// con un log visible, no tumbar el bootstrap del resto del tenant.
function readExecutionTimes(config) {
  try {
    return normalizeExecutionTimes(config?.executionTime);
  } catch (error) {
    logger.error({
      msg: 'Invalid executionTime on ClientConfig, schedule skipped',
      configId: String(config?._id || config?.id || ''),
      executionTime: config?.executionTime,
      error: error.message,
    });
    return [];
  }
}

function buildDailyPatterns({ executionTimes, executionDays }) {
  const days = normalizeExecutionDays(executionDays);
  if (days === null || !executionTimes.length) {
    return null;
  }

  const dayPattern = days.length ? days.join(',') : '*';
  const patterns = [];

  for (const value of executionTimes) {
    const time = parseTime(value);
    if (!time) {
      return null;
    }

    patterns.push({
      executionTime: time.value,
      repeatPattern: `${time.minutes} ${time.hours} * * ${dayPattern}`,
    });
  }

  return patterns;
}
```

**3c.** Reemplazar el cuerpo de `resolveSchedulePlan` (`:172-231`) por:

```js
function resolveSchedulePlan(config) {
  const mode = normalizeMode(config?.mode);
  const intervalMinutes = normalizeIntervalMinutes(config?.intervalMinutes);
  const executionTimes = readExecutionTimes(config);
  const executionDayNames = normalizeExecutionDayNames(config?.executionDays);
  const startTime = String(config?.startTime || '').trim() || null;
  const endTime = String(config?.endTime || '').trim() || null;

  if (mode === 'FULL') {
    const patterns = buildDailyPatterns({ executionTimes, executionDays: config?.executionDays });
    if (!patterns) {
      return null;
    }

    return {
      mode,
      intervalMinutes: null,
      executionTimes,
      executionDays: executionDayNames || [],
      startTime: null,
      endTime: null,
      slots: patterns.map((pattern, slotIndex) => ({
        slotIndex,
        executionTime: pattern.executionTime,
        repeatEvery: null,
        repeatPattern: pattern.repeatPattern,
        repeatTimezone: SAP_SYNC_SCHEDULER_TIMEZONE,
      })),
    };
  }

  if (!intervalMinutes) {
    return null;
  }

  const windowPattern = buildIncrementalWindowPattern({ intervalMinutes, startTime, endTime });
  if (startTime || endTime) {
    if (!windowPattern) {
      return null;
    }

    return {
      mode,
      intervalMinutes,
      executionTimes: [],
      executionDays: [],
      startTime: windowPattern.startTime,
      endTime: windowPattern.endTime,
      slots: [{
        slotIndex: null,
        executionTime: null,
        repeatEvery: null,
        repeatPattern: windowPattern.repeatPattern,
        repeatTimezone: SAP_SYNC_SCHEDULER_TIMEZONE,
      }],
    };
  }

  return {
    mode,
    intervalMinutes,
    executionTimes: [],
    executionDays: [],
    startTime: null,
    endTime: null,
    slots: [{
      slotIndex: null,
      executionTime: null,
      repeatEvery: intervalMinutes * 60 * 1000,
      repeatPattern: null,
      repeatTimezone: null,
    }],
  };
}
```

**3d.** Reemplazar `createScheduledJob` (`:340-370`) por:

```js
async function createScheduledJob({ tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  const schedulePlan = resolveSchedulePlan(config);
  const objectType = config?.objectType || null;

  if (!tenantKey || !configId || !schedulePlan) {
    throw new Error('tenantKey, configId and valid schedule config are required');
  }

  for (const slot of schedulePlan.slots) {
    await addScheduledSapSyncJob({
      tenantKey,
      configId,
      objectType,
      mode: schedulePlan.mode,
      intervalMinutes: schedulePlan.intervalMinutes,
      executionTime: slot.executionTime,
      executionDays: schedulePlan.executionDays,
      startTime: schedulePlan.startTime,
      endTime: schedulePlan.endTime,
      slotIndex: slot.slotIndex,
      repeatEvery: slot.repeatEvery,
      repeatPattern: slot.repeatPattern,
      repeatTimezone: slot.repeatTimezone,
    });
  }

  return {
    jobId: buildScheduledJobId({ tenantKey, configId }),
    configId,
    objectType,
    schedulePlan,
  };
}
```

**3e.** En el `logger.info` de `registerScheduledJob` (`:407`), las claves `executionTime`,
`repeatEvery`, `repeatPattern` y `repeatTimezone` ya no existen sueltas en el plan. Reemplazarlas
por:

```js
    executionTimes: schedulePlan.executionTimes,
    slots: schedulePlan.slots.map((slot) => ({
      slotIndex: slot.slotIndex,
      executionTime: slot.executionTime,
      repeatEvery: slot.repeatEvery,
      repeatPattern: slot.repeatPattern,
      repeatTimezone: slot.repeatTimezone,
    })),
```

- [ ] **Paso 4: correr los tests y ver que pasan**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncScheduler'
```

Esperado: PASS. Los ocho tests que ya existían siguen verdes: los de FULL con hora única producen un
solo slot con la misma hora y el mismo cron, y los de INCREMENTAL producen un slot sin `slotIndex`.

- [ ] **Paso 5: punto de corte**

```
feat: schedule one BullMQ job per execution hour
```

---

### Task 5: borrado con lista fija de nombres, `hasScheduledJob` completo y bootstrap sin duplicar

**Files:**
- Modify: `src/infrastructure/scheduler/sapSyncScheduler.service.js` — `buildRemovalKeyCandidates`
  (`:277`), `hasScheduledJob` (`:372`), `bootstrapScheduledJobs` (`:449-540`)
- Test: `tests/unit/sapSyncScheduler.service.test.js`

**Interfaces:**
- Consumes: `resolveSchedulePlan` con `slots` (Task 4), `buildScheduledJobId` con `slotIndex`
  (Task 3), `MAX_EXECUTION_TIMES` (Task 1).
- Produces: nada nuevo hacia afuera. Cambia comportamiento interno.

**Por qué el cambio en bootstrap.** Hoy la rama sin `upsertExisting` llama a `createScheduledJob`,
que **crea sin borrar**. Después de este cambio, una config FULL que ya está registrada bajo el
nombre plano dejaría de ser reconocida por `hasScheduledJob` (que ahora busca `:0`), se crearía
`:0`, y el nombre plano seguiría vivo: **la tarea correría dos veces esa hora** hasta que alguien la
reprogramara. Pasa a llamar a `registerScheduledJob`, que borra los nombres conocidos antes de crear.

- [ ] **Paso 1: escribir el test que falla**

Agregar a `tests/unit/sapSyncScheduler.service.test.js`:

```js
  it('drops the schedulers of hours that were removed from the config', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([
        { key: 'sap-sync:printer:cfg-shrink:0', name: 'sap-sync-job', template: { data: {} } },
        { key: 'sap-sync:printer:cfg-shrink:1', name: 'sap-sync-job', template: { data: {} } },
        { key: 'sap-sync:printer:cfg-shrink:2', name: 'sap-sync-job', template: { data: {} } },
      ]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    // Sin previousConfig a propósito: la lista de nombres a borrar es fija, no derivada del estado
    // anterior.
    const config = {
      _id: 'cfg-shrink',
      active: true,
      mode: 'FULL',
      executionTime: ['07:00'],
      objectType: 'product',
    };

    await syncScheduledJob({ tenantKey: 'printer', config });

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:printer:cfg-shrink:0');
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:printer:cfg-shrink:1');
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:printer:cfg-shrink:2');
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledTimes(1);
  });

  it('bootstrap replaces a legacy flat scheduler instead of leaving it running beside slot 0', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([
        { key: 'sap-sync:tenant-e:cfg-5', name: 'sap-sync-job', template: { data: {} } },
      ]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });
    mockListActiveTenants.mockResolvedValue([{ client: { tenantKey: 'tenant-e' } }]);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'cfg-5',
              active: true,
              mode: 'FULL',
              executionTime: '05:00',
              objectType: 'Items',
            },
          ]),
        }),
      },
    });

    const result = await bootstrapScheduledJobs();

    expect(result).toEqual(expect.objectContaining({ configsScheduled: 1 }));
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:tenant-e:cfg-5');
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      slotIndex: 0,
      repeatPattern: '0 5 * * *',
    }));
  });

  it('bootstrap upsert keeps every slot it just created', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn(),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });
    mockListActiveTenants.mockResolvedValue([{ client: { tenantKey: 'printer' } }]);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'cfg-multi',
              active: true,
              mode: 'FULL',
              executionTime: ['07:00', '12:00', '15:00'],
              objectType: 'product',
            },
          ]),
        }),
      },
    });

    // El barrido de huérfanos vuelve a leer la cola al final: devolvemos los tres slots recién
    // creados para comprobar que NO se los lleva por delante.
    queue.getJobSchedulers.mockImplementation(async () => ([
      { key: 'sap-sync:printer:cfg-multi:0', name: 'sap-sync-job', template: { data: {} } },
      { key: 'sap-sync:printer:cfg-multi:1', name: 'sap-sync-job', template: { data: {} } },
      { key: 'sap-sync:printer:cfg-multi:2', name: 'sap-sync-job', template: { data: {} } },
    ]));

    const result = await bootstrapScheduledJobs({ upsertExisting: true });

    expect(result).toEqual(expect.objectContaining({
      configsScheduled: 1,
      orphanRemoved: 0,
    }));
  });
```

- [ ] **Paso 2: correr los tests y ver que fallan**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncScheduler'
```

Esperado: FAIL en los tres. El primero no borra `:1` ni `:2` (no están en los candidatos), el segundo
no borra el nombre plano (bootstrap sin upsert no borra), el tercero borra los tres slots como
huérfanos porque `expectedJobKeys` sólo tiene el nombre plano.

- [ ] **Paso 3: implementar**

**3a.** Agregar `MAX_EXECUTION_TIMES` al import del dominio:

```js
import { MAX_EXECUTION_TIMES, normalizeExecutionTimes } from '#domain/sync/execution-times.js';
```

**3b.** Reemplazar `buildRemovalKeyCandidates` (`:277-301`) por:

```js
// La lista de nombres a borrar es FIJA, no derivada del estado anterior: el nombre plano (el que
// usaban las configs antes de multihora, y el que siguen usando las INCREMENTAL) más un nombre por
// cada slot posible. Por eso bajar de 3 horas a 1 limpia igual sin recibir previousConfig.
// Las claves md5 legacy (repeatable jobs de la API vieja de BullMQ) sí se derivan del plan, una por
// slot.
function buildRemovalKeyCandidates({ jobId, config }) {
  const keys = new Set([jobId]);

  for (let slotIndex = 0; slotIndex < MAX_EXECUTION_TIMES; slotIndex += 1) {
    keys.add(`${jobId}:${slotIndex}`);
  }

  const schedulePlan = resolveSchedulePlan(config);
  if (!schedulePlan) {
    return Array.from(keys);
  }

  for (const slot of schedulePlan.slots) {
    keys.add(buildLegacyRepeatableKey({
      jobId,
      repeatEvery: slot.repeatEvery,
      repeatPattern: slot.repeatPattern,
    }));

    if (slot.repeatPattern) {
      keys.add(buildLegacyRepeatableKey({
        jobId,
        repeatEvery: slot.repeatEvery,
        repeatPattern: slot.repeatPattern,
        repeatTimezone: slot.repeatTimezone || '',
      }));
    }
  }

  return Array.from(keys);
}
```

**3c.** Reemplazar `hasScheduledJob` (`:372-383`) por una versión que exija **todos** los slots. La
anterior usaba `.some()` sobre todos los candidatos, lo que con la lista fija daría verdadero con que
existiera cualquier slot:

```js
function hasScheduledJob({ scheduledJobs, tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  if (!tenantKey || !configId || !Array.isArray(scheduledJobs)) {
    return false;
  }

  const schedulePlan = resolveSchedulePlan(config);
  if (!schedulePlan) {
    return false;
  }

  const jobId = buildScheduledJobId({ tenantKey, configId });

  return schedulePlan.slots.every((slot) => {
    const keys = new Set([
      buildScheduledJobId({ tenantKey, configId, slotIndex: slot.slotIndex }),
      buildLegacyRepeatableKey({
        jobId,
        repeatEvery: slot.repeatEvery,
        repeatPattern: slot.repeatPattern,
      }),
    ]);

    if (slot.repeatPattern) {
      keys.add(buildLegacyRepeatableKey({
        jobId,
        repeatEvery: slot.repeatEvery,
        repeatPattern: slot.repeatPattern,
        repeatTimezone: slot.repeatTimezone || '',
      }));
    }

    return scheduledJobs.some((job) => matchesScheduledJobKeys(job, keys));
  });
}
```

**3d.** En `bootstrapScheduledJobs`, dentro del `for (const config of configs)`, borrar la línea
`const jobKey = buildScheduledJobId({ tenantKey, configId });` y reemplazar el bloque
`if (config.active && schedulePlan) { ... }` por:

```js
        if (config.active && schedulePlan) {
          const slotKeys = schedulePlan.slots.map((slot) => buildScheduledJobId({
            tenantKey,
            configId,
            slotIndex: slot.slotIndex,
          }));

          if (upsertExisting) {
            for (const slotKey of slotKeys) {
              expectedJobKeys.add(slotKey);
            }
            await registerScheduledJob({ tenantKey, config });
            summary.configsScheduled += 1;
            continue;
          }

          if (hasScheduledJob({ scheduledJobs: scheduledJobs.all, tenantKey, config })) {
            summary.configsSkippedExisting += 1;
            continue;
          }

          // registerScheduledJob y no createScheduledJob: borra antes de crear. Si no, una config
          // FULL registrada bajo el nombre plano de antes de multihora quedaría con el plano Y con
          // :0, y correría dos veces a esa hora.
          await registerScheduledJob({ tenantKey, config });
          for (const slotKey of slotKeys) {
            scheduledJobs.all.push({
              key: slotKey,
              id: slotKey,
              name: SAP_SYNC_JOB_NAME,
            });
          }
          summary.configsScheduled += 1;
        } else {
```

- [ ] **Paso 4: correr los tests y ver que pasan**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncScheduler'
```

Esperado: PASS, incluidos los ocho originales. Verificar en particular que sigan verdes
`replaces the previous FULL schedule and applies America/Costa_Rica timezone` (depende de la clave
md5 legacy derivada del slot de `previousConfig`) y
`bootstrap skips creating a job when the tenant config already exists in BullMQ` (INCREMENTAL, cuyo
slot no tiene `slotIndex` y por lo tanto sigue buscando el nombre plano).

- [ ] **Paso 5: punto de corte**

```
fix: clean every execution slot when rescheduling a sap-sync config
```

---

### Task 6: la API devuelve siempre un array

**Files:**
- Modify: `src/infrastructure/scheduler/sapSyncQueueAdmin.service.js:1-22` (imports y
  `serializeConfig`)
- Test: `tests/unit/sapSyncQueueAdmin.serializeConfig.test.js` (crear)

**Interfaces:**
- Consumes: `normalizeExecutionTimes` (Task 1).
- Produces: `serializeConfig` devuelve `executionTime` como `string[]`. Lo consumen
  `GET /sap-sync/jobs`, `POST /sap-sync/jobs/activate`, `/deactivate`, `/jobs/run`,
  `/config/:id/run` y `/config/:id/sync-schedule`.

- [ ] **Paso 1: escribir el test que falla**

Crear `tests/unit/sapSyncQueueAdmin.serializeConfig.test.js`. `serializeConfig` es privada del
módulo, así que se prueba a través de `setConfigActiveState`, que la devuelve. Antes de escribirlo,
abrir `src/infrastructure/scheduler/sapSyncQueueAdmin.service.js` y copiar la lista real de imports
al bloque de mocks: si falta uno, el `await import` falla con `Cannot find module`.

```js
import { jest } from '@jest/globals';

const mockGetTenantModels = jest.fn();
const mockSyncScheduledJob = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/database/tenant/tenantDatabase.js', () => ({
  getTenantModels: mockGetTenantModels,
}));

jest.unstable_mockModule('../../src/infrastructure/scheduler/sapSyncScheduler.service.js', () => ({
  syncScheduledJob: mockSyncScheduledJob,
  bootstrapScheduledJobs: jest.fn(),
  removeTenantScheduledJobs: jest.fn(),
}));

jest.unstable_mockModule('../../src/infrastructure/queue/sapSync.queue.js', () => ({
  addManualSapSyncJob: jest.fn(),
  getSapSyncQueue: jest.fn(),
  getSapSyncJobSchedulers: jest.fn(),
  SAP_SYNC_QUEUE_NAME: 'sap-sync',
}));

jest.unstable_mockModule('../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const { setConfigActiveState } = await import(
  '../../src/infrastructure/scheduler/sapSyncQueueAdmin.service.js'
);

function stubConfig(executionTime) {
  return {
    _id: 'cfg-1',
    active: false,
    objectType: 'product',
    mode: 'FULL',
    intervalMinutes: null,
    executionTime,
    executionDays: ['Monday'],
    startTime: null,
    endTime: null,
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('serializeConfig executionTime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncScheduledJob.mockResolvedValue({ action: 'registered' });
  });

  async function activateWith(executionTime) {
    const config = stubConfig(executionTime);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: { findById: jest.fn().mockResolvedValue(config) },
    });

    return setConfigActiveState({ tenantKey: 'printer', configId: 'cfg-1', active: true });
  }

  it('returns an array for a multi-hour config', async () => {
    const result = await activateWith(['07:00', '12:00', '15:00']);

    expect(result.executionTime).toEqual(['07:00', '12:00', '15:00']);
  });

  it('wraps a legacy string value', async () => {
    const result = await activateWith('01:00');

    expect(result.executionTime).toEqual(['01:00']);
  });

  it('returns an empty array when there is no schedule', async () => {
    const result = await activateWith(null);

    expect(result.executionTime).toEqual([]);
  });

  it('echoes back the raw value when it cannot be normalized', async () => {
    const result = await activateWith(['nope']);

    expect(result.executionTime).toEqual(['nope']);
  });
});
```

- [ ] **Paso 2: correr el test y ver que falla**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncQueueAdmin'
```

Esperado: FAIL en `wraps a legacy string value` — hoy devuelve la cadena `'01:00'` — y en
`returns an empty array` — hoy devuelve `null`.

- [ ] **Paso 3: implementar**

En `src/infrastructure/scheduler/sapSyncQueueAdmin.service.js`, agregar el import:

```js
import { normalizeExecutionTimes } from '#domain/sync/execution-times.js';
```

agregar arriba de `serializeConfig`:

```js
// Si el valor guardado no se puede normalizar, se devuelve tal cual en vez de vaciarlo: la respuesta
// del API es el lugar donde el operador tiene que PODER VER que el dato está mal.
function serializeExecutionTimes(value) {
  try {
    return normalizeExecutionTimes(value);
  } catch (error) {
    return value;
  }
}
```

y reemplazar la línea 17 de `serializeConfig`:

```js
    executionTime: serializeExecutionTimes(config.executionTime),
```

- [ ] **Paso 4: correr el test y ver que pasa**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='sapSyncQueueAdmin'
```

Esperado: PASS, 4 tests.

- [ ] **Paso 5: punto de corte**

```
feat: return executionTime as an array from the sap-sync admin API
```

---

### Task 7: master, replicación y semillas

**Files:**
- Modify: `src/infrastructure/config/masterClientConfig.service.js:1-30` (imports/constantes),
  `:77-81` (sanitizado), `:120-135` (`ensureRequiredForCreate`)
- Modify: `src/infrastructure/tenants/replicateMasterClientConfigs.js:29`
- Modify: `src/infrastructure/database/seeds/masterClientConfigs.seed.js` (8 apariciones de
  `executionTime`)
- Test: `tests/unit/masterClientConfigExecutionTimes.test.js` (crear)

**Interfaces:**
- Consumes: `normalizeExecutionTimes` (Task 1).
- Produces: nada nuevo. `sanitizeMasterPayload` deja `executionTime` como `string[]`.

- [ ] **Paso 1: escribir el test que falla**

Crear `tests/unit/masterClientConfigExecutionTimes.test.js`:

```js
import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/database/models/master/ClientConfig.js', () => ({
  createMasterClientConfigModel: () => ({ create: mockCreate }),
}));

const { createMasterClientConfig } = await import(
  '../../src/infrastructure/config/masterClientConfig.service.js'
);

const base = {
  clientName: 'Obtener Productos',
  objectType: 'product',
  serviceLayerPath: '/Items',
  mode: 'FULL',
};

describe('masterClientConfig executionTime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockImplementation(async (payload) => payload);
  });

  it('accepts an array of times and stores it sorted', async () => {
    await createMasterClientConfig({}, { ...base, executionTime: ['15:00', '07:00'] });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      executionTime: ['07:00', '15:00'],
    }));
  });

  it('accepts a bare string and wraps it', async () => {
    await createMasterClientConfig({}, { ...base, executionTime: '01:00' });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      executionTime: ['01:00'],
    }));
  });

  it('rejects a badly formatted time', async () => {
    await expect(createMasterClientConfig({}, { ...base, executionTime: ['7:00'] }))
      .rejects.toThrow(/executionTime/);
  });

  it('rejects a FULL template with an empty array of times', async () => {
    await expect(createMasterClientConfig({}, { ...base, executionTime: [] }))
      .rejects.toThrow(/Missing required fields/);
  });
});
```

El último test es el que importa: hoy `ensureRequiredForCreate` sólo comprueba que el campo sea
*truthy*, y `[]` es truthy, así que una plantilla FULL sin horas pasaría la validación sin que nadie
lo note.

- [ ] **Paso 2: correr el test y ver que falla**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='masterClientConfigExecutionTimes'
```

Esperado: FAIL en el primero (`executionTime must use HH:mm format`, porque hoy hace
`String(['15:00','07:00'])`) y en el último (`[]` pasa como truthy y llama a `create`).

- [ ] **Paso 3: implementar**

En `src/infrastructure/config/masterClientConfig.service.js`, agregar el import:

```js
import { normalizeExecutionTimes } from '#domain/sync/execution-times.js';
```

Reemplazar el bloque de `executionTime` (`:77-81`) por:

```js
  if (Object.prototype.hasOwnProperty.call(sanitized, 'executionTime')) {
    sanitized.executionTime = normalizeExecutionTimes(sanitized.executionTime);
  }
```

`TIME_PATTERN` sigue en uso para `startTime`/`endTime`: no borrarlo.

En `ensureRequiredForCreate`, reemplazar el cálculo de `missing` para que un array vacío cuente como
faltante:

```js
  const missing = required.filter((field) => {
    const value = payload[field];
    return Array.isArray(value) ? value.length === 0 : !value;
  });
```

En `src/infrastructure/tenants/replicateMasterClientConfigs.js`, agregar el import y reemplazar la
línea 29:

```js
    executionTime: normalizeExecutionTimes(masterConfig.executionTime),
```

En `src/infrastructure/database/seeds/masterClientConfigs.seed.js`, envolver cada hora en un array:
`executionTime: '01:00'` → `executionTime: ['01:00']`, y lo mismo con `'02:00'` y `'03:00'`. Las dos
apariciones de `executionTime: null` pasan a `executionTime: []`.

- [ ] **Paso 4: correr los tests y ver que pasan**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]' --testPathPatterns='masterClientConfig|replicateMaster|seed'
```

Esperado: PASS, y ninguna suite existente de master o de replicación en rojo.

- [ ] **Paso 5: punto de corte**

```
feat: accept arrays of execution times in master client configs
```

---

### Task 8: script de migración por base

**Files:**
- Create: `scripts/migrate-client-config-execution-times.mjs`

**Interfaces:**
- Consumes: `EXECUTION_TIME_PATTERN` (Task 1). Se importa, no se copia: `execution-times.js` es puro
  y no arrastra el resto de `src/`.
- Produces: nada de código. Ejecutable a mano.

No lleva test automatizado: sigue el patrón de `scripts/migrate-webhook-event-dedup-active.mjs`, que
tampoco lo tiene, y su verificación es la corrida en dry run.

- [ ] **Paso 1: escribir el script**

Crear `scripts/migrate-client-config-execution-times.mjs`:

```js
// scripts/migrate-client-config-execution-times.mjs
//
// Migración por base que convierte ClientConfigs.executionTime de String a array de String.
//
// NO es un prerrequisito de deploy: Mongoose 8 hidrata un escalar guardado en un path [String] como
// array de un elemento, así que el código nuevo lee bien los documentos viejos. Esto es para dejar
// los tipos consistentes en disco, sobre todo porque .lean() NO castea y ahí sí llega el string
// crudo.
//
// Idempotente: los documentos que ya son array no se tocan.
//
// El nombre de la base de un tenant es `${TENANT_DB_PREFIX|sap_integration}_${tenantKey}` (ver
// buildTenantDatabaseName en src/infrastructure/database/tenant/tenantDatabase.js). La base master
// tiene su propia colección ClientConfigs con las plantillas y también hay que correrla.
//
// Uso, una base a la vez:
//   node --env-file=.env scripts/migrate-client-config-execution-times.mjs <dbName> [--apply]
//
// Dry run por defecto: sin --apply no se escribe nada.
import { MongoClient } from 'mongodb';
import { EXECUTION_TIME_PATTERN } from '../src/domain/sync/execution-times.js';

const COLLECTION = 'ClientConfigs';

const [, , dbName, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/migrate-client-config-execution-times.mjs <dbName> [--apply]');
  process.exit(1);
}

if (!dbName) {
  usage('Missing database name.');
}

if (!uri) {
  usage('Missing MONGODB_URI.');
}

const client = new MongoClient(uri);

try {
  await client.connect();
  const collection = client.db(dbName).collection(COLLECTION);

  const candidates = await collection
    .find({ executionTime: { $type: 'string' } })
    .project({ _id: 1, clientName: 1, mode: 1, executionTime: 1 })
    .toArray();

  const planned = [];
  const invalid = [];

  for (const doc of candidates) {
    const value = String(doc.executionTime).trim();

    if (!value) {
      planned.push({ doc, next: [] });
      continue;
    }

    if (!EXECUTION_TIME_PATTERN.test(value)) {
      invalid.push({ doc, value });
      continue;
    }

    planned.push({ doc, next: [value] });
  }

  console.log(`[${dbName}] ${COLLECTION}: ${candidates.length} document(s) with a string executionTime`);

  for (const { doc, next } of planned) {
    console.log(`  ${doc._id} ${doc.clientName || '(no name)'} [${doc.mode}] ${JSON.stringify(doc.executionTime)} -> ${JSON.stringify(next)}`);
  }

  for (const { doc, value } of invalid) {
    console.warn(`  SKIPPED ${doc._id} ${doc.clientName || '(no name)'}: ${JSON.stringify(value)} is not HH:mm`);
  }

  if (!apply) {
    console.log(`[${dbName}] dry run: nothing written. Re-run with --apply to write.`);
  } else {
    let updated = 0;

    for (const { doc, next } of planned) {
      const result = await collection.updateOne({ _id: doc._id }, { $set: { executionTime: next } });
      updated += result.modifiedCount;
    }

    console.log(`[${dbName}] applied: ${updated} document(s) updated, ${invalid.length} skipped as invalid.`);
  }
} finally {
  await client.close();
}
```

- [ ] **Paso 2: verificar que arranca y valida los argumentos**

```
node scripts/migrate-client-config-execution-times.mjs
```

Esperado: sale con código 1 e imprime `Missing database name.` más la línea de uso.

- [ ] **Paso 3: correr el dry run contra cada base**

Sólo si hay acceso a la base. Con `MONGODB_URI` apuntando al Mongo correspondiente:

```
node --env-file=.env scripts/migrate-client-config-execution-times.mjs sap_integration_amc
node --env-file=.env scripts/migrate-client-config-execution-times.mjs sap_integration_distelsa
node --env-file=.env scripts/migrate-client-config-execution-times.mjs sap_integration_noelito
node --env-file=.env scripts/migrate-client-config-execution-times.mjs sap_integration_printer
```

Más la base master, cuyo nombre sale del *path* de `MONGODB_URI` (lo mismo que hace
`migrate-mongo-config.cjs`). Confirmar el prefijo real con `TENANT_DB_PREFIX` del `.env` antes de
correr.

Esperado: lista de documentos y `dry run: nothing written`. **No** correr con `--apply` sin que el
dueño lo apruebe: es escritura sobre producción.

- [ ] **Paso 4: punto de corte**

```
chore: add per-database migration for array executionTime
```

---

### Task 9: suite completa y verificación contra el baseline

**Files:** ninguno. Verificación.

- [ ] **Paso 1: correr la suite entera**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]'
```

- [ ] **Paso 2: comparar contra el baseline**

Esperado: **182 suites** (178 + las 4 creadas: `executionTimes`, `clientConfigSchema`,
`sapSyncQueueAdmin.serializeConfig`, `masterClientConfigExecutionTimes`), con **exactamente las 5
rojas preexistentes**:

- `tests/integration/internalTenant.test.js`
- `tests/unit/application/sendMappedItemsToHubspot.test.js`
- `tests/unit/lineItemPriceWebhook.service.test.js`
- `tests/unit/serviceLayerFlow.test.js`
- `tests/unit/serviceLayerService.test.js`

Si hay una sexta suite roja, es de este cambio. Si el conteo total no da 182, revisar que las dos
opciones de jest lleven `=`: sin él la corrida levanta las 977 suites de los worktrees en silencio.

- [ ] **Paso 3: grep de seguridad por lecturas sin normalizar**

```
grep -rn "executionTime" src/ | grep -v "execution-times.js"
```

Revisar cada aparición: no debe quedar ninguna que trate `executionTime` como string sin pasar por
`normalizeExecutionTimes` o por un slot del plan.

- [ ] **Paso 4: reportar al dueño**

Resumen de qué se cambió, en qué archivos y por qué, más el conteo de suites y las rojas
preexistentes, para que redacte el commit.

---

## Prueba manual, después de que el dueño commitee y despliegue

Contra el tenant `printer`, con la ClientConfig *Obtener Productos*:

1. Obtener el `_id`:
   ```
   GET /config/client
   Headers: x-tenant-id: <_id del SaaSClient de printer>
   ```
2. Programarla:
   ```
   PATCH /config/client/<id>
   Headers: x-tenant-id: <_id del SaaSClient de printer>

   {
     "active": true,
     "mode": "FULL",
     "executionTime": ["07:00", "12:00", "15:00"],
     "executionDays": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
     "intervalMinutes": null,
     "startTime": null,
     "endTime": null
   }
   ```
   No mandar `filters`: al omitirlo se conservan, y mandarlos con `isDefault: true` devuelve 403.
3. Verificar los tres schedulers:
   ```
   GET /sap-sync/jobs
   Headers: x-internal-key: <INTERNAL_KEY>
   ```
   Esperado: `sap-sync:printer:<configId>:0`, `:1` y `:2` con los patrones `0 7 * * 1,2,3,4,5,6`,
   `0 12 * * 1,2,3,4,5,6` y `0 15 * * 1,2,3,4,5,6`.
4. Bajar a una sola hora con otro PATCH (`"executionTime": ["07:00"]`) y volver a mirar
   `GET /sap-sync/jobs`: deben quedar sólo `:0`.

Si el PATCH devuelve **402**, es `tenantResolver` rechazando por `SaaSClient.status` o por la
`Subscription` de printer, no por el body.

---

## Estado de ejecución (2026-09-06)

Implementado completo en `main`, sin commitear (lo commitea el dueño del repo).

**Dos desvíos respecto de este plan, ambos deliberados:**

1. **Las tareas 4 y 5 se ejecutaron juntas.** El plan las separaba, pero `buildRemovalKeyCandidates`
   y `hasScheduledJob` leen los campos planos del plan de agenda, así que cambiar la forma del plan
   las rompe en el mismo paso y la Task 4 no podía cerrar en verde por sí sola. Error del plan, no
   del diseño.
2. **Un cambio extra no previsto:** `sapSyncQueueAdmin.service.js` en `runConfigManualJob` también
   pasaba `config.executionTime || null` al payload del job manual. El worker no lo lee (verificado),
   pero se normalizó para que el tipo sea consistente.

**Baseline de la suite corregido.** El plan citaba 178 suites, cifra medida el 2026-08-21 y ya
desactualizada. La medición real del 2026-09-06 es **194 suites, 5 rojas / 10 tests**, y son las
mismas cinco de siempre. Resultado tras el cambio:

```
Test Suites: 5 failed, 189 passed, 194 total
Tests:       10 failed, 1964 passed, 1974 total
```

**Una suite flaky, no una regresión.** En la primera corrida completa apareció en rojo
`tests/unit/replicateDefaultSapFilters.test.js`, que no está en el baseline. Se descartó como
regresión: pasa aislada, no importa ninguno de los archivos modificados (usa
`replicateDefaultSapFilters.js`, no `replicateMasterClientConfigs.js`) y levanta un
`MongoMemoryServer` real. En dos corridas completas posteriores pasó.

**Corrección al análisis de riesgo de la Task 5.** El plan justificaba el cambio en
`bootstrapScheduledJobs` diciendo que sin él una config FULL correría dos veces tras el reinicio del
worker. Eso es falso: la app arranca llamando `bootstrapSapSyncScheduler()`
(`src/bootstrap/appLifecycle.bootstrap.js:21`), que usa `{ upsertExisting: true }` -- la rama que sí
borra antes de crear. La rama sin `upsertExisting` no la invoca nada en `src/`, sólo los tests. El
cambio queda como endurecimiento defensivo, no como arreglo de un bug alcanzable.

**Task 8 pasos 3 y 4: NO ejecutados, por decisión del dueño.** La migración de datos es opcional:
los cuatro caminos de lectura toleran el string viejo y el primer PATCH que toque las horas de una
config la convierte a array sola. El script `scripts/migrate-client-config-execution-times.mjs` queda
disponible para cuando se quiera dejar los tipos consistentes en disco. Bases pendientes si algún día
se corre: `sap_integration_amc`, `sap_integration_distelsa`, `sap_integration_noelito`,
`sap_integration_printer` y la master `SmartConnect` (`TENANT_DB_PREFIX` no está definido en el `.env`
local, así que aplica el default `sap_integration`).
