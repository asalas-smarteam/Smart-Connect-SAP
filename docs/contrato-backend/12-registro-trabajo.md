# 12. Registro de trabajo desde Claude (M1 a M8)

Pedido del front, plan 4z (`docs/plans/2026-11-04-panel-registro-trabajo.md`). Reglas comunes en
[`00-reglas-generales.md`](00-reglas-generales.md). Se apoya en Soporte
([`02-soporte.md`](02-soporte.md), D3, D4 y D9) y **no cambia** ninguna forma existente salvo el
detalle de Smarteam (M6), que gana un campo.

Endpoints nuevos: tokens personales (`/account/api-tokens`), búsqueda de ticket por código y
publicación de un registro de trabajo (`/staff/tickets/by-code/:code/...`). Las rutas se escriben
como las ve el backend (`/panel/api/...`); el front y la skill las ven como `/api/...`.

## M1. Objetivo y flujo

Los devs de Smarteam usan una skill de Claude (`registro-tiempo`) al cerrar una tarea. La skill
publica en el ticket del panel **dos cosas en una sola llamada**:

- un **resumen para el cliente**: queda como respuesta pública de Smarteam (un mensaje más, D4);
- un **registro interno de horas**: horas, nota técnica y, opcional, el id del proyecto en el CRM.
  Solo lo ve Smarteam (M6). El cliente nunca ve horas.

Flujo:

```
Dev (una vez)        Panel ▸ Mi cuenta ▸ "Crear token"  → POST /account/api-tokens  → spn_… (se ve una sola vez)
                     lo guarda en la configuración de la skill

Skill, al cerrar     1. GET  /staff/tickets/by-code/PRINTER-0012           (Bearer spn_…)
                        → empresa, título y estado, para que el dev confirme que es el ticket correcto
                     2. el dev confirma resumen, nota, horas y si se resuelve
                     3. POST /staff/tickets/by-code/PRINTER-0012/work-log  (Bearer spn_…, Idempotency-Key)
                        → 201 con la entrada creada y el estado del ticket
```

Si el paso 3 se corta (red, timeout), la skill reintenta con la **misma** `Idempotency-Key` y no
se duplica nada (M5).

---

## M2. Tokens personales

Solo con **sesión de panel (cookie)**, cuenta `smarteam` y permiso `staff.tickets`. Un token
**no** sirve para administrar tokens. Cuenta `cliente` → 403 `forbidden`. Las mutaciones llevan
`X-Panel-Request: 1` como todas (00).

### Endpoints

`GET /panel/api/account/api-tokens`

```json
{
  "items": [
    {
      "id": "6729a1c0f1e2d3c4b5a69788",
      "name": "Claude Code - laptop",
      "prefix": "spn_a1b2",
      "createdAt": "2026-11-04T15:00:00.000Z",
      "lastUsedAt": null,
      "expiresAt": "2027-02-02T15:00:00.000Z"
    }
  ]
}
```

- Solo los tokens **del usuario de la sesión** que estén **activos**: ni revocados ni vencidos.
  Un token vencido deja de aparecer (el dev crea otro).
- Orden: `createdAt` descendente (el más nuevo primero). Sin paginar (son 5 como máximo).

`POST /panel/api/account/api-tokens` con
`{ "name": "Claude Code - laptop", "currentPassword": "…" }` →

```json
{
  "token": "spn_a1b2PS_CSLc3PsRJ0AuX9eCvOmSePN2v3yW4sWhVHYw",
  "item": {
    "id": "6729a1c0f1e2d3c4b5a69788",
    "name": "Claude Code - laptop",
    "prefix": "spn_a1b2",
    "createdAt": "2026-11-04T15:00:00.000Z",
    "lastUsedAt": null,
    "expiresAt": "2027-02-02T15:00:00.000Z"
  }
}
```

- **201**. El token en claro sale **solo en esta respuesta**; después es imposible recuperarlo
  (el backend no lo guarda).
