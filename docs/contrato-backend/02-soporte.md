# Soporte: tickets (plan 2 del backend)

Supuestos **D1 a D12** del plan 4b del panel. Rutas, permisos, estados, transiciones, límites e índices son los del spec (§2 Soporte); aquí se fija la **forma** de las respuestas. Reglas comunes en [`00-reglas-generales.md`](00-reglas-generales.md).

## Valores

- `status`: `abierto`, `en_progreso`, `esperando_cliente`, `resuelto`.
- `category`: `sincronizacion`, `documentos`, `precios`, `mapeos`, `acceso`, `otro`.
- `authorType` / `byType`: `cliente`, `smarteam` (`ia` reservado, no se usa en la Fase 1).

---

## D1. Ítem de la lista del cliente

`GET /panel/api/tickets?status=&category=&page=&pageSize=` → `{ items, page, pageSize, total }` con:

```json
{
  "id": "6711b2c3d4e5f60123456789",
  "code": "ACME-0007",
  "title": "La cotización no llegó",
  "category": "documentos",
  "status": "esperando_cliente",
  "createdBy": { "name": "Mario Quesada", "role": "usuario" },
  "openedAt": "2026-10-10T14:00:00.000Z",
  "lastActivityAt": "2026-10-11T09:30:00.000Z",
  "resolvedAt": null,
  "reopenCount": 0,
  "hasNews": true,
  "contextType": "webhookEvent"
}
```

- `hasNews` desde el lado del cliente: último mensaje público de Smarteam y posterior a `clientLastSeenAt`.
- `contextType`: `null` si el ticket no tiene contexto.
- **Nunca** `messages` ni `internalResolution` en la lista.

## D2. Ítem de la bandeja de Smarteam

`GET /panel/api/staff/tickets?status=&tenantKey=&category=&page=&pageSize=`:

```json
{
  "items": [
    {
      "...": "todo lo de D1",
      "tenantKey": "ACME",
      "companyName": "Acme Industrial",
      "firstResponseAt": "2026-10-10T15:10:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 25,
  "total": 58,
  "warnings": [{ "tenantKey": "GLOBEX", "error": "No se pudo consultar la base del tenant" }]
}
```

- `hasNews` **desde el lado de Smarteam**: último mensaje público del cliente y posterior a `staffLastSeenAt` (o ticket nuevo que nadie de Smarteam abrió).
- `warnings` puede faltar o venir vacío. `firstResponseAt` en `null` si nadie respondió.

## D3. Detalle

`GET /panel/api/tickets/:id` (cliente) y `GET /panel/api/staff/tenants/:tenantKey/tickets/:id` (Smarteam):

```json
{
  "...": "todo lo de D1",
  "description": "Texto del cliente",
  "attachments": [
    { "fileId": "6711c9...", "filename": "captura.png", "contentType": "image/png", "size": 48213 }
  ],
  "firstResponseAt": "2026-10-10T15:10:00.000Z",
  "context": {
    "type": "webhookEvent",
    "refId": "6711a0...",
    "snapshot": { "type": "createQuotation", "status": "errored", "lastError": "..." }
  },
  "messages": ["ver D4"],
  "statusHistory": ["ver D5"]
}
```

- `attachments`: las imágenes enviadas **al crear** el ticket (las de cada respuesta van en su mensaje, D4). Lista vacía si no hay. Se sirven con la misma URL de D10.
- `context` en `null` si no tiene. `snapshot` es libre (el front lo muestra como JSON).
- En el detalle de **Smarteam** se agregan `tenantKey`, `companyName` e:

```json
"internalResolution": {
  "text": "FieldMapping apuntaba al campo equivocado; se corrigió.",
  "updatedAt": "2026-10-11T10:00:00.000Z",
  "updatedBy": { "name": "Equipo Smarteam" }
}
```

  (`null` si no hay). **`internalResolution` nunca aparece en ninguna respuesta a una cuenta `cliente`.**

## D4. Mensaje

