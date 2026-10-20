# Tableros y métricas (endpoints de resumen)

Supuestos **F1 a F9** del plan 4e del panel (`docs/plans/2026-10-13-panel-rediseno-tableros.md`, §2). Son endpoints **nuevos** que el spec no tenía: alimentan el **Inicio** del cliente ("Estado de la integración") y las **Métricas de soporte**. Reglas comunes en [`00-reglas-generales.md`](00-reglas-generales.md); estados y nombres genéricos de eventos en [`03-eventos-y-syncs.md`](03-eventos-y-syncs.md); tickets en [`02-soporte.md`](02-soporte.md).

Se pueden construir **después** de los planes 1 a 3: el panel ya funciona con la API simulada, que calcula exactamente estas respuestas desde sus datos de ejemplo.

## Rutas

| Endpoint | Permiso | Uso |
|---|---|---|
| `GET /panel/api/dashboard/integration?from=&to=&tz=` | `events.read` | Inicio del cliente (su empresa). |
| `GET /panel/api/staff/tenants/:tenantKey/dashboard/integration?from=&to=&tz=` | `events.read` (Smarteam) | Lo mismo, eligiendo la empresa. |
| `GET /panel/api/tickets/metrics?from=&to=&tz=` | `tickets.read` | Métricas de soporte del cliente (su empresa). |
| `GET /panel/api/staff/tickets/metrics?from=&to=&tz=&tenantKey=&category=` | `staff.tickets` | Métricas de Smarteam (todas las empresas o una). |

- Mismas reglas de alcance que Eventos (E10): ruta de cliente con el tenant de la sesión; `/staff/...` solo Smarteam; empresa inexistente → `404 not_found`; suspendidas consultables.
- Sin paginar: son resúmenes de tamaño acotado.

---

## F1. Resumen de integración

Ver rutas. `from` y `to` como en E3 (ISO UTC, `from` inclusivo, `to` exclusivo), pero aquí son **obligatorios**: sin ellos, `400 validation_error`.

## F2. Cuerpo del resumen de integración

```json
{
  "period": { "from": "2026-09-12T06:00:00.000Z", "to": "2026-10-12T06:00:00.000Z", "tz": "America/Costa_Rica" },
  "totals": {
    "documents": 471,
    "created": 412,
    "errored": 46,
    "pending": 13,
    "references": 386,
    "referencesWithoutDocument": 18,
    "avgDurationSeconds": 102,
    "avgDurationCreatedSeconds": 48,
    "oldestPendingAt": "2026-10-12T05:54:00.000Z"
  },
  "byDay": [
    { "date": "2026-10-05", "created": 20, "errored": 2, "pending": 0 },
    { "date": "2026-10-06", "created": 22, "errored": 9, "pending": 0 }
  ],
  "causes": [
    { "key": "fiscal_id_incomplete", "label": "Identificación fiscal incompleta", "group": "fiscal_data", "count": 11 },
    { "key": "other", "label": "Otro error", "group": "other", "count": 1 }
  ],
  "groups": [
    { "key": "deal_data", "count": 14 },
    { "key": "fiscal_data", "count": 11 }
  ],
  "multiAttempt": {
    "total": 12,
    "items": [
      {
        "reference": "18374652901",
        "title": "Renovación equipos Xela",
        "attempts": 4,
        "resolvedAfterSeconds": 7800,
        "steps": [
          { "at": "2026-10-06T15:12:00.000Z", "status": "errored", "summary": "Identificación fiscal incompleta", "documentNumber": null },
          { "at": "2026-10-06T17:22:00.000Z", "status": "completed", "summary": "Documento creado", "documentNumber": "5024831" }
        ]
      }
    ]
  }
}
```

- `references`: referencias (negocios) distintas con al menos un documento en el período. `referencesWithoutDocument`: de esas, las que no tienen ningún documento creado.
- `oldestPendingAt`: `createdAt` del documento pendiente más antiguo, o `null`.
- `causes` ordenadas por `count` descendente (empate: `other` al final y luego por `label`); solo causas con `count > 0`. `groups` igual (empate: en el orden de F5), con los grupos que tengan errores.
- `avgDurationSeconds`: promedio de los documentos **terminados** (creados y con error; los pendientes no tienen duración todavía). `avgDurationCreatedSeconds`: solo los creados. En segundos (enteros) o `null` sin datos.

## F3. Qué cuenta como creado, error y pendiente

| Grupo | Estados (genéricos, E1) |
|---|---|
| `created` | `completed`, `destination_created`, `destination_created_origin_error` (el documento existe en destino) |
| `errored` | `errored` |
| `pending` | `waiting`, `in_process` |

Reportes de calidad excluidos. `documents = created + errored + pending`. Duración de un documento = `updatedAt − createdAt`.

## F4. Días en la zona horaria del usuario

