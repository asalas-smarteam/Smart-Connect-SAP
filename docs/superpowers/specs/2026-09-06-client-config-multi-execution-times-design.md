# Múltiples horas de ejecución por ClientConfig

Fecha: 2026-09-06

## Lo que se pide

Que una tarea programada pueda correr **varias veces al día a horas específicas** sin duplicar la
ClientConfig. Caso concreto que lo motivó: el tenant `printer`, tarea *Obtener Productos*
(`serviceLayerPath: '/Items'`, `mode: 'FULL'`), a las 07:00, 12:00 y 15:00 de lunes a sábado.

El campo `executionTime` pasa de ser un `String` (`"07:00"`) a ser un **array de horas**
(`["00:00", "00:30", "09:30"]`).

Todo lo demás sigue igual. `executionDays`, `mode`, `intervalMinutes`, `startTime`/`endTime`,
filtros y mapeos no se tocan.

## Por qué hoy no se puede

`executionTime` es un `String` con validador `HH:mm`
(`src/infrastructure/database/models/tenant/ClientConfig.js:116`), y el cron se arma con una sola
hora:

```js
// src/infrastructure/scheduler/sapSyncScheduler.service.js:101
function buildDailyPattern({ executionTime, executionDays }) {
  const time = parseTime(String(executionTime || '').trim());
  ...
  return `${time.minutes} ${time.hours} * * ${dayPattern}`;
}
```

No existe `executionTimes` en ninguna parte del repo, ni parseo de comas.

### El modo de fallo que hay que evitar

Guardar un array **sin tocar el scheduler** no produce un error: produce una tarea que desaparece.

`resolveSchedulePlan` hace `String(config?.executionTime || '').trim()`
(`sapSyncScheduler.service.js:175`). Con `["07:00","12:00"]` eso da la cadena `"07:00,12:00"`,
`parseTime` no matchea, `buildDailyPattern` devuelve `null`, `resolveSchedulePlan` devuelve `null`,
y entonces `syncScheduledJob` (`:434`) toma la rama de baja y **borra el job en vez de
programarlo**. Sin excepción, sin log de error: `syncScheduler` en `ManageClientConfigs.js:239` ya
traga cualquier fallo del scheduler en un `catch` que sólo loguea.

Es el mismo patrón de "verde pero no corrió" que ya apareció en este repo con los SyncLog en cero.
Por eso el cambio de schema y el del scheduler van juntos, en un solo commit, y no por separado.

## El cambio

### 1. Normalizador en el dominio

Módulo nuevo `src/domain/sync/execution-times.js`, puro, sin imports (vecino de
`dropdown-options.constants.js` / `dropdown-options.service.js`, que ya viven ahí).

```
normalizeExecutionTimes(value) -> string[]
MAX_EXECUTION_TIMES = 24
EXECUTION_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
```

Reglas:

| Entrada | Salida |
|---|---|
| `null`, `undefined`, `''`, `[]` | `[]` |
| `'07:00'` | `['07:00']` |
| `['12:00', '07:00']` | `['07:00', '12:00']` (ordenado ascendente) |
| `['07:00', '07:00']` | `['07:00']` (deduplicado) |
| `[' 07:00 ']` | `['07:00']` (recortado) |
| `['7:00']`, `['24:00']`, `['07:60']` | lanza `Error` |
| 25 horas distintas o más | lanza `Error` (los repetidos se deduplican antes de contar) |

**Ordenar y deduplicar no es cosmético.** El nombre del job scheduler de BullMQ se deriva del índice
dentro del array, así que un array desordenado o con repetidos produciría nombres distintos para la
misma configuración.

El mensaje de error debe contener el texto `executionTime`. Dos regex lo matchean para devolver 400
en vez de 500: `isConfigValidationError` (`ManageClientConfigs.js:33`) y el handler del master
(`masterClientConfig.controller.js:4`). Se usa el wording actual
`executionTime must use HH:mm format`, y para el tope
`executionTime cannot have more than 24 entries`.

### 2. Schema