```json
{
  "id": "6711c3...",
  "authorType": "smarteam",
  "authorName": "Equipo Smarteam",
  "body": "Lo estamos revisando.",
  "attachments": [
    { "fileId": "6711c4...", "filename": "captura.png", "contentType": "image/png", "size": 48213 }
  ],
  "createdAt": "2026-10-10T15:10:00.000Z"
}
```

- Orden cronológico ascendente. La descripción del ticket **no** va como mensaje (el front la muestra aparte).

## D5. Entrada de `statusHistory`

```json
{ "from": "en_progreso", "to": "esperando_cliente", "byType": "smarteam", "byName": "Equipo Smarteam", "at": "2026-10-10T16:00:00.000Z" }
```

- La creación va como `{ "from": null, "to": "abierto", "byType": "cliente", ... }`.
- Cada reapertura y cada resolución quedan como entradas (el front arma la línea de tiempo con esto, `openedAt`, `firstResponseAt`, `resolvedAt` y `reopenCount`).

## D6. Campos multipart

| Ruta | Campos de texto | Imágenes |
|---|---|---|
| `POST /panel/api/tickets` | `title`, `description`, `category`, `contextType?`, `contextId?` | `images` |
| `POST .../messages` (cliente y Smarteam) | `body` | `images` |
| `POST .../resolve` | `message`, `internalResolution` | `images` |

- Las imágenes van en el campo **`images`, repetido una vez por archivo** (no `images[]`).
- `reopen`, `status` e `internal-resolution` van en JSON, como dice el spec.

## D7. Respuesta de crear

- **201** con al menos `{ "id": "...", "code": "ACME-0008" }` (se recomienda el detalle completo de D3).
- El front navega a `/soporte/:id` con ese `id` y avisa el `code`.
- Las demás mutaciones (`messages`, `reopen`, `status`, `resolve`, `internal-resolution`): el front no usa el cuerpo y vuelve a pedir el detalle. Se recomienda devolver el detalle actualizado.

## D8. Resumen de la bandeja

`GET /panel/api/staff/tickets/summary`:

```json
{
  "byStatus": { "abierto": 4, "en_progreso": 7, "esperando_cliente": 2, "resuelto": 45 },
  "byTenant": [
    { "tenantKey": "ACME", "companyName": "Acme Industrial", "byStatus": { "abierto": 2, "en_progreso": 3, "esperando_cliente": 1, "resuelto": 20 } }
  ]
}
```

- Las cuatro claves de `byStatus` siempre presentes (con 0 si no hay).

## D9. Códigos de error propios de Soporte

| Código | Status | Cuándo |
|---|---|---|
| `invalid_transition` | 409 | Transición no permitida (incluye resolver un ticket ya resuelto o reabrir uno que no lo está). |
| `too_many_images` | 400 | Más de 5 imágenes en un mensaje. |
| `invalid_image` | 400 | Tipo no permitido según los bytes (solo PNG, JPEG, WebP; SVG nunca). |
| `image_too_large` | 413 | Imagen de más de 5 MB. |
| `page_window_exceeded` | 400 | Bandeja con `page × pageSize` > 1000. |
| `validation_error` | 400 | Falta un texto obligatorio o supera el largo (`message` legible). |
| `not_found` | 404 | Ticket, imagen, evento o sync que no existe **o es de otro tenant**. |

## D10. URL de las imágenes

- El front arma la URL con los ids que ya tiene:
  - cliente: `/panel/api/tickets/:id/attachments/:fileId`
  - Smarteam: `/panel/api/staff/tenants/:tenantKey/tickets/:id/attachments/:fileId`
- Se piden desde `<img>` con la cookie de sesión (mismo origen). Cabeceras del spec: `Content-Type` detectado, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Cache-Control: private`.

## D11. Contexto al crear

- `contextType`: `webhookEvent` o `syncLog`.
- `contextId`: el `id` genérico del evento o de la sync, el mismo que devuelven las listas de eventos y syncs (plan 3).
- Si no existe en la base del tenant de la sesión: **404** `not_found`.

## D12. Orden

- Lista del cliente y bandeja: `lastActivityAt` descendente.
