# Ajustes del backend por el plan 5 (hallazgos del front, tableros y métricas)

Cambios que el backend hace en `/panel/api` por el plan 5 (`docs/superpowers/plans/2026-10-14-panel-tableros-y-ajustes.md`). Complementan `03-eventos-y-syncs.md` y `05-tableros-y-metricas.md`. **El core no cambia: los datos se guardan igual que antes; solo cambia lo que la API del panel entrega.**

Identificadores: **G1 a G6**.

## G1. Corridas de la cola de eventos (hallazgo 1)

- Las corridas sin tarea son las vueltas del procesador de la cola de webhooks (una por minuto y por empresa). Ahora salen con:
  ```json
  "task": { "id": "event_queue", "name": "Cola de eventos", "type": "event_queue" }
  ```
- `GET /sync-tasks` (y la ruta de staff) agrega ese ítem **al final** de la lista.
- `GET /syncs?taskId=event_queue` filtra esas corridas.
- **Ajuste en el front:**
  - `task.type` acepta `event_queue` además de `record_sync` y `dropdown_options`;
  - `task.id` puede ser `"event_queue"` (no es un id de 24 hex);
  - `task` sigue pudiendo ser `null` si la tarea de una corrida fue borrada.

## G2. Ocultar corridas vacías (hallazgo 2)

- `GET /syncs?hideEmpty=true` (y la ruta de staff): solo corridas con `counts.processed > 0`.
- `hideEmpty=false` o ausente: todas. Otro valor → `400 validation_error`.
- Las corridas vacías se siguen guardando (el worker no cambia).

## G3. Errores de eventos para cuentas cliente (hallazgo 3)

- Todos los eventos (cliente y staff) suman `cause`:
  ```json
  "cause": { "key": "item_not_found", "label": "Artículo inexistente en destino", "group": "destination_validation" }
  ```
  - `null` si el evento no tiene `lastError`;
  - mismas causas y grupos que F5.
- **Rutas de cliente:** `lastError` llega **saneado**:
  - sin IPs, servidores, puertos, URLs ni correos (reemplazados por `[servidor]`, `[enlace]`, `[correo]`);
  - sin prefijos técnicos como `AxiosError:`;
  - los nombres de sistemas pasan a "el ERP" y "el CRM";
  - si la causa es de conectividad, el texto es directamente la etiqueta (por ejemplo "No se pudo conectar con el sistema destino.").
- **Rutas de staff:** `lastError` crudo, como antes.

## G4. Errores de corridas para cuentas cliente (hallazgo 3)

- **Rutas de cliente:**
  - `errorMessage` de texto → saneado como en G3;
  - `errorMessage` objeto o lista → `{ "summary": "N error(es) en la corrida" }`, porque hoy las corridas de la cola guardan ahí payloads y respuestas internas;
  - `errors.items` (detalle) → cada ítem como `{ "record": "<texto o null>", "message": "<texto saneado o null>" }`.
- **Rutas de staff:** `errorMessage` y `errors.items` crudos, como antes.
- **Ajuste en el front:** en la vista de cliente, `errorMessage` puede ser texto, `{ summary }` o `null`, y los ítems de errores siempre tienen la forma `{ record, message }`.

## G5. Contexto de tickets

- El `snapshot` de un ticket **nuevo** creado desde un evento o una sync se guarda con la vista de cliente (G3, G4), porque el cliente lo ve. Incluye `cause` en los eventos.
- Los tickets creados antes guardaron el snapshot crudo. Al responder a una cuenta cliente, la API lo **vuelve a sanear al leerlo**: `lastError` como en G3, `errorMessage` como en G4, y sin `errors`, `payload` ni auditoría. Smarteam ve el snapshot tal como se guardó.

## G6. Tableros y métricas (contrato 05)

Se implementan tal como dice `05-tableros-y-metricas.md` (F1 a F9), con estas precisiones:
- **Período inválido** (falta `from`, `to` o `tz`; `to <= from`; más de 366 días; zona inválida): `400 validation_error` con "Período o zona horaria inválidos.".
- **`GET /dashboard/integration`:**
  - si el período tiene más de 20 000 eventos → `400 validation_error` "El período tiene demasiados eventos; acórtalo.";
  - si la consulta pasa de 5 s → el mismo 400 de tiempo agotado de los eventos.
- **`documentNumber` (F6):** hoy sale del número de documento que guarda la auditoría en B1. Si no está (por ejemplo en otra versión del ERP), sale `null`.
- **`GET /staff/tickets/metrics`:** puede traer `warnings: [{ tenantKey, error }]` si una empresa no respondió (campo extra; se puede ignorar).
- **`tenantKey`** sigue siendo el valor completo (`sap_integration_<slug>`): el slug público quedó **fuera** del plan 5.

## G7. Errores de las corridas de la Cola de eventos (plan 5b)

- Las corridas de la cola guardan el detalle de cada fallo en `errorMessage` y dejan `errors` vacío. El panel deriva `errors.items` de esa lista (lo guardado no cambia):
  ```json
  "errors": {
    "items": [
      { "record": "18374652901", "message": "El Correo Electrónico del Socio no puede ser omitido.", "eventId": "6711a0b1c2d3e4f501234567" }
    ],
    "page": 1, "pageSize": 25, "total": 1
  }
  ```
  - `record`: el id del negocio, o `null` (por ejemplo cuando cae el procesador entero).
  - `message`: saneado para el cliente; crudo para Smarteam. Si no hay mensaje: "Error sin detalle".
  - `eventId`: el id del evento fallido, cuando se puede identificar sin ambigüedad. Si no, `null`.
  - `total`: la cantidad de fallos guardados (coincide con `counts.failed`).
  - `errorsPage` y `errorsPageSize` funcionan igual.
- **Resumen para el cliente** (lista y detalle):
  - con mensaje: `"1 error en la corrida: <primer mensaje>"` o `"3 errores en la corrida: <primer mensaje>"`;
  - sin mensaje: `"N error(es) en la corrida"`.
- **Ajuste en el front:** los ítems de `errors` pueden traer `eventId` (string o `null`). Los ítems de las demás corridas siguen como `{ record, message }`.