`executionTime` pasa a `{ type: [String], default: [] }` con un validador que aplica
`EXECUTION_TIME_PATTERN` a cada entrada y verifica el tope
(`src/infrastructure/database/models/tenant/ClientConfig.js:116`).

El schema del master **no necesita edición**: `masterClientConfigSchema` es
`clientConfigSchema.clone()` (`src/infrastructure/database/models/master/ClientConfig.js:6`), así
que hereda el cambio.

#### Compatibilidad con los documentos que ya existen

Verificado contra el mongoose instalado (8.21.0), con el path declarado como `[String]`:

```
Model.hydrate({ executionTime: '01:00' })  ->  ['01:00']    (no lanza CastError)
doc.executionTime = '07:00'                ->  ['07:00']    (envuelve solo)
Model.hydrate({ executionTime: null })     ->  null         (no lo convierte a [])
```

Tres consecuencias:

- **La migración no es prerrequisito de deploy.** Los documentos que hoy guardan `"01:00"` se leen
  bien por Mongoose después del cambio.
- **El PATCH sigue aceptando un string suelto** (`"executionTime": "12:00"`) sin código extra.
- **`null` sigue siendo `null`, no `[]`**: todo lector tiene que tolerar los tres valores.

Y una trampa que obliga a normalizar en el scheduler pase lo que pase: `bootstrapScheduledJobs` lee
con `ClientConfig.find({}).lean()` (`sapSyncScheduler.service.js:474`), y **`.lean()` salta el
casteo de Mongoose**. Ahí llega el string crudo del disco. Por eso el normalizador se aplica en el
punto de lectura del scheduler, no sólo en la escritura.

### 3. BullMQ: un job scheduler por hora

Hoy hay **uno** por config. `addScheduledSapSyncJob` hace
`queue.upsertJobScheduler(schedulerId, repeatOptions, jobTemplate)`
(`src/infrastructure/queue/sapSync.queue.js:136`) con
`schedulerId = buildScheduledJobId({ tenantKey, configId })` = `sap-sync:<tenantKey>:<configId>`
(`:14`), y un único `repeatPattern`.

Un scheduler acepta un solo patrón de repetición, y un cron agrupado tipo `0 7,12,15 * * 1-6` sólo
sirve si **todas las horas comparten el minuto**: con `07:00` y `12:30`, `0,30 7,12 * * *`
dispararía además a las `07:30` y a las `12:00`. Entonces: un scheduler por hora.

#### Nombres

`buildScheduledJobId({ tenantKey, configId, slotIndex })`, con `slotIndex` opcional:

| Modo | Nombre |
|---|---|
| INCREMENTAL (sin `slotIndex`) | `sap-sync:<tenantKey>:<configId>` — idéntico a hoy |
| FULL, hora i (0-based) | `sap-sync:<tenantKey>:<configId>:<i>` |

El índice, y no la hora, porque con el tope de 24 el conjunto de nombres posibles de una config
queda **fijo y conocido**: el nombre plano más `:0` … `:23`. Como las horas van ordenadas
ascendente, el índice `0` es siempre la más temprana.

#### Borrado

`removeScheduledRepeatablesByKeys` (`sapSyncScheduler.service.js:303`) ya recibe una lista de
nombres y filtra contra lo que hay en Redis. Lo único que cambia es cómo se arma esa lista:
`buildRemovalKeyCandidates` (`:277`) agrega el nombre plano más `:0` … `:23`.

Se mantiene tal cual el cálculo de claves md5 legacy (`buildLegacyRepeatableKey`, `:271`), que cubre
los repeatable jobs de la API vieja de BullMQ.

Esto no usa comodines ni prefijos: nunca toca un nombre que no calculó. Y como la lista es fija, no
depende de recibir `previousConfig` para limpiar un horario anterior — bajar de 3 horas a 1 borra
`:1` y `:2` igual, venga la llamada de donde venga.

**El tope de 24 es load-bearing**, no sólo un seguro contra un array mal pegado: define la lista de
borrado. Es una sola constante, `MAX_EXECUTION_TIMES`.

