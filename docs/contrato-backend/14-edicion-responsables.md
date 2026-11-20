# 14. Edición del mapeo de responsables (O1 a O6)

Pedido del front, plan 5c (`docs/plans/2026-11-20-panel-edicion-responsables.md`). Reglas comunes
en [`00-reglas-generales.md`](00-reglas-generales.md). Extiende
[`13-mapeo-responsables.md`](13-mapeo-responsables.md) (lectura, N1 a N4), que no cambia.

Alcance, decidido con Smarteam:

- Desde el panel **solo se editan dos campos**: el vendedor (`sapOwnerId` → `erpOwnerId`) y el
  empleado digitador (`sapOwnerId_2` → `erpEmployeeId`).
- **No hay crear ni borrar** desde el panel. Las filas nuevas salen de **volver a correr la carga
  de responsables del CRM** (la misma del seed), ahora bajo demanda.
- Cada cambio queda en un **historial dentro de la base de cada tenant**.
- **No se valida contra el ERP** que el vendedor o el empleado existan: es una decisión tomada, el
  riesgo lo asume el cliente y el panel se lo avisa antes de guardar.
- La API admin actual (`/mappings/owners` con `INTERNAL_KEY`) **no se toca**.

## O1. Permiso nuevo `owners.write`

- En `src/domain/panel/permissions.js`: `OWNERS_WRITE: 'owners.write'` para **Smarteam** y para el
  rol **`admin`** del cliente. **No** para el rol `usuario`.
- Sale en `/auth/me` como los demás. Las rutas de O2 y O3 lo exigen; sin él → 403 `forbidden`.
- La lectura (N1) sigue con `mappings.read`.

## O2. Editar: `PATCH`

- Cliente: `PATCH /owner-mappings/:id`.
- Smarteam: `PATCH /staff/tenants/:tenantKey/owner-mappings/:id` (`tenantKey` inexistente → 404).
- El `id` debe ser de la empresa del pedido; si no existe ahí → 404 `not_found` (nunca se confirma
  que exista en otra empresa).
- Exige `X-Panel-Request: 1`, como toda mutación del panel.

Cuerpo:

```json
{
  "erpOwnerId": "113,758",
  "erpEmployeeId": "70",
  "expectedUpdatedAt": "2026-07-03T02:03:51.125Z"
}
```

| Campo               | Reglas                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `erpOwnerId`        | Opcional. `null` o `""` → se guarda `null`. Si no: texto (o número) que, sin espacios, cumple `^\d+(,\d+)*$` y mide ≤ 100. Un entero o varios separados por coma. |
| `erpEmployeeId`     | Opcional. `null` o `""` → `null`. Si no: un solo entero, `^\d{1,18}$`. Sin comas.                   |
| `expectedUpdatedAt` | **Obligatorio.** El `updatedAt` que el front leyó de la fila (control de versión).                 |

- Debe venir al menos uno de `erpOwnerId` o `erpEmployeeId`. El front manda siempre los dos.
- **Cualquier otro campo en el cuerpo → 400** `validation_error` (no se ignora en silencio):
  `active`, `erpOwnerName`, `crmOwner*`, `source`, etc. no se editan desde el panel.
- Tipos no válidos (objeto, arreglo, booleano) → 400, nunca 500.
- Se guarda como texto normalizado (sin espacios), igual que hoy los castea el modelo.
- **Control de versión:** si `expectedUpdatedAt` no coincide con el `updatedAt` actual → 409
  `stale_update` y no se escribe. Hacerlo atómico: el `findOneAndUpdate` filtra por `_id` **y**
  `updatedAt`.
- **Vendedor repetido:** si el índice único `uniq_sap_owner_mapping_partial` rechaza el valor
  (E11000) → 409 `erp_owner_taken`.
- **Sin cambios reales** (los valores ya eran esos): 200 con la fila tal cual, **sin** tocar
  `updatedAt` y **sin** escribir historial.
- Respuesta 200: la fila con la forma de N2 (sin `hubspotCredentialId` ni `__v`).

Errores:

| Código                    | Status | Cuándo                                                        |
| ------------------------- | ------ | ------------------------------------------------------------- |
| `validation_error`        | 400    | Formato, campo no editable, falta `expectedUpdatedAt`.        |
| `unauthorized`            | 401    | Sin sesión.                                                   |
| `forbidden`               | 403    | Sin `owners.write` (o cuenta de cliente en ruta de Smarteam).  |
| `password_change_required`| 403    | Como en el resto del panel.                                   |
| `missing_panel_header`    | 403    | Falta `X-Panel-Request`.                                      |
| `not_found`               | 404    | `id` o `tenantKey` inexistente.                               |
| `stale_update`            | 409    | Otro cambió la fila antes.                                    |
| `erp_owner_taken`         | 409    | Ese vendedor ya está en otra fila de la misma credencial.     |

## O3. Traer del CRM los que faltan: `POST …/sync`

- Cliente: `POST /owner-mappings/sync`.
- Smarteam: `POST /staff/tenants/:tenantKey/owner-mappings/sync`.
- Sin cuerpo. Exige `X-Panel-Request: 1` y `owners.write`.

Qué hace: **reutiliza la carga inicial** (`tenantHubspotSeed.service.js` + `fetchOwners` de
`hubspotClient.js`), extraída a un caso de uso que también pueda llamar el panel:

1. Para **cada credencial del CRM del tenant** (así no hay que elegir una si hay varias, I4): usa
   su token y lo **renueva si venció** (`refreshAccessToken`).
2. Pide todos los responsables del CRM (paginado).
3. Por cada uno:
   - **No tiene fila** (`{ hubspotCredentialId, hubspotOwnerId }`) → la inserta igual que el seed:
     `sapOwnerId: null`, `sapOwnerId_2: null`, `active: true`, `source: 'hubspot_seed'`.
   - **Ya tiene fila** → solo actualiza `hubspotOwnerName` y `hubspotOwnerEmail` si cambiaron.
4. **Nunca** cambia `sapOwnerId`, `sapOwnerId_2`, `sapOwnerName`, `active` ni `source` de una fila
   existente, y **nunca borra** filas (aunque el responsable ya no esté en el CRM).

Respuesta 200:

```json
{ "added": 2, "updated": 1, "total": 9 }
```

`added`: filas insertadas; `updated`: filas con nombre o correo refrescado; `total`: filas de la
empresa después de sincronizar. Repetirlo sin cambios en el CRM da `added: 0, updated: 0`
(idempotente; un E11000 por carrera se trata como "ya existe").

Errores propios:

| Código              | Status | Cuándo                                                                       |
| ------------------- | ------ | ---------------------------------------------------------------------------- |
| `crm_unavailable`   | 502    | El CRM no respondió, el token no se pudo renovar o el tenant no tiene credencial. No se inserta nada a medias por credencial fallida: lo ya insertado de otras credenciales queda. |
| `too_many_requests` | 429    | Límite de frecuencia: **1 sincronización por minuto por tenant** (con `Retry-After`). |

Más los comunes de O2 (401, 403, 404).

## O4. Historial en la base de cada tenant

Colección nueva **`OwnerMappingHistory`** en la base de **cada tenant** (patrón nuevo; el modelo se
registra junto a los demás modelos del tenant). Un documento por cambio:

```json
{
  "mappingId": "6a6b94a1cd7c01b21aa58c41",
  "crmOwnerId": "82929225",
  "action": "updated",
  "changedBy": {
    "userId": "6a70…",
    "name": "Adriana Solís",
    "email": "admin@cliente.com",
    "accountType": "cliente"
  },
  "changedAt": "2026-11-20T15:04:05.000Z",
  "changes": [
    { "field": "erpOwnerId", "from": "53", "to": "113,758" },
    { "field": "erpEmployeeId", "from": "67", "to": "70" }
  ]
}
```

- **Quién** (`changedBy`: el usuario de la sesión del panel; `accountType` `cliente` o
  `smarteam`), **cuándo** (`changedAt`), **valor anterior** (`from`) y **valor nuevo** (`to`) por
  cada campo que cambió de verdad. `null` cuando no había o se quitó.
