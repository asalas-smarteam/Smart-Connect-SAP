# Eventos y syncs (plan 3 del backend)

Supuestos **E1 a E10** del plan 4c del panel (`docs/plans/2026-10-13-panel-eventos-syncs.md`, §1.2). Rutas, permisos e índices son los del spec (§3 Eventos y syncs); aquí se fija la **forma** de las respuestas. Reglas comunes en [`00-reglas-generales.md`](00-reglas-generales.md).

Los nombres internos de los modelos (`WebhookEvent`, `SyncLog`, `ClientConfig`) **no salen tal cual**: la API los traduce a nombres genéricos (regla del spec: nada de nombres de sistemas en el panel).

## Rutas

| Endpoint | Permiso | Uso |
|---|---|---|
| `GET /panel/api/events?status=&type=&reference=&from=&to=&page=&pageSize=` | `events.read` | Eventos del tenant de la sesión. |
| `GET /panel/api/events/:id` | `events.read` | Detalle (nunca `payload` ni `audit`). |
| `GET /panel/api/staff/tenants/:tenantKey/events?…` | `events.read` (Smarteam) | Eventos de una empresa. |
| `GET /panel/api/staff/tenants/:tenantKey/events/:id` | `events.read` (Smarteam) | Detalle; suma `payload` y `audit` con `staff.events.raw`. |
| `GET /panel/api/syncs?taskId=&status=&from=&to=&page=&pageSize=` | `syncs.read` | Corridas del tenant de la sesión. |
| `GET /panel/api/syncs/:id?errorsPage=&errorsPageSize=` | `syncs.read` | Detalle con errores paginados. |
| `GET /panel/api/staff/tenants/:tenantKey/syncs[/:id]` | `syncs.read` (Smarteam) | Lo mismo por empresa. |
| `GET /panel/api/sync-tasks` | `syncs.read` | **Nuevo** (E8): tareas para el filtro. |
| `GET /panel/api/staff/tenants/:tenantKey/sync-tasks` | `syncs.read` (Smarteam) | **Nuevo** (E8), por empresa. |

- Las rutas de cliente usan **siempre** el tenant de la sesión; un `id` de otro tenant da `404 not_found`.
- Las rutas `/staff/...` son solo para cuentas Smarteam (sin `tenantKey`): una cuenta cliente recibe `403 forbidden`.
- El selector de empresa de Smarteam usa `GET /panel/api/staff/tenants` (C7). Eventos y Syncs también lo llaman, así que ese endpoint debe aceptar a cualquier cuenta Smarteam (hoy el mock acepta `staff.users`, `staff.tickets` o `staff.events.raw`).

---

## E1. Estados de evento con nombres genéricos

| Interno (`WebhookEvent.status`) | API (`status`) | Texto en el panel |
|---|---|---|
| `waiting` | `waiting` | En cola |
| `inprocess` | `in_process` | Procesando |
| `<sistema>_order_created` | `destination_created` | Creado en destino |
| `<sistema>_created_<origen>_error` | `destination_created_origin_error` | Creado en destino con error al actualizar el origen |
| `completed` | `completed` | Completado |
| `errored` | `errored` | Con error |
| `report` | — | **Nunca** aparece en `/events` (son reportes de calidad, otra pantalla en la Fase 3). |

- El filtro `?status=` usa los valores de la columna "API". Un valor desconocido da `400 validation_error`.
- Si el backend agrega un estado nuevo, se acuerda antes: el front valida con Zod y un valor desconocido se ve como `invalid_response`.

## E2. Tipo de evento

`type` es el `eventType` tal cual (`createDeal`, `createQuotation`, `updateQuotation`, `updateDealStage`, …). El front tiene etiquetas en español para los conocidos y muestra el valor crudo para los demás. El filtro `?type=` es igualdad exacta.

## E3. Fechas de los filtros

- `from` y `to` en ISO 8601 UTC. `from` **inclusivo**, `to` **exclusivo**.
- El front manda el inicio del día elegido y el inicio del día siguiente al "hasta", calculados en la hora del navegador y convertidos a UTC. Ejemplo (Costa Rica, UTC−6), del 5 al 7 de octubre: `from=2026-10-05T06:00:00.000Z&to=2026-10-08T06:00:00.000Z`.
- Eventos filtran por `createdAt`; syncs por `startedAt`.
- Fecha inválida: `400 validation_error`.

## E4. Referencia

`?reference=` filtra por **igualdad exacta** con `reference` (el id del negocio en el sistema de origen; hoy `payload.deal.<id del objeto>`). `reference` es `null` si el evento no lo trae.

## Evento (lista y detalle)