Una config FULL que hoy corre pasa del nombre plano a `:0`. El nombre plano está en la lista de
borrado, así que la transición se hace sola la primera vez que se reprograma. Si el código se
revirtiera, los `:0`…`:N` quedarían huérfanos en Redis; se limpian con `POST /sap-sync/jobs/resync`,
que ya barre huérfanos (`:527`).

#### Forma del plan

`resolveSchedulePlan` (`:172`) deja de devolver `repeatPattern` suelto y devuelve
`slots: [{ slotIndex, executionTime, repeatEvery, repeatPattern, repeatTimezone }]`:

- **FULL**: un slot por hora, `repeatPattern = "${min} ${hora} * * ${días}"`,
  `tz: America/Costa_Rica`. Sin horas válidas devuelve `null` (igual que hoy) y la tarea se da de
  baja.
- **INCREMENTAL**: un único slot, sin `slotIndex`, con la misma lógica de ventana e intervalo que
  hoy. No se toca.

`createScheduledJob` (`:340`) itera slots. `hasScheduledJob` (`:372`) pasa a exigir que estén
**todos** los slots esperados: si falta uno, reprograma. En `bootstrapScheduledJobs`, el `Set`
`expectedJobKeys` (`:455`) recibe un nombre por slot, para que el barrido de huérfanos no borre lo
que la misma corrida acaba de crear.

Para el caso de `printer` quedan tres schedulers con estos patrones:

```
sap-sync:printer:<configId>:0   ->  0 7 * * 1,2,3,4,5,6
sap-sync:printer:<configId>:1   ->  0 12 * * 1,2,3,4,5,6
sap-sync:printer:<configId>:2   ->  0 15 * * 1,2,3,4,5,6
```

El `executionTime` que viaja en el payload del job (`buildSapSyncPayload`, `sapSync.queue.js:83`) es
informativo: se verificó que ni `sapSyncTask.js` ni `sapSync.worker.js` leen `executionTime`,
`executionDays`, `startTime`, `endTime` ni `intervalMinutes`. Cada slot lleva su propia hora, no el
array completo, para que el job diga a qué disparo corresponde.

## Superficie de API

No cambian rutas ni verbos. `PATCH /config/client/:id` y `POST /config/client` siguen aceptando
`"executionTime": "12:00"` y ahora también `["07:00","12:00","15:00"]`.

Lo que cambia es la respuesta: **`executionTime` sale siempre como array**. `serializeConfig`
(`src/infrastructure/scheduler/sapSyncQueueAdmin.service.js:17`) hace hoy
`config.executionTime || null`; pasa a `normalizeExecutionTimes(config.executionTime)`.

No hay front que consuma estas APIs: el único consumidor es Postman, operado por el dueño del
proyecto. No se necesita periodo de compatibilidad ni alias de lectura.

## Master y replicación

- `sanitizeMasterPayload` valida `executionTime` con `TIME_PATTERN` sobre un string
  (`src/infrastructure/config/masterClientConfig.service.js:77-81`): pasa a usar el normalizador, o
  el master rechaza arrays.
- `ensureRequiredForCreate` (`:125`) exige `executionTime` *truthy* para `mode: 'FULL'`. Un `[]` es
  truthy, así que la validación se volvería inútil sin avisar: pasa a chequear **largo > 0**.
- `replicateMasterClientConfigs.js:29` copia `masterConfig.executionTime || null` tal cual: pasa a
  normalizar.
- `masterClientConfigs.seed.js` tiene configs con `executionTime: '01:00' | '02:00' | '03:00'` y dos
  con `null`: se actualizan a arrays.

## Migración de datos

No es prerrequisito de deploy (ver arriba), pero deja los tipos consistentes en disco y evita que
`.lean()` devuelva strings crudos.

`scripts/migrate-client-config-execution-times.mjs`, siguiendo el patrón de
`scripts/migrate-webhook-event-dedup-active.mjs`: dry run por defecto, `--apply` para escribir,
idempotente, una base por corrida.