- `action`: `updated` (O2) o `synced_created` (cada fila que inserta O3, con `changes: []`).
- Solo se escribe si hubo cambio real. Los refrescos de nombre o correo de O3 no se registran.
- Solo inserciones: no se edita ni se borra. Sin TTL (se conserva).
- Índices: `{ mappingId: 1, changedAt: -1 }` y `{ changedAt: -1 }`.
- Orden de escritura en O2: primero el update de la fila (con el filtro de versión) y, si
  modificó, el historial. Si el historial falla, loguear con `error` (sin revertir) para poder
  reconstruirlo; no usar transacciones si el backend no las usa hoy.
- Opcional: además `owner_mapping.updated` / `owner_mapping.synced` en `PanelAuditLogs`, sin
  reemplazar esta colección.
- **El panel no lee el historial todavía**: no hace falta endpoint de lectura en esta entrega.

## O5. Forma sugerida en el backend

- Caso de uso propio del panel (por ejemplo `PanelOwnerMappingsWrite`) apoyado en
  `TenantOwnerMappingRepository`, **no** en `ManageOwnerMappings` (que toma la credencial del
  cuerpo, no valida y devuelve el documento entero).
- Vista de salida: la misma de N2.
- Tenant: `getTenantModels(tenantKey)` después de validar el tenant, como tickets y eventos.
- Antes de apoyarse en los índices únicos, revisar `getIndexes()` de `OwnerMappings` en cada
  tenant de producción (pueden faltar si había duplicados cuando se crearon).

## O6. Pruebas que esperamos

- Permisos: `usuario` del cliente → 403 en O2 y O3; `admin` y Smarteam pueden; cliente no llega a
  filas de otra empresa (404).
- O2: normaliza espacios; `""` y `null` guardan `null`; lista con comas en vendedor sí, en
  empleado no; campo no editable → 400; tipos raros → 400 (no 500); sin `expectedUpdatedAt` → 400;
  `stale_update`; `erp_owner_taken`; sin cambios reales no toca `updatedAt` ni historial.
- O3: inserta solo los que faltan; refresca nombre y correo; no toca los códigos del ERP ni
  `active`; no borra; idempotente; renueva el token; `crm_unavailable`; límite de 1 por minuto.
- O4: un documento por cambio real con quién, cuándo, `from` y `to`; `synced_created` por cada
  fila nueva; queda en la base del tenant correcto.

## Despliegue

Front y backend juntos: los botones "Editar" y "Actualizar responsables del CRM" aparecen en
cuanto `/auth/me` trae `owners.write`, y dependen de O2 y O3.

## Nota del backend (plan 12)

Plan: `docs/superpowers/plans/2026-11-20-14-edicion-responsables.md`. Implementado O1 a O4.

- `owners.write` sale en `/auth/me` para Smarteam y el rol `admin` del cliente; el rol `usuario` ya
  no tiene los mismos permisos que el admin.
- Errores 400 con `message` en español que nombra el campo no editable. `stale_update`,
  `erp_owner_taken`, `crm_unavailable` y `too_many_requests` traen `message`; el 429 trae
  `Retry-After: 60`.
- `expectedUpdatedAt` debe ser la fecha ISO que vino en `updatedAt` (N2). Una fila **sin**
  `updatedAt` (documento muy viejo, `updatedAt: null` en la lista) no se puede editar desde el panel
  hasta que tenga uno: el contrato lo exige y el backend responde 400.
- El `PATCH` sin cambios reales responde 200 con la fila tal cual. Con cambios, responde la fila
  nueva (vista N2): su `updatedAt` es el que hay que mandar en la siguiente edición.
- El `sync` recorre todas las credenciales del CRM del tenant. Si una falla responde 502, pero lo
  insertado con las otras queda. El refresco de nombre o correo **no** mueve `updatedAt` (no provoca
  `stale_update` en quien está editando). El límite cuenta cada intento, aunque falle.
- No hay endpoint de lectura del historial; tampoco se escribe en `PanelAuditLogs`.