```json
{
  "id": "6711a0b1c2d3e4f501234567",
  "type": "createQuotation",
  "status": "errored",
  "retries": 3,
  "maxRetries": 3,
  "lastError": "El artículo ITEM-0042 no existe en el sistema destino.",
  "reference": "18374652901",
  "createdAt": "2026-10-10T14:00:00.000Z",
  "updatedAt": "2026-10-10T14:06:00.000Z"
}
```

- `lastError`: texto o `null`. `maxRetries`: el límite configurado (el front muestra `retries/maxRetries`).
- **Detalle de Smarteam con `staff.events.raw`** suma:

```json
{
  "...": "todo lo de arriba",
  "payload": { "deal": { "...": "lo que llegó en el webhook" } },
  "audit": { "...": "auditoría interna del procesamiento (hoy la del sistema destino)" }
}
```

  Sin `staff.events.raw`, y **siempre** en las rutas de cliente, `payload` y `audit` **no vienen** (ni como `null`). `audit` en `null` si el evento no tiene auditoría.

## E5. Tarea y objeto de una sync, con nombres genéricos

| Interno | API |
|---|---|
| `taskType: '<SISTEMA>_SYNC'` | `task.type: 'record_sync'` |
| `taskType: 'DROPDOWN_OPTIONS'` | `task.type: 'dropdown_options'` |
| `objectType: 'Product' \| 'Contact' \| 'Deal' \| 'Company' \| 'Invoice'` | `objectType: 'product' \| 'contact' \| 'deal' \| 'company' \| 'invoice'` (o `null`) |

`objectType` en minúsculas es un ajuste de este plan sobre lo que dice el spec (el panel lo muestra como Productos, Contactos, Negocios, Empresas, Facturas).

## E6. Sync en curso

`status` vale `completed`, `errored` o **`running`** (el interno es `null`: la corrida no terminó). Mientras corre, `finishedAt` es `null`. El filtro `?status=` acepta esos tres valores.

## Sync (lista)

```json
{
  "id": "6711d0e1f2a3b4c501234567",
  "task": { "id": "6711c0aa...", "name": "Productos", "type": "record_sync" },
  "objectType": "product",
  "status": "errored",
  "counts": { "processed": 120, "sent": 117, "failed": 3, "updated": 40, "skipped": 2 },
  "skippedReasons": [{ "reason": "Sin precio en la lista base", "count": 2 }],
  "errorMessage": "Tres productos sin precio en la lista base.",
  "startedAt": "2026-10-10T06:00:00.000Z",
  "finishedAt": "2026-10-10T06:04:12.000Z"
}
```

- `counts.processed` es `recordsProcessed`. `skippedReasons` es una lista vacía si no hay.
- `errorMessage` puede ser texto, objeto o `null` (el front muestra el objeto en el visor JSON).
- La lista **no** trae `errors`.

## E7. Errores del detalle de sync

`GET /panel/api/syncs/:id?errorsPage=1&errorsPageSize=25` → todo lo de la lista más:

```json
"errors": {
  "items": [{ "record": "ITEM-0042", "message": "Sin precio en la lista base" }],
  "page": 1,
  "pageSize": 25,
  "total": 3
}
```

- Cada ítem es **JSON libre** (lo que guardó la corrida). `errorsPageSize` máximo 100 (`400 validation_error`); por defecto 25.
- Si no hay errores: `{ "items": [], "page": 1, "pageSize": 25, "total": 0 }`.

## E8. Endpoint nuevo: tareas

`GET /panel/api/sync-tasks` (y `/staff/tenants/:tenantKey/sync-tasks`) → sin paginar:

```json
{ "items": [{ "id": "6711c0aa...", "name": "Productos", "type": "record_sync" }] }
```

- Sale de la configuración de tareas del tenant. **Solo** `id`, `name` (el nombre de la tarea) y `type` traducido (E5). Nunca credenciales ni otros campos de configuración.
- El filtro de syncs usa `?taskId=` con ese `id`.

## E9. Orden

Eventos por `createdAt` descendente; syncs por `startedAt` descendente.

## E10. Empresa en las rutas de Smarteam

- `:tenantKey` inexistente → `404 not_found`.
- Las empresas **suspendidas** se pueden consultar (para soporte).

## Contexto de tickets

El `contextId` que manda "Nuevo ticket" (D, `02-soporte.md`) es el `id` de estas respuestas, y "Reportar problema" lee el resumen del registro con `GET /panel/api/events/:id` o `/syncs/:id` antes de crear el ticket. El `snapshot` que guarda el ticket conviene que tenga la misma forma que estas respuestas (sin `payload`/`audit`/`errors`).