- `name`: se recorta; de 1 a 60 caracteres. Si no → `400 validation_error` ("El nombre debe
  tener entre 1 y 60 caracteres."). Puede repetirse.
- `name` con **caracteres de control** (`\p{Cc}`: saltos de línea, tabulaciones, `\u0000`…) se
  **rechaza**, no se limpia → `400 validation_error` ("El nombre no puede tener saltos de línea ni
  caracteres especiales.").
- **`currentPassword` obligatorio** (decisión del producto): crear un token es entregar una
  credencial de 90 días, así que se vuelve a pedir la contraseña aunque haya sesión.
  - Ausente, vacío o no texto → `400 validation_error` ("Escribe tu contraseña actual.").
  - Incorrecta → **400** `{ "error": "invalid_current_password", "message": "La contraseña actual
    no es correcta." }`: el **mismo código, status y mensaje** que usa hoy
    `POST /auth/change-password` (`ChangePanelPassword` → `panelReasons.INVALID_CURRENT_PASSWORD`,
    contrato C2). Es 400 y no 401 porque el front trata todo 401 como sesión vencida.
  - Límite de intentos: hoy el cambio de contraseña **no** tiene un bloqueo por intentos propio;
    solo el límite de concurrencia del hasher (`ScryptPasswordHasher` + `ConcurrencyLimiter`:
    error `PANEL_HASHER_BUSY` → `429 too_many_attempts` con `Retry-After: 5`), que aplica igual
    aquí porque se usa el mismo hasher. Además se pide un límite nuevo: **5 contraseñas
    incorrectas cada 15 min por usuario** (`RedisLoginAttempts` con `keyPrefix:
    'panel:pwdcheck:'` y el id del usuario como clave) → `429 too_many_attempts` con
    `Retry-After`. Mientras está bloqueado no se verifica la contraseña. Se recomienda que
    `POST /auth/change-password` use el mismo contador (opcional, fuera de este plan).
  - Orden de las comprobaciones: validación de `name` y `currentPassword` → bloqueo por intentos →
    contraseña → límite de 5 tokens. Así `token_limit` no sirve para probar contraseñas.
  - Cambiar la propia contraseña **sigue manteniendo** los tokens (M7): el dueño los revoca desde
    la lista si quiere.
- Vence a los **90 días** (`expiresAt = createdAt + 90 d`). No se renueva: se crea otro.
- Máximo **5 tokens activos** por usuario. Con 5 → **409** `{ "error": "token_limit", "message":
  "Ya tienes 5 tokens activos. Revoca uno para crear otro." }`. Dos creaciones simultáneas
  pueden dejar 6 por un instante: es aceptable (no hace falta transacción).

`DELETE /panel/api/account/api-tokens/:id` → **204** sin cuerpo.

- Revoca (marca `revokedAt`; no borra el documento en el momento).
- `id` inválido, inexistente, de **otro usuario** o ya revocado → **404** `not_found` (no se
  confirma que exista).
- Rige en el request siguiente: el token revocado da `401 invalid_token`.

### Formato del token

- Exactamente: `spn_` (en minúsculas) + **43 caracteres base64url** que codifican **32 bytes**
  de `crypto.randomBytes(32)`, sin relleno `=` (`buffer.toString('base64url')`). Largo total:
  **47**. Ejemplo: `spn_a1b2PS_CSLc3PsRJ0AuX9eCvOmSePN2v3yW4sWhVHYw`.
- Regex (distingue mayúsculas): `^spn_[A-Za-z0-9_-]{43}$`. Se comprueba **antes** de calcular
  el hash y de ir a la base: lo que no cumple (largo distinto, `=`, `+`, `/`, prefijo `SPN_`,
  espacios) → `401 invalid_token` sin consulta.
- `prefix`: los **primeros 8 caracteres** del token (`spn_` + 4), solo para reconocerlo en la
  lista. No es único ni sirve para buscar.

### Almacenamiento

Colección nueva **`PanelApiTokens`** en la base master (junto a `PanelUsers` y
`PanelAuditLogs`):

| Campo | Tipo | Nota |
| --- | --- | --- |
| `_id` | ObjectId | es el `id` de la API |
| `userId` | ObjectId | dueño; índice `{ userId: 1, createdAt: -1 }` |
| `name` | texto | ≤ 60 |
| `tokenHash` | texto | **SHA-256 en hex del token completo** (con `spn_`); índice **único** |
| `prefix` | texto | 8 caracteres |
| `createdAt` | fecha | |
| `expiresAt` | fecha | `createdAt + 90 d` |
| `lastUsedAt` | fecha o `null` | M7 |
| `revokedAt` | fecha o `null` | |
| `revokedReason` | texto o `null` | `user`, `user_deactivated`, `password_reset` |
| `purgeAt` | fecha | índice TTL: `expiresAt + 30 d`; al revocar pasa a `revokedAt + 30 d` |

- **Nunca** se guarda el token en claro, ni en esta colección ni en ninguna otra.
- La búsqueda es por hash: `findOne({ tokenHash: sha256(token) })`. No hace falta comparación
  en tiempo constante (el atacante no controla el hash que se busca), pero tampoco molesta.
- Activo = `revokedAt: null` y `expiresAt > ahora`.

---

## M3. Autenticación con token

### Qué rutas aceptan token

**Solo dos**, marcadas en la ruta (por ejemplo `config: { panelTokenAuth: true }`):

- `GET /panel/api/staff/tickets/by-code/:code`
- `POST /panel/api/staff/tickets/by-code/:code/work-log`

Ambas aceptan **también** la cookie de sesión (cuenta `smarteam` con `staff.tickets`), para
probarlas desde el navegador o usarlas desde el panel más adelante.

### Cómo se resuelve en esas dos rutas

1. Si viene `Authorization`:
   - Debe ser `<esquema> <token>`, separados por espacios. El **esquema** `Bearer` se compara
     **sin distinguir mayúsculas** (RFC 7235 §2.1: `bearer`, `BEARER` y `Bearer` valen). El
     **token** sí distingue mayúsculas y debe cumplir la regex de M2 (`spn_` en minúsculas).
     Otro esquema (`Basic`, `Token`…), token ausente o con otro formato → **401**
     `invalid_token`, sin ir a la base.
   - Se busca por hash. No existe, revocado o vencido → **401** `invalid_token`.
   - Se carga el dueño **en cada request** (como `ResolvePanelSession`): no existe, inactivo o
     no es cuenta `smarteam` → **401** `invalid_token`.
   - Dueño con cambio de contraseña pendiente → **403** `password_change_required` (en la práctica
     no pasa: crear un token exige sesión sin cambio pendiente y el restablecimiento revoca los
     tokens, M7).
   - Sin el permiso `staff.tickets` (calculado con `permissionsFor`) → **403** `forbidden`.
   - **No se mira la cookie**: si hay `Authorization`, manda el token (aunque sea inválido).
   - **No se exige `X-Panel-Request`**: el header CSRF protege credenciales que el navegador
     manda solo (la cookie); un `Bearer` lo pone el cliente a mano y no hay CSRF posible. Si
     viene, se ignora.
2. Si no viene `Authorization`: igual que el resto del panel (cookie, `X-Panel-Request` en el
   `POST`, `401 unauthorized` sin sesión).

Todas las respuestas `401 invalid_token` llevan `WWW-Authenticate: Bearer error="invalid_token"`
y el mismo cuerpo, sin decir por qué (no existe, vencido, revocado o usuario inactivo):

```json
{ "error": "invalid_token", "message": "El token no es válido o venció. Crea uno nuevo en Mi cuenta." }
```

### Fuera de esas dos rutas: 401 `unauthorized`

En cualquier otra ruta del panel el header `Authorization` **se ignora por completo** (no se
valida ni se busca en la base) y la ruta se autentica solo con la cookie, como hoy. Una llamada
con token y sin cookie da por lo tanto **401** `unauthorized`.

Se elige 401 y no 403 porque:

- el token no es una credencial de esas rutas: para ellas la llamada **no está autenticada**, y
  eso es un 401 (un 403 diría "te reconozco, pero no puedes", que no es el caso);
- no hay código nuevo en cada ruta ni una búsqueda en la base por cada llamada con un token
  cualquiera, y la respuesta no sirve para averiguar si un token es válido;
- no cambia nada para el front: su manejo actual del 401 sigue igual.

---

## M4. Buscar ticket por código

`GET /panel/api/staff/tickets/by-code/:code` →

```json
{
  "tenantKey": "sap_integration_printer",
  "id": "6711b2c3d4e5f60123456789",
  "code": "PRINTER-0012",
  "title": "La cotización no llegó",
  "companyName": "Printer",
  "status": "en_progreso",
  "openedAt": "2026-10-30T14:00:00.000Z"
}
```

- No marca el ticket como visto por Smarteam (no es alguien mirando el panel).
- Código inexistente, mal formado o de una empresa que no existe → **404** `not_found`.

### Cómo es el código hoy (backend)

`ticketCode(tenantKey, number, tenantDbPrefix)` en `src/domain/panel/tickets.js`:

- prefijo = `tenantKey` sin `"<TENANT_DB_PREFIX>_"` (por defecto `sap_integration_`), en
  **mayúsculas**: `sap_integration_printer` → `PRINTER`. Si el `tenantKey` no empieza con ese
  prefijo, se usa entero en mayúsculas;
- número = correlativo por tenant (`TicketCounters`, `{ _id: 'tickets', seq }`), con al menos 4
  dígitos: `PRINTER-0012`, `PRINTER-12345`;
- el código se guarda en el ticket (`code`); el número también (`number`, con índice único).

Los códigos reales son del estilo `PRINTER-0012`, no `PRN-0012`.

### Cómo resolver el tenant

1. Normalizar: recortar y pasar a mayúsculas. Debe cumplir `^(.+)-(\d{1,9})$`; se separa por el
   **último** guion (el prefijo puede tener guiones si el `tenantKey` los tiene). Si no → 404.
2. Pedir `tenantDirectory.listAll()` (son pocas empresas; incluye suspendidas, igual que la
   bandeja) y quedarse con las que cumplen `ticketCodePrefix(tenantKey, tenantDbPrefix) ===
   prefijo`. **Nunca** se abre la base de un tenant que no salió del directorio.
3. En cada tenant que coincida: `findByNumber(tenantKey, número)` (usa el índice único de
   `number`) y confirmar que `ticket.code === código normalizado`.
4. Resultado:
   - ninguno → 404 `not_found`;
   - uno → la respuesta de arriba;
   - más de uno (solo si dos `tenantKey` dan el mismo prefijo, por ejemplo `printer` y
     `sap_integration_printer`; hoy no pasa) → **409** `{ "error": "ambiguous_code" }` y un
     `warn` en el log. La skill le pide al dev que use el panel.

No hace falta buscar en todos los tenants: el prefijo ya dice cuál es. La búsqueda por número
evita recorrer bases.

### Errores de este endpoint

| Código | Status | Cuándo |
| --- | --- | --- |
| `invalid_token` | 401 | Token ausente del esquema, con otro formato, inexistente, revocado, vencido o de un usuario inactivo (M3). |
| `unauthorized` | 401 | Sin `Authorization` y sin sesión válida. |
| `password_change_required` | 403 | El dueño del token o de la sesión tiene un cambio de contraseña pendiente. |
| `forbidden` | 403 | Sin `staff.tickets`, o sesión de una cuenta `cliente`. |
| `not_found` | 404 | Código mal formado, de una empresa que no existe o con un número que no existe. |
| `ambiguous_code` | 409 | Dos empresas dan el mismo prefijo y las dos tienen ese número. |
| `too_many_attempts` | 429 | Límite por token o por IP de M7, con `Retry-After`. |

---

## M5. Publicar registro de trabajo

`POST /panel/api/staff/tickets/by-code/:code/work-log`, `Content-Type: application/json`, header
opcional `Idempotency-Key`:

```json
{
  "summary": "Se corrigió el mapeo del campo de bodega; las cotizaciones ya llegan con el inventario.",
  "internalNote": "El mapeo del campo de bodega apuntaba a la propiedad vieja. Se cambió y se reprocesaron 14 eventos.",
  "hours": 2.5,
  "resolve": false,
  "crmProjectId": "123456789"
}
```

### Validaciones (todas antes de escribir nada)

| Campo | Regla | Error |
| --- | --- | --- |
| `summary` | texto, recortado, 1 a 5000 | `400 validation_error` ("El resumen es obligatorio." / "…supera los 5000 caracteres.") |
| `internalNote` | texto, recortado, 0 a 5000; vacío o ausente → `null` | `400 validation_error` |
| `internalNote` con `resolve: true` | **obligatorio** (1 a 5000): es la resolución interna, que "Resolver" exige | `400 validation_error` ("La nota interna es obligatoria para resolver.") |
| `hours` | **número JSON** (no texto), entre 0.25 y 24, múltiplo de 0.25 (`hours * 4` entero) | `400 validation_error` ("Las horas deben ir de 0.25 a 24, en cuartos de hora.") |
| `resolve` | booleano; ausente → `false` | `400 validation_error` |
| `crmProjectId` | opcional; texto recortado ≤ 64, solo `[A-Za-z0-9_-]`; vacío o ausente → `null` | `400 validation_error` |
| `Idempotency-Key` | opcional; regex `^[A-Za-z0-9._:-]{1,128}$` (sin recortar: un espacio es inválido; un UUID sirve) | `400 validation_error` ("Idempotency-Key debe tener de 1 a 128 caracteres: letras, números, punto, guion bajo, dos puntos o guion.") |

- Campos desconocidos: se ignoran. Sin imágenes (solo JSON).
- Los múltiplos de 0.25 son exactos en coma flotante: las sumas de M6 no tienen error de redondeo.

### Efectos con `resolve: false` (igual que "Responder" de Smarteam, `StaffTickets.reply`)

En **una sola actualización** del ticket (compare-and-set sobre el estado, como hoy):

- agrega el mensaje público: `authorType: "smarteam"`, `authorId`/`authorName` = **dueño del
  token** (o usuario de la sesión), `body` = `summary`, sin adjuntos;
- `abierto` → `en_progreso` (con su entrada en `statusHistory`); `en_progreso` y
  `esperando_cliente` no cambian;
- `lastActivityAt`, `lastPublicAuthorType: "smarteam"` (novedad para el cliente, `hasNews`) y
  `staffLastSeenAt` = ahora;
- `firstResponseAt` si estaba vacío (cuenta para las métricas de primera respuesta);
- agrega la entrada al registro de trabajo (M6).

### Efectos con `resolve: true` (igual que "Resolver", `StaffTickets.resolve`)

Lo mismo, pero además: `status: "resuelto"`, `resolvedAt` = ahora, entrada en `statusHistory`
hacia `resuelto` e `internalResolution = { text: internalNote, updatedAt, updatedBy }`
(**reemplaza** la que hubiera, como el botón Resolver). El mensaje al cliente es `summary`.

### Ticket ya resuelto

Las reglas actuales no permiten que Smarteam responda un ticket `resuelto`
(`statusAfterStaffMessage` → `null`) ni resolverlo de nuevo (`canResolve` → `false`). Por lo tanto,
con ticket `resuelto`, **con `resolve` en `true` o en `false`**:

```json
{ "error": "invalid_transition", "message": "El ticket ya está resuelto. Pásalo a en progreso desde el panel para registrar más trabajo." }
```

**409** y no se publica nada. La skill se lo muestra al dev. (Si más adelante se quiere registrar
horas sobre tickets resueltos sin escribirle al cliente, sería un cambio de reglas aparte.)

### Todo o nada

- Mensaje, cambio de estado, resolución interna y entrada de horas van en el **mismo**
  `findOneAndUpdate` del ticket: o queda todo o no queda nada. No hace falta transacción.
- Si el estado cambió entre la lectura y la escritura (otro request), se vuelve a leer el ticket
  y se evalúan las reglas **una vez más** con el estado nuevo; si ahora no se puede → 409
  `invalid_transition`, sin publicar.

### Respuesta

**201**:

```json
{
  "entry": {
    "id": "6729b0aa1b2c3d4e5f607182",
    "author": { "name": "Ana Mora" },
    "hours": 2.5,
    "internalNote": "El mapeo del campo de bodega apuntaba a la propiedad vieja. Se cambió y se reprocesaron 14 eventos.",
    "crmProjectId": "123456789",
    "createdAt": "2026-11-04T21:10:00.000Z",
    "messageId": "6729b0aa1b2c3d4e5f607181"
  },
  "ticket": { "status": "en_progreso" }
}
```

- `messageId`: el `id` del mensaje público creado (el mismo que sale en `messages[]` de D3).
- `internalNote` y `crmProjectId`: `null` si no vinieron.
- `ticket.status`: el estado después de publicar.

### Idempotencia

Con `Idempotency-Key`, la misma clave **del mismo token** (o del mismo usuario, si se usa la
cookie) dentro de **24 h** devuelve la **misma respuesta** (mismo status y cuerpo) sin duplicar
nada:

| Situación | Respuesta |
| --- | --- |
| Clave nueva | Se procesa normal. |
| Clave ya usada, **misma** huella y ya terminó bien | La misma respuesta (201, cuerpo idéntico), rearmada desde el ticket. No se escribe nada. |
| Clave ya usada (terminada o en curso) con **otra** huella | **422** `{ "error": "idempotency_key_reused" }` |
| Clave en curso (otro request con la misma clave y la misma huella, sin terminar, de hace menos de 60 s) | **409** `{ "error": "request_in_progress" }`; la skill reintenta en unos segundos |
| El intento anterior terminó en 4xx o 5xx | No queda guardado: un reintento con la misma clave se procesa de nuevo (y la red de seguridad evita duplicar si el 5xx llegó a escribir) |

#### Huella

- SHA-256 de un JSON canónico (llaves en orden fijo) con el **código normalizado** (recortado y
  en mayúsculas) y los campos **ya normalizados** por las validaciones: `summary` recortado,
  `internalNote` recortado o `null` si vino vacío o ausente, `hours` como número, `resolve` como
  booleano (`false` si no vino) y `crmProjectId` recortado o `null`.
- **No** se calcula sobre el JSON crudo: `"internalNote": ""`, `"internalNote": "   "` y no
  mandarla dan la misma huella; un campo desconocido o un cambio de orden de llaves no la cambia.
- Como la huella sale de los campos validados, un cuerpo inválido da 400 antes de tocar el
  registro de claves.

#### Registro de claves

Colección nueva de la master, **`PanelIdempotencyKeys`**. Guarda **solo** lo necesario para
reconocer la clave y encontrar la entrada; **nunca** el resumen, la nota interna ni el cuerpo de
la respuesta (que viven en la base del tenant):

| Campo | Nota |
| --- | --- |
| `ownerKey` | `token:<id del token>` o `user:<id del usuario>` (cookie) |
| `key` | la `Idempotency-Key` tal cual |
| `fingerprint` | SHA-256 en hex (arriba) |
| `state` | `pending` o `done` |
| `tenantKey`, `ticketId`, `entryId` | se completan al terminar (`done`) |
| `status` | status HTTP que se devolvió (`201`) |
| `createdAt` | fecha de la reserva (o de la retoma) |
| `expiresAt` | `createdAt` de la primera reserva + 24 h; índice **TTL** |

Índice **único** `{ ownerKey: 1, key: 1 }`.

#### Pasos

1. Autenticar, validar y normalizar el cuerpo, calcular la huella.
2. Leer `{ ownerKey, key }`:
   - `done` con otra huella → 422. `done` con la misma → paso 6 (rearmar).
   - `pending` con otra huella → 422.
   - `pending` con la misma huella y `createdAt` de hace **menos de 60 s** → 409
     `request_in_progress`.
   - `pending` **abandonado** (`createdAt` de hace 60 s o más): se retoma con
     `findOneAndUpdate({ ownerKey, key, state: 'pending', fingerprint, createdAt: { $lt:
     ahora − 60 s } }, { $set: { createdAt: ahora } })`. Si devuelve `null` (otro request lo
     retomó primero) → 409 `request_in_progress`.
   - No existe → `insert` de `{ state: 'pending', … }`. Si choca con el índice único (carrera),
     se vuelve a leer y se aplica este mismo paso.
3. Resolver el código (M4).
4. **Red de seguridad, antes de evaluar transiciones**: buscar en `ticket.workLog` una entrada con
   `idempotencyKey === "<ownerKey>:<key>"`. Si existe, el intento anterior **sí escribió** el
   ticket pero no llegó a marcar `done` (por ejemplo, se cayó el proceso): se marca `done` con esa
   entrada y se va al paso 6. **No** se evalúan las reglas de estado: con `resolve: true` el
   ticket ya está `resuelto` y evaluarlas daría un 409 falso.
5. Si no existe, evaluar las reglas y escribir (secciones anteriores). La actualización lleva
   además en el filtro `"workLog.idempotencyKey": { $ne: "<ownerKey>:<key>" }`. Si no aplica, se
   vuelve a leer el ticket y se repite el paso 4; si tampoco hay entrada, es un cambio de estado
   concurrente (reintento único, después 409). Con éxito: `complete` → `state: 'done'`,
   `tenantKey`, `ticketId`, `entryId`, `status: 201`.
6. **Rearmar la respuesta** desde el ticket: se carga el ticket (`tenantKey`, `ticketId`) y la
   entrada `entryId`. El cuerpo sale de la entrada guardada (`authorName`, `hours`,
   `internalNote`, `crmProjectId`, `createdAt`, `messageId`) y `ticket.status` de su
   `statusAfter` (el estado justo después de esa publicación, no el actual). Así es idéntico al
   original aunque el ticket haya cambiado después.
7. **Liberar** (`release`): si el request termina en 4xx después de reservar (404, 409
   `invalid_transition`, `ambiguous_code`) **o en 5xx** (excepción), se borra el registro con
   `deleteOne({ ownerKey, key, state: 'pending', createdAt: <el de esta reserva> })`, en un
   `finally`, sin que su fallo cambie la respuesta. Si la liberación falla, el `pending` queda
   abandonado y se retoma a los 60 s (paso 2); el paso 4 evita duplicar si alcanzó a escribir.

Sin `Idempotency-Key` no hay deduplicación: dos llamadas crean dos entradas.

### Errores de este endpoint

| Código | Status | Cuándo |
| --- | --- | --- |
| `validation_error` | 400 | Algún campo de la tabla de validaciones, JSON inválido o `Content-Type` distinto de JSON. |
| `invalid_token` | 401 | M3. |
| `unauthorized` | 401 | Sin token y sin sesión. |
| `password_change_required` | 403 | El dueño del token o de la sesión tiene un cambio de contraseña pendiente. |
| `forbidden` | 403 | Sin `staff.tickets` o cuenta `cliente` con sesión. |
| `missing_panel_header` | 403 | **Solo con cookie**: falta `X-Panel-Request: 1`. |
| `not_found` | 404 | Código que no existe (M4). |
| `invalid_transition` | 409 | Ticket resuelto (sin entrada previa con esa `Idempotency-Key`), o el estado cambió y ya no se puede. |
| `ambiguous_code` | 409 | M4. |
| `request_in_progress` | 409 | Idempotencia, clave en curso. |
| `idempotency_key_reused` | 422 | Idempotencia, clave usada con otro cuerpo. |
| `too_many_attempts` | 429 | Límite por token o por IP de M7, con `Retry-After` en segundos. |

---

## M6. Detalle del ticket con `workLog`

En el detalle de **Smarteam** (`GET /panel/api/staff/tenants/:tenantKey/tickets/:id`, D3) se
agrega:

```json
"workLog": {
  "totalHours": 4.25,
  "entries": [
    {
      "id": "6729b0aa1b2c3d4e5f607182",
      "author": { "name": "Ana Mora" },
      "hours": 2.5,
      "internalNote": "El mapeo del campo de bodega apuntaba a la propiedad vieja…",
      "crmProjectId": "123456789",
      "createdAt": "2026-11-04T21:10:00.000Z",
      "messageId": "6729b0aa1b2c3d4e5f607181"
    },
    {
      "id": "6728f1aa1b2c3d4e5f607100",
      "author": { "name": "Luis Vargas" },
      "hours": 1.75,
      "internalNote": null,
      "crmProjectId": null,
      "createdAt": "2026-11-03T16:00:00.000Z",
      "messageId": "6728f1aa1b2c3d4e5f6070ff"
    }
  ]
}
```

- Siempre presente en el detalle de Smarteam: sin entradas → `{ "totalHours": 0, "entries": [] }`.
- `entries`: de la **más reciente a la más vieja** (`createdAt` descendente).
- `totalHours`: suma de `hours` de todas las entradas.
- Como todas las mutaciones de Smarteam devuelven `toStaffDetail`, también lo traen sus
  respuestas.
- **El cliente nunca recibe `workLog` ni horas**: ni en el detalle (D3), ni en la lista (D1), ni
  en la bandeja (D2), ni en métricas. Las vistas de cliente ya se arman campo por campo
  (`ticketView.js`) y la proyección de la lista (`LIST_PROJECTION`) no lo incluye; el test de M8
  lo comprueba.
- El mensaje público que generó cada entrada sí lo ve el cliente, como cualquier respuesta de
  Smarteam (autor = nombre del dev).

---

## M7. Seguridad y auditoría

### Token

- 32 bytes de `crypto.randomBytes`, `spn_` + 43 caracteres base64url (M2). Solo se guardan el
  **hash SHA-256** y el `prefix`. El token en claro existe solo en la respuesta del `POST`.
- Formato comprobado con la regex de M2 **antes** de hashear o consultar la base.
- Crear un token exige **`currentPassword`** (M2), con el mismo error que el cambio de contraseña
  (`400 invalid_current_password`) y un límite de 5 intentos fallidos cada 15 min por usuario.
  Así una sesión robada (cookie) no alcanza para sacar una credencial de 90 días.
- Vencimiento de 90 días, sin renovación. Máximo 5 activos por usuario.
- **Solo por header** `Authorization`. Nunca por query string ni por cookie (así no queda en logs
  de acceso ni en el historial).
- `lastUsedAt` se actualiza **como mucho una vez por minuto**, con una escritura condicional que
  no frena la respuesta: `updateOne({ _id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt:
  ahora − 60 s } }] }, { $set: { lastUsedAt: ahora } })`. Si falla, se loguea y el request sigue.

### Límites

- **30 requests por minuto por token**, sumando los dos endpoints → **429** `too_many_attempts`
  con `Retry-After`. Mismo esquema que `RedisLoginAttempts` (Redis con `INCR` + `EXPIRE`
  atómico, timeout y contador en memoria si Redis no responde), con otro prefijo de clave
  (`panel:apitoken:`) y el **id** del token como clave (nunca el token).
- Además, **20 tokens inválidos cada 15 min por IP** → 429, solo si hay proxies de confianza
  (igual que el límite de login por IP). Evita que se use la ruta para martillar la base.
- **5 contraseñas incorrectas cada 15 min por usuario** al crear un token (M2,
  `panel:pwdcheck:`) → 429 `too_many_attempts`. Se suma al límite de concurrencia del hasher que
  ya existe (`PANEL_HASHER_BUSY` → 429).

### Nunca loguear el token

- El manejador de errores del panel ya loguea sin headers ni body; mantenerlo.
- Agregar al logger de Fastify `redact: ['req.headers.authorization', 'req.headers.cookie']` por
  si alguien cambia los serializadores más adelante.
- No poner el token ni el hash en mensajes de error, en el registro de auditoría ni en
  `details`. El `prefix` sí puede ir.
- Revisar que nginx no tenga un `log_format` con `$http_authorization`.

### Desactivación y contraseña

| Evento | Tokens del usuario | Por qué |
| --- | --- | --- |
| Admin **desactiva** al usuario | **Se revocan todos** (`revokedReason: user_deactivated`) | Ya quedan inútiles porque se valida `active` en cada uso; revocarlos evita que una **reactivación** los reviva. Igual que `tokenVersion` con las sesiones. |
| Admin **reactiva** al usuario | Siguen revocados | Crea tokens nuevos. |
| El usuario **cambia su contraseña** | **Se mantienen** | Es una acción normal y planificada; el token es otra credencial, con su propio vencimiento, y el dueño lo ve y lo revoca desde Mi cuenta (la lista). Romper la skill en cada cambio no aporta. |
| Admin **restablece** la contraseña | **Se revocan todos** (`revokedReason: password_reset`) | Es el camino de recuperación de una cuenta, que puede venir de un compromiso. Recomendación nuestra, el pedido no lo definía. |
| Cambio de permisos | No se revocan | Se calcula en cada uso: sin `staff.tickets` → 403. |

### Auditoría (`PanelAuditLogs`, `MongoosePanelAuditLog`)

Acciones nuevas en `src/domain/panel/auditActions.js` (el `enum` del modelo las toma solo):

| Acción | `actor` | `target` | `details` permitidos |
| --- | --- | --- | --- |
| `api_token.created` | el usuario | el usuario | `tokenId`, `prefix`, `name`, `expiresAt` |
| `api_token.revoked` | quien revoca (el usuario o el admin) | el dueño | `tokenId`, `prefix`, `reason` |
| `ticket.work_logged` | el dueño del token o de la sesión | `null` | `tenantKey`, `ticketId`, `ticketCode`, `entryId`, `hours`, `resolved`, `via` (`token`/`session`), `tokenPrefix` |

- Se escriben **después** de que la acción quedó guardada y son best effort (como hoy: si falla
  la auditoría, la acción no falla).
- No llevan `expiresAt` (no son `auth.*`): se conservan, como los `user.*`.
- `AUDIT_DETAIL_KEYS` filtra todo lo demás: ni el token ni la nota interna entran al registro.
- Revocación masiva (desactivar, restablecer): una entrada por token.
- Un replay idempotente no se audita de nuevo.
- La contraseña incorrecta al crear un token no necesita acción nueva: alcanza con el contador de
  intentos. (Si se quiere rastro, se puede agregar `api_token.create_failed` con `reason`.)

### Aviso por correo (sugerencia futura)

Lo ideal sería avisar por correo al dueño cada vez que se crea un token ("Se creó el token
`Claude Code - laptop` (`spn_a1b2`) en tu cuenta. Si no fuiste tú, revócalo y cambia tu
contraseña."). **Hoy el backend no envía correos** (no hay adaptador de correo en `src/`), así que
queda fuera de este plan: cuando exista un servicio de correo, se agrega como paso best effort
después de crear el token, sin frenar la respuesta.

---

## M8. Pruebas que esperamos

Tokens:

- Crear devuelve 201 con `spn_` + 43 caracteres base64url y `prefix` = primeros 8; en la base
  solo está el hash SHA-256 (buscar el token en claro en el documento no da nada).
- `expiresAt` = `createdAt` + 90 días. `name` vacío, de solo espacios o de 61 caracteres → 400.
- Con 5 activos → 409 `token_limit`; con 4 activos y 3 vencidos o revocados → se puede crear.
- La lista trae solo los del usuario, sin revocados ni vencidos, el más nuevo primero, sin
  `token` ni `tokenHash`.
- Revocar uno propio → 204; uno de otro usuario, inexistente o ya revocado → 404.
- Cuenta `cliente` → 403 en los tres. Sin cookie → 401. Un `Bearer` válido sin cookie en
  `/account/api-tokens` → 401 `unauthorized`.
- `POST` y `DELETE` con cookie y sin `X-Panel-Request` → 403 `missing_panel_header`.
- `name` con salto de línea, tabulación o `\u0000` → 400 (no se limpia).
- Crear sin `currentPassword` → 400 `validation_error`; con contraseña incorrecta → 400
  `invalid_current_password` (mismo cuerpo que `POST /auth/change-password`) y no se crea nada;
  el sexto intento incorrecto en 15 min → 429 `too_many_attempts` aunque la contraseña sea la
  correcta; con contraseña correcta y 5 activos → 409 `token_limit`.
- Cambiar la propia contraseña no revoca tokens.

Autenticación:

- Token válido en las dos rutas → 200/201. Revocado, vencido, con formato raro, de usuario
  inactivo o de cuenta cliente → 401 `invalid_token` con `WWW-Authenticate`.
- `bearer spn_…` y `BEARER spn_…` funcionan; `Bearer SPN_…`, un token de 42 o 44 caracteres,
  con `=` o con `+`/`/` → 401 sin consultar el repositorio de tokens; `Basic …` → 401.
- Dueño con cambio de contraseña pendiente → 403 `password_change_required` en las dos rutas.
- `Authorization` presente e inválido + cookie válida → 401 `invalid_token` (no cae a la cookie).
- Con token, el `POST` **no** necesita `X-Panel-Request`; con cookie sí.
- Token válido en cualquier otra ruta (por ejemplo `GET /staff/tickets`, `GET /auth/me`) sin
  cookie → 401 `unauthorized`, y el repositorio de tokens no se consulta.
- `lastUsedAt` cambia en el primer uso y no vuelve a escribirse en usos dentro del mismo minuto.
- 31 requests en un minuto con el mismo token → el 31 da 429 con `Retry-After`.
- Desactivar al usuario revoca sus tokens y reactivarlo no los revive; cambiar la contraseña no
  los toca; restablecerla los revoca.

Búsqueda por código:

- `PRINTER-0012` (y `printer-0012`, con espacios) encuentra el ticket de
  `sap_integration_printer`; `PRINTER-9999` → 404; `NOEXISTE-0001` → 404 sin abrir la base de
  ningún tenant; `PRINTER0012` → 404.
- Un número de 5 dígitos (`PRINTER-12345`) funciona.
- Dos tenants con el mismo prefijo y el número en ambos → 409 `ambiguous_code`.
- No cambia `staffLastSeenAt`.

Registro de trabajo:

- `abierto` + `resolve: false` → mensaje público con autor = dueño del token, estado
  `en_progreso`, `firstResponseAt` fijado, `hasNews` del cliente en `true`, entrada en `workLog`.
- `esperando_cliente` + `resolve: false` → el estado no cambia.
- `en_progreso` + `resolve: true` → `resuelto`, `resolvedAt`, `internalResolution` con la nota,
  historial; el cliente ve el resumen como mensaje.
- `resolve: true` sin `internalNote` → 400 y el ticket no cambia.
- Ticket `resuelto` (con `resolve` `true` o `false`) → 409 `invalid_transition` y el ticket queda
  idéntico (sin mensaje ni entrada).
- `hours`: 0.25 y 24 pasan; 0, 0.2, 24.25, `"2.5"` (texto) y `null` → 400.
- `summary` vacío o de 5001 caracteres → 400; `crmProjectId` de 65 → 400.
- Misma `Idempotency-Key` dos veces → misma respuesta y una sola entrada y un solo mensaje;
  misma clave con otro `hours` → 422; dos requests simultáneos con la misma clave → uno 201 y el
  otro 409 `request_in_progress` o la misma respuesta; la misma clave de **otro** token → se
  procesa como nueva.
- Primer intento 400 y reintento corregido con la misma clave → 201.
- La huella usa los campos normalizados: `internalNote: ""`, `"   "` o ausente, y un campo
  desconocido extra, con la misma clave → la misma respuesta (no 422).
- `Idempotency-Key` con espacio, `/`, vacía o de 129 caracteres → 400.
- **Caída después de escribir con `resolve: true`**: simular que `complete` falla (el ticket ya
  quedó `resuelto` con la entrada y el registro sigue `pending`); a los 60 s el reintento con la
  misma clave retoma el registro, encuentra la entrada en `workLog` y responde el mismo 201 (con
  `ticket.status: "resuelto"`), **no** 409; sigue habiendo una sola entrada y un solo mensaje.
- Excepción (5xx) después de reservar → el registro `pending` se borra y un reintento inmediato
  se procesa.
- Dos retomas simultáneas de un `pending` abandonado → una sigue y la otra da 409
  `request_in_progress`.
- El replay sale idéntico aunque después alguien haya cambiado el estado del ticket.
- En `PanelIdempotencyKeys` no aparecen `summary`, `internalNote` ni el cuerpo de la respuesta.
- Cada publicación deja `ticket.work_logged` en la auditoría, sin la nota ni el token.

Detalle:

- Detalle de Smarteam con `workLog.entries` de más nuevo a más viejo y `totalHours` correcto
  (2.5 + 1.75 = 4.25); ticket sin entradas → `{ totalHours: 0, entries: [] }`.
- Detalle, lista, bandeja y métricas del **cliente**: la respuesta serializada no contiene
  `workLog`, `hours`, `internalNote` ni `crmProjectId`.

---

## Forma sugerida en el backend

Siguiendo la estructura actual (puertos en `application/ports/panel`, casos de uso en
`application/use-cases/panel`, adaptadores en `infrastructure`, armado en
`composition/panel.composition.js`):

### Registro de horas: embebido en el ticket (recomendado)

Arreglo **`workLog`** dentro del documento `Tickets` del tenant, no una colección
`TicketWorkLogs` aparte:

- **Todo o nada sin transacciones**: mensaje, estado, resolución y horas van en el mismo
  `findOneAndUpdate` con compare-and-set (`MongooseTicketRepository.update`). Con una colección
  aparte habría que usar transacciones, que el backend no usa hoy y que exigen réplica en cada
  base de tenant.
- Sigue el patrón de `messages` y `statusHistory`, que ya viven embebidos.
- El tamaño no preocupa: cada entrada pesa como mucho ~10 KB y un ticket tiene pocas.
- El dato vive con el tenant, como el resto del ticket.
- Si más adelante hace falta un reporte de horas por proyecto del CRM, se arma con una
  agregación (`$unwind: '$workLog'`) por tenant, como las métricas.

Subesquema en `models/panel/Ticket.js`:

```js
const workLogSchema = new Schema(
  {
    authorId: { type: String, required: true },
    authorName: { type: String, default: null },
    hours: { type: Number, required: true, min: 0.25, max: 24 },
    internalNote: { type: String, default: null },
    crmProjectId: { type: String, default: null },
    messageId: { type: Schema.Types.ObjectId, required: true },
    resolved: { type: Boolean, default: false },
    statusAfter: { type: String, required: true }, // para rearmar la misma respuesta (M5)
    via: { type: String, enum: ['token', 'session'], required: true },
    tokenId: { type: String, default: null },
    idempotencyKey: { type: String, default: null }, // "<ownerKey>:<key>"
    createdAt: { type: Date, required: true },
  },
  { _id: true }
);
// en ticketSchema: workLog: { type: [workLogSchema], default: [] }
```

`LIST_PROJECTION` no cambia (no lo incluye); `toTicket` mapea `workLog`; `listForMetrics` no lo
lee.

### Piezas nuevas

| Capa | Pieza | Qué hace |
| --- | --- | --- |
| Dominio | `domain/panel/apiTokens.js` | Constantes (`spn_`, 90 d, 5 activos, nombre ≤ 60, formato), `isActive(token, now)`. Puro. |
| Dominio | `domain/panel/workLog.js` | `checkWorkLogInput` (tabla de M5), `totalHours`, orden de entradas. Puro. |
| Dominio | `domain/panel/tickets.js` | `parseTicketCode(code)` → `{ prefix, number }` o `null`. |
| Dominio | `auditActions.js` | Las tres acciones de M7 y sus `AUDIT_DETAIL_KEYS`. |
| Puerto | `api-token-repository.port.js` | `create`, `listActiveByUser`, `countActiveByUser`, `findByHash`, `revoke(userId, id, reason, at)`, `revokeAllForUser(userId, reason, at)`, `touchLastUsed(id, at)`. |
| Puerto | `api-token-codec.port.js` | `generate()` → `{ token, hash, prefix }` y `hash(token)`. |
| Puerto | `idempotency-store.port.js` | `find`, `reserve`, `takeOver` (retoma condicionada a `pending` y `createdAt` < ahora − 60 s), `complete(… { tenantKey, ticketId, entryId, status })`, `release` (M5). Sin cuerpos de respuesta. |
| Puerto | `ticket-repository.port.js` | Método nuevo `findByNumber(tenantKey, number)`; `update` acepta `pushWorkLog` y `idempotencyGuard`. |
| Caso de uso | `ManageApiTokens.js` | Listar, crear (verifica `currentPassword` con el `passwordHasher` y el contador de intentos) y revocar los propios; `revokeAllForUser` para usuarios. Audita. |
| Caso de uso | `ResolveApiToken.js` | Token → usuario del panel (como `ResolvePanelSession`) y `touchLastUsed`. |
| Caso de uso | `StaffWorkLog.js` | `findByCode` (M4) y `publish` (M5). Reusa `ticketCommon.js` (`messageEntry`, `historyEntry`, `applyTicketChange`) y las reglas de `tickets.js`; no copia la lógica de `StaffTickets`. |
| Caso de uso | `ManagePanelUsers.js` | Al desactivar y al restablecer, `revokeAllForUser`. `buildManagePanelUsers` (y `scripts/create-panel-staff.mjs`) reciben el repositorio de tokens. |
| Vista | `ticketView.js` | `toStaffDetail` agrega `workLog`; las vistas de cliente no cambian. |
| Infraestructura | `models/global/PanelApiToken.js` | Colección `PanelApiTokens` (M2), índices único en `tokenHash`, `{ userId, createdAt }` y TTL en `purgeAt`. |
| Infraestructura | `models/global/PanelIdempotencyKey.js` | Colección `PanelIdempotencyKeys` (M5), único `{ ownerKey, key }`, TTL en `expiresAt`. |
| Infraestructura | `MongoosePanelApiTokenRepository.js`, `MongooseIdempotencyStore.js` | Adaptadores. |
| Infraestructura | `auth/RandomApiToken.js` | `crypto.randomBytes(32)` + base64url + SHA-256. |
| Infraestructura | `RedisLoginAttempts` con `keyPrefix: 'panel:apitoken:'` y `'panel:pwdcheck:'` | Límites de M7 (ya soporta otro prefijo y otra ventana). |
| HTTP | `panelSession.js` | El guard mira `config.panelTokenAuth`: en esas rutas, si hay `Authorization`, valida el token, salta CSRF y cookie y deja `req.panelUser` y `req.panelAuth = { via: 'token', tokenId, prefix }`. En las demás rutas, nada cambia. |
| HTTP | `panelApiTokens.controller.js`, `panelWorkLog.controller.js` | Rutas de M2 (con `requireStaffAccount` + `staff.tickets`) y de M4/M5. |
| HTTP | `panelErrors.js` / `panelReasons.js` | Motivos nuevos: `INVALID_TOKEN` (401), `TOKEN_LIMIT` (409), `AMBIGUOUS_CODE` (409), `REQUEST_IN_PROGRESS` (409), `IDEMPOTENCY_KEY_REUSED` (422). |

Rutas: `/staff/tickets/by-code/:code` no choca con `/staff/tickets/summary` ni
`/staff/tickets/metrics` (segmentos estáticos distintos). El header `Authorization` llega por el
proxy (nginx lo reenvía por defecto).

No hace falta permiso nuevo: se usa `staff.tickets`. `/auth/me` no cambia.

## Despliegue

Front y backend juntos. El campo `workLog` del detalle de Smarteam no rompe nada si sale antes,
pero la pantalla de tokens del front y el backend deben coincidir en `currentPassword` (M2): un
front sin ese campo recibiría 400 de un backend que lo exige. La skill necesita M4 y M5.

## Nota del backend (plan 10)

Plan: `docs/superpowers/plans/2026-11-04-panel-registro-trabajo.md`.

- **Implementado:** M2 a M7 completos.
  - Tokens `spn_` en `PanelApiTokens`: solo el SHA-256 y el `prefix`, 90 días y máx. 5 activos.
  - Guard con `config.panelTokenAuth` en las dos rutas `by-code`.
  - `GET /staff/tickets/by-code/:code` y `POST …/work-log` con idempotencia (`PanelIdempotencyKeys`, 24 h).
  - `workLog` en el detalle de Smarteam; las vistas de cliente no lo tienen.
  - Revocación de tokens al desactivar o restablecer la contraseña. Auditoría de cada paso.
  - Pruebas unitarias, HTTP y de integración (`tests/integration/panelWorkLog.test.js`, Windows).
- **`firstResponseAt`:** va con `setIfNull`, en una escritura condicional aparte, como en
  "Responder" y "Resolver". Mensaje, estado, resolución interna y entrada de horas sí van en el
  mismo `findOneAndUpdate`.
- **`redact` del logger de Fastify (M7): no se aplicó.** Vive en `src/main/app.js` (núcleo); queda
  pendiente de decisión. Hoy ni Fastify ni el manejador de errores del panel loguean headers.
- **`Retry-After`:** 60 s en el límite por token; 900 s en el de contraseñas (`pwdcheck`) y en el
  de tokens inválidos por IP. El 429 del login no cambia.
- **`Authorization` vacío** (`Authorization:` sin valor) en las rutas `by-code` → 401
  `invalid_token`: el header presente decide que se intenta autenticar con token.
- **`Content-Type` no JSON** en `POST …/work-log` → 400 `validation_error`, aunque Fastify
  respondería 415.
- **`crmProjectId`** debe ir como texto: un número (`123`) → 400.
- **`resolve: null`** → 400 (solo `true`, `false` o ausente).
- **Infraestructura (pendiente):** revisar el `log_format` de nginx para que no incluya
  `$http_authorization`.
