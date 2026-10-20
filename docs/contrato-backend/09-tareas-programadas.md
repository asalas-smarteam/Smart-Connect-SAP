# 09. Tareas programadas (J1 a J5)

Pedido del front, plan 4r (`docs/plans/2026-10-20-panel-tareas-programadas.md`). Reglas comunes en
[`00-reglas-generales.md`](00-reglas-generales.md). **Solo lectura.** Fuente: la colección
`ClientConfigs` del tenant (en el panel se llaman "tareas programadas").

## J1. Endpoints

- Cliente: `GET /scheduled-tasks` (las de su empresa).
- Smarteam: `GET /staff/tenants/:tenantKey/scheduled-tasks` (`tenantKey` inexistente → 404, como
  Eventos, Syncs y Mapeo de campos).
- Sin paginar ni filtros: **todas** las tareas de la empresa, activas e inactivas, en
  `{ "items": [...] }`. Orden: activas primero, después por nombre.
- El `id` es el mismo que ya devuelve `GET /sync-tasks` (E8): el front enlaza cada tarea a sus
  corridas con `/syncs?taskId=<id>`.

## J2. Cada tarea

```json
{
  "id": "6a6b9490cd7c01b21aa58c3e",
  "name": "Obtener Productos",
  "type": "record_sync",
  "objectType": "product",
  "sourcePath": "/Items",
  "mode": "full",
  "schedule": {
    "intervalMinutes": null,
    "times": ["07:00", "12:00", "15:00"],
    "days": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    "startTime": null,
    "endTime": null,
    "timeZone": "America/Costa_Rica"
  },
  "batchSize": 100,
  "associationsEnabled": false,
  "requireCrmIdUpdate": false,
  "filters": [
    {
      "property": "ItemsGroupCode",
      "operator": "in",
      "value": [101, 102, 105, 106, 107, 108],
      "isDefault": false,
      "isDynamic": false,
      "dynamicType": null,
      "editable": true
    }
  ],
  "orderBy": [{ "property": "DocDate", "direction": "desc" }],
  "active": false,
  "lastRunAt": "2026-09-22T21:42:33.950Z",
  "lastError": null
}
```

Correspondencia con lo guardado:

| Panel | Guardado | Nota |
|---|---|---|
| `id` | `_id` | texto |
| `name` | `clientName` | |
| `type` | `taskType` | mismo mapa que E8: `record_sync` / `dropdown_options` (sin valor → `record_sync`) |
| `objectType` | `objectType` | en minúsculas, como E5 |
| `sourcePath` | `serviceLayerPath` | nombre genérico; tal cual (`/Items`, `/Orders`) |
| `mode` | `mode` | `full` / `incremental` (minúsculas) |
| `schedule.intervalMinutes` | `intervalMinutes` | número o `null` |
| `schedule.times` | `executionTime` | lista `HH:mm`; `null` → `[]` |
| `schedule.days` | `executionDays` | en minúsculas (`monday`…); `null` → `[]` |
| `schedule.startTime` / `endTime` | `startTime` / `endTime` | `HH:mm` o `null` (ventana del intervalo) |
| `schedule.timeZone` | — | la zona del programador (`America/Costa_Rica`), para mostrar "hora de Costa Rica" |
| `batchSize` | `hubspotBatchSize` | nombre genérico |
| `associationsEnabled` | `associationFetchEnabled` | booleano; **no** se manda `associationFetchConfig` |
| `requireCrmIdUpdate` | `requireUpdateHubspotID` | nombre genérico |
| `filters[]` | `filters` | `property`, `operator`, `value`, `isDefault`, `isDynamic`, `dynamicType` (o `null` si no es dinámico), `editable` |
| `orderBy[]` | `orderBy` | `property`, `direction` |
| `active` | `active` | |
| `lastRunAt` | `lastRun` | ISO o `null` |
| `lastError` | `lastError` | texto o `null`; **para cliente, saneado** como los errores de Syncs (G4) |

## J3. Lo que nunca sale

`integrationModeId`, `hubspotCredentialId`, `apiUrl`, **`apiToken`**, **`sqlQuery`**,
`storeProcedureName`, `updateMethod`, `updateSpName`, `updateTableName`, `associationFetchConfig`,
`__v` ni ningún otro campo interno. Ni para Smarteam.

## J4. Permiso

Permiso nuevo `tasks.read` en `src/domain/panel/permissions.js` para admin y usuario del cliente y
para Smarteam; debe salir en `/auth/me`. Sin el permiso → 403 `forbidden`.

## J5. Notas

- Las corridas de la cola de eventos (G1) no son una `ClientConfig`: no van en esta lista.
- Si el programador guarda la próxima ejecución, se puede agregar `nextRunAt` (ISO o `null`)
  opcional; el front lo muestra si viene.

## Nota del backend (plan 7)

Plan: `docs/superpowers/plans/2026-10-20-panel-tareas-programadas.md`. Implementado J1 a J5, solo lectura.

- Rutas, permiso y forma de cada tarea como arriba. `tasks.read` sale en `/auth/me` para admin,
  usuario y Smarteam. Cuenta cliente en la ruta de staff (o al revés) → 403 `forbidden`.
- La base se lee con una **lista blanca** de campos: lo de J3 (y cualquier campo que se agregue
  al modelo después) no sale de la base, ni para Smarteam.
- Si falta un campo, va el default del modelo (`mode` → `incremental`, `batchSize` → 1,
  `active` → `false`, listas → `[]`). Textos vacíos (`''`) → `null`. `type` desconocido → `null`,
  como E8.
- `lastError`: Smarteam lo ve crudo; el cliente, saneado como en Syncs (G4).
- `sourcePath`: tal cual. Para el cliente, si por error trajera esquema y host (`https://…`), sale
  solo la ruta.
- `schedule.timeZone`: siempre `America/Costa_Rica`. Aplica a las horas (`times`) y a la ventana
  (`startTime`/`endTime`); el intervalo simple corre "cada N minutos".
- **`nextRunAt` (J5): sí viene**, ISO o `null`.
  - Sale del programador (BullMQ): la próxima ejecución más cercana de la tarea.
  - Es `null` si la tarea está inactiva o no tiene programación.
  - También es `null` si el programador no respondió a tiempo (1,5 s). La lista sale igual.
- Timeout de la consulta (5 s) → 400 `validation_error`. Tope de 1000 tareas por empresa.