```
node --env-file=.env scripts/migrate-client-config-execution-times.mjs <dbName> [--apply]
```

Convierte `executionTime` string no vacío → `[string]`. Deja `null` como `null`. No toca los que ya
son array. Cubre las cuatro bases de tenant (`amc`, `distelsa`, `noelito`, `printer`) más la base
master, que tiene su propia colección `ClientConfigs` con las plantillas.

## Pruebas

Unit nuevo `tests/unit/domain/executionTimes.test.js`: la tabla de reglas del normalizador completa,
incluido el tope y los mensajes de error.

Extender `tests/unit/sapSyncScheduler.service.test.js`, que ya tiene casos con `executionTime`:

- FULL con tres horas → tres `upsertJobScheduler` con los tres cron y los nombres `:0`, `:1`, `:2`.
- Bajar de tres horas a una → se borran `:1` y `:2` sin recibir `previousConfig`.
- Config legacy con `executionTime: '05:00'` string crudo (la ruta `.lean()`) → programa igual, como
  `:0`.
- Array vacío o `null` en FULL → sin plan, la tarea se da de baja (comportamiento de hoy).
- INCREMENTAL → un solo scheduler, nombre sin sufijo, sin cambios.

Extender `tests/unit/sapSyncQueue.test.js` para `buildScheduledJobId` con y sin `slotIndex`.

Baseline contra el que comparar: **178 suites, 5 rojas** preexistentes en `main`. `npm test` no corre
en Windows; el comando es:

```
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\\/]node_modules[\\/]|[\\/]\.claude[\\/]'
```

## Fuera de alcance

- **INCREMENTAL sigue ignorando `executionTime`.** Hoy usa `intervalMinutes` con ventana opcional
  `startTime`/`endTime`, y así queda.
- Ninguna ruta nueva, ningún campo nuevo, ningún cambio en filtros, mapeos ni en el pipeline de
  sincronización.
- Nada de cron crudo configurable por el usuario.

## Alternativas descartadas

**Tres ClientConfigs, una por hora.** Es lo que se puede hacer hoy sin tocar código, y fue la primera
propuesta. Se descartó porque los FieldMapping se buscan por `clientConfigId`
(`FieldMapping.find({ clientConfigId, isActive: true })`,
`src/infrastructure/database/repositories/TenantFieldMappingRepository.js:44`), así que cada config
nueva arrastra su propio juego de mapeos: `POST /config/client` corre
`defaultMappingInitializer.ensureAll` y **no copia** los mapeos personalizados de la config
original. Serían tres juegos a mantener en sincronía a mano, para siempre.

**Campo nuevo `executionTimes`, dejando `executionTime` como legacy.** Aditivo y sin migración. Se
descartó porque el normalizador tolerante hace falta igual (por `.lean()`), así que el campo extra no
compra nada y sí agrega la pregunta permanente de cuál de los dos manda.

**`executionTime` array con `executionTimes` como alias de lectura en las respuestas.** Sólo tiene
sentido con consumidores que no se pueden actualizar. No hay ninguno.

**Un solo scheduler con cron agrupado** (`0 7,12,15 * * 1-6`). Mantendría el nombre de hoy y cero
cambios en el borrado, pero sólo es correcto si todas las horas comparten minuto. Con minutos
mezclados el producto cartesiano dispara a horas que nadie pidió. Se podría agrupar por minuto, pero
eso mete una rama condicional justo en el cálculo del nombre del scheduler, que es donde menos
conviene tenerla.

**Borrado por prefijo** (borrar todo lo que empiece por `sap-sync:<tenant>:<configId>`). Más robusto
en abstracto, pero cambia la semántica de borrado para configs que hoy funcionan bien, incluidas las
INCREMENTAL que no tienen nada que ver con esto. Con el tope de 24 la lista fija de nombres logra lo
mismo sin tocar esa semántica.

**Sufijo por hora** (`:0700`) en vez de por índice. Más legible en el dashboard de colas, pero
convierte el conjunto de nombres posibles en algo abierto, y entonces el borrado vuelve a depender de
saber qué había antes.
