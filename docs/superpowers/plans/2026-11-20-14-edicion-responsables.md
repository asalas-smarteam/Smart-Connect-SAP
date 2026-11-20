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

## Ejecución (backend, plan 12)

Hecho O1 a O6 solo en la capa del panel. No se tocaron `tenantHubspotSeed.service.js`,
`hubspotClient.js`, `hubspotAuthService.js`, `models/tenant/*` ni su `index.js`,
`ManageOwnerMappings` ni la API admin `/mappings/owners`: solo se importan.

Archivos nuevos:

- `src/domain/panel/ownerMappingEdit.js`: `checkOwnerMappingPatch` (reglas de O2) y
  `diffOwnerMapping`.
- `src/application/ports/panel/owner-mapping-writer.port.js` (`OwnerMappingWriterPort`) y
  `crm-owner-directory.port.js` (`CrmOwnerDirectoryPort`).
- `src/application/use-cases/panel/PanelOwnerMappingsWrite.js`: `update` (O2 + O4) y `sync` (O3 + O4).
- `src/infrastructure/database/models/panel/OwnerMappingHistory.js` (colección
  `OwnerMappingHistory`, modelo `PanelOwnerMappingHistory`).
- `src/infrastructure/database/repositories/MongooseOwnerMappingWriter.js`.
- `src/infrastructure/hubspot/HubspotCrmOwnerDirectory.js`.
- Pruebas: `tests/unit/domain/panelOwnerMappingEdit.test.js`,
  `tests/unit/application/panel/panelOwnerMappingsWrite.test.js` (+ fakes en
  `ownerMappingWriteFakes.js`), `tests/unit/infrastructure/panelOwnerMappingAdapters.test.js`,
  `tests/integration/panelOwnerMappingsWrite.test.js`.

Archivos cambiados: `permissions.js` (`OWNERS_WRITE`), `panelReasons.js`, `panelErrors.js`,
`panelTenantModels.js`, `panelOwnerMappings.controller.js` (`update`, `sync`), `panelPlugin.js`
(4 rutas), `panel.composition.js`, y las pruebas `panelPermissions`, `sessionUseCases`,
`panelOwnerMappingsApi`, `routeAuthWiring`.

Decisiones:

- **Permiso:** `owners.write` para Smarteam y el `admin` del cliente; desde aquí admin y usuario
  difieren. Rutas de cliente con `requireClientAccount`, de staff con `requireStaffAccount`. `POST
  …/sync` y `PATCH …/:id` no chocan (distinto método).
- **Modelos del panel vía `getPanelTenantModels`**, sin tocar el registro central:
  `OwnerMapping` y `HubspotCredentials` con los factories del núcleo (reutilizan el modelo si la
  conexión ya lo tiene) y `OwnerMappingHistory`. Los tres son **perezosos** (getters): solo se
  registran cuando alguien los usa, para que leer tickets siga sin crear colecciones ni índices.
  `OwnerMappingHistory` tiene `autoIndex`/`autoCreate` apagados como `Tickets`; sus índices se
  crean con el primer documento de cada tenant (una vez por proceso, reintenta si falla).
- **Versión:** se compara `expectedUpdatedAt` con el `updatedAt` leído (409 directo si no
  coincide) y además el `findOneAndUpdate` filtra por `_id` y `updatedAt` (atómico). Si no
  modifica, se relee: existe → `stale_update`; no → 404. Al `updateErpCodes` solo van los campos
  que cambian.
- **E11000 del vendedor:** el adaptador lanza `ErpOwnerTakenError` (`code: 'ERP_OWNER_TAKEN'`) en
  vez de devolver un marcador, para que `null` signifique solo "versión distinta o no existe".
- **Historial:** después de escribir la fila; si falla, `logger.error` con `tenantKey`,
  `mappingId` y `action` (sin nombre ni correo) y se responde 200 igual. Sin transacciones.
- **Sync:** reutiliza `fetchOwners` (`hubspotClient.js`) y `hubspotAuthService.getAccessToken`
  (renueva si venció; se le pasa el `_id` de la credencial) **sin modificar el seed**. Por
  credencial: primero la lista completa del CRM (si falla, de esa no se inserta nada y se sigue con
  la siguiente); inserta faltantes igual que el seed (`sapOwnerId`, `sapOwnerId_2`,
  `sapOwnerName` en `null`, `active: true`, `source: 'hubspot_seed'`; E11000 = ya existía) con
  historial `synced_created`; refresca nombre/correo con `updateOne(..., { timestamps: false })`
  para **no mover `updatedAt`**. Al final, si alguna credencial falló → 502.
- **Límite:** `RedisLoginAttempts` con `keyPrefix: 'panel:ownersync:'`, `maxAttempts: 1`,
  `windowSeconds: 60` (clave por tenantKey, con respaldo en memoria si Redis no responde). Cuenta
  cada intento.
- Composición: `buildPanelOwnerMappingUseCases` arma también `ownerMappingsWrite`;
  `ownerMappingWriter`, `crmOwnerDirectory` y `ownerSyncAttempts` se pueden inyectar desde
  `buildPanelUseCases` (con `assertPort`; `ownerSyncAttempts: null` desactiva el límite). Nada
  abre conexiones al construirse.

Pendiente o no hecho:

- Auditoría opcional en `PanelAuditLogs` (`owner_mapping.updated` / `owner_mapping.synced`): no
  hecha; el historial por tenant cubre O4.
- **Revisar `getIndexes()` de `OwnerMappings` en cada tenant de producción** antes de desplegar:
  si falta `uniq_sap_owner_mapping_partial` (por duplicados al crearlo), el `PATCH` no puede dar
  `erp_owner_taken`; y si falta `uniq_hubspot_owner_mapping`, dos sincronizaciones simultáneas
  podrían duplicar una fila.
- Al compilarse por primera vez en una conexión, el modelo `OwnerMapping` del núcleo tiene
  `autoIndex` (igual que con `getTenantModels`): no es un comportamiento nuevo, pero el panel
  puede ser quien lo dispare en un tenant.
- Una fila sin `updatedAt` no se puede editar (el contrato exige `expectedUpdatedAt`).