- `tz`: zona IANA del navegador (`America/Costa_Rica`). Si falta o es inválida: `400 validation_error`.
- `byDay` agrupa por **día local** y trae **todos** los días del período, los vacíos con ceros, en orden ascendente.
- Período máximo: 366 días (si no, `400 validation_error`). Para 90 días el front agrupa por semana; el backend siempre entrega días.

## F5. Causas de error: catálogo en el backend

- El backend clasifica cada `lastError` con un **catálogo de reglas** propio (expresión → `key`, `label`, `group`). El front **no** clasifica: solo dibuja lo que llega.
- `label`: texto genérico en español, **sin nombres de sistemas** (la regla de nombres del spec aplica también aquí).
- `group` (fijos): `deal_data` (datos del negocio), `fiscal_data` (datos fiscales), `destination_validation` (validación del destino), `master_blocked` (maestro bloqueado), `connectivity` (conectividad), `other`.
- Lo que no calza con ninguna regla: `{ "key": "other", "label": "Otro error", "group": "other" }`. Un backend sin catálogo todavía puede devolver todo así y el tablero funciona.
- Catálogo de ejemplo que usa la API simulada (para arrancar): `src/mocks/error-causes.js` del repo del panel.

## F6. Negocios con más de un intento

- Referencias con 2 o más documentos en el período. `multiAttempt.total`: cuántas son; `items`: hasta 10, las de más intentos primero (empate: la más reciente).
- `title`: nombre del negocio (hoy `payload.deal.dealname`), o `null`.
- `resolvedAfterSeconds`: del primer intento al primer documento creado, o `null` si ninguno se creó.
- `steps` en orden cronológico: `status` genérico (E1), `summary` = `label` de la causa (F5) para errores, `"Documento creado"` para creados, `"En proceso"` para pendientes; `documentNumber` = número del documento creado si se conoce (hoy en la auditoría), o `null`.

## F7. Métricas de tickets

Ver rutas. `tenantKey` y `category` opcionales en la de Smarteam (filtran; empresa inexistente → `404 not_found`, categoría desconocida → `400 validation_error`). `from`, `to`, `tz` obligatorios, como en F1/F4.

> Rutas: `GET /tickets/metrics` y `GET /staff/tickets/metrics` deben registrarse **antes** que `GET /tickets/:id` (o validar el id), para que `metrics` no se tome como un id de ticket.

## F8. Cuerpo de las métricas de tickets

```json
{
  "period": { "from": "...", "to": "...", "tz": "America/Costa_Rica" },
  "totals": {
    "resolved": 64,
    "resolvedPreviousPeriod": 52,
    "reopened": 4,
    "open": 11,
    "openWithoutFirstResponse": 3,
    "medianFirstResponseSeconds": 4800,
    "medianResolutionSeconds": 34800
  },
  "byWeek": [
    { "weekStart": "2026-09-28", "resolved": 6, "reopened": 0, "medianResolutionSeconds": 14400 }
  ],
  "buckets": [
    { "key": "lt4h", "count": 18 },
    { "key": "4h_24h", "count": 25 },
    { "key": "1d_3d", "count": 15 },
    { "key": "gt3d", "count": 6 }
  ],
  "byCategory": [
    { "category": "documentos", "resolved": 22, "medianResolutionSeconds": 21600 }
  ],
  "byTenant": [
    { "tenantKey": "acme", "companyName": "Acme Industrial", "resolved": 28, "medianFirstResponseSeconds": 3480, "medianResolutionSeconds": 29400, "reopened": 2, "open": 5 }
  ]
}
```

- `byTenant` **solo** en la ruta de Smarteam (nunca en la del cliente): una fila por empresa del alcance (todas, o la de `tenantKey`), por `resolved` descendente. Sus campos se calculan igual que los `totals` de esa empresa.
- `byWeek`: todas las semanas del período (vacías en cero), ascendente. Para 12 meses el front agrupa por mes.
- `buckets`: siempre los 4, en ese orden. `byCategory`: solo categorías con resueltos, por `resolved` descendente.
- `resolvedPreviousPeriod`: resueltos en el período de igual largo inmediatamente anterior.
- `reopened`: tickets resueltos en el período que tienen `reopenCount > 0`. `open` y `openWithoutFirstResponse`: estado **actual** (no dependen del período).

## F9. Cómo se miden los tiempos

- Tiempo corrido (no horario hábil), en segundos.
- **Resolución:** de `openedAt` a la **última** resolución (`resolvedAt`), para los tickets que **hoy están resueltos** y cuya última resolución cae dentro del período. Un ticket reabierto que sigue abierto no cuenta como resuelto (cuenta en `open`).
- **Primera respuesta:** `firstResponseAt − openedAt`, para los tickets abiertos dentro del período que ya tienen primera respuesta.
- Medianas: `null` sin datos. Semanas desde el **lunes**, en `tz`; `weekStart` es la fecha local del lunes.
