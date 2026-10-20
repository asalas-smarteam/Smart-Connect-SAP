# Acceso y usuarios (plan 1 del backend)

Supuestos **C1 a C9** del plan 4a del panel. Las reglas comunes (errores, paginación, header CSRF) están en [`00-reglas-generales.md`](00-reglas-generales.md).

## Endpoints que usa el front

| Método y ruta | Permiso | Uso en el front |
|---|---|---|
| `POST /panel/api/auth/login` | — | Login. |
| `POST /panel/api/auth/logout` | sesión | Cerrar sesión. |
| `GET /panel/api/auth/me` | sesión | Estado de sesión, menú y botones. |
| `POST /panel/api/auth/change-password` | sesión | Cambio obligatorio. |
| `GET /panel/api/staff/users` | `staff.users` | Lista de usuarios. |
| `POST /panel/api/staff/users` | `staff.users` | Alta. |
| `POST /panel/api/staff/users/:id/reset-password` | `staff.users` | Restablecer. |
| `PATCH /panel/api/staff/users/:id` | `staff.users` | Rol, desactivar, reactivar. |
| `GET /panel/api/staff/tenants` | `staff.users` | **Nuevo** (C7). Selector de empresa. |

## Forma de `GET /auth/me` (del spec)

```json
{
  "name": "Adriana Solís",
  "email": "admin@acme.test",
  "accountType": "cliente",
  "role": "admin",
  "tenantKey": "ACME",
  "companyName": "Acme Industrial",
  "permissions": ["tickets.read", "tickets.create", "tickets.reply", "tickets.reopen", "events.read", "syncs.read"],
  "mustChangePassword": false
}
```

Para Smarteam: `accountType: "smarteam"`, `role`, `tenantKey` y `companyName` en `null`. El front decide menú y botones **solo** con `permissions`.

---

## C1. `GET /auth/me` responde 200 aunque haya cambio de contraseña pendiente

- Con `pwdChange: true`, `/auth/me` responde **200** con `mustChangePassword: true` (no 403).
- **Por qué:** el front necesita el nombre del usuario y saber por qué no puede pasar. El front tolera también un 403 `password_change_required`, pero se pide el 200.

## C2. Cuerpo de `change-password` y error de contraseña actual

- Request: `{ "currentPassword": "...", "newPassword": "..." }`.
- Si `currentPassword` no coincide: **400** `{ "error": "invalid_current_password" }`. **No 401.**
- Si `newPassword` tiene menos de 10 caracteres o es igual a la actual: **400** `validation_error` con `message` legible.
- Éxito: **204** (o 200; el front no usa el cuerpo).
- **Por qué no 401:** el front trata todo 401 como sesión vencida y manda al login.

## C3. Al cambiar la contraseña se emite una cookie nueva

- Cambiar la contraseña sube `tokenVersion`, lo que invalidaría la sesión actual. La respuesta exitosa debe **emitir una cookie `panel_session` nueva** con el `tokenVersion` vigente y `pwdChange: false`.
- **Por qué:** si no, el usuario queda expulsado justo después de elegir su contraseña. El front lo tolera (manda al login con "Contraseña cambiada. Vuelve a entrar"), pero es una mala experiencia.

## C4. Respuesta de `login`

- Éxito: **200** con el mismo cuerpo que `/auth/me` (y la cookie).
- El front no depende del cuerpo: después del login vuelve a pedir `/auth/me`.
- Errores: `401 invalid_credentials`, `429 too_many_attempts`, `400 validation_error`.

## C5. Formato de errores

- Ver [`00-reglas-generales.md`](00-reglas-generales.md#formato-de-error).

## C6. Forma de un usuario (lista y alta)

```json
{
  "id": "6710a1b2c3d4e5f601234567",
  "email": "usuario@acme.test",
  "name": "Mario Quesada",
  "accountType": "cliente",
  "tenantKey": "ACME",
  "companyName": "Acme Industrial",
  "role": "usuario",
  "active": true,
  "mustChangePassword": false,
  "lastLoginAt": "2026-10-11T15:00:00.000Z",
  "createdAt": "2026-08-01T15:00:00.000Z"
}
```

- `tenantKey`, `companyName` y `role` en `null` para Smarteam. `lastLoginAt` en `null` si nunca entró.
- **Nunca** incluir `passwordHash`, `tokenVersion` ni nada de la contraseña.
- `GET /staff/users?tenantKey=&page=&pageSize=` → `{ items: [usuario], page, pageSize, total }`.
- `POST /staff/users` → **201** `{ "user": usuario, "temporaryPassword": "..." }`. Correo repetido → **409** `email_taken`.
- `POST /staff/users/:id/reset-password` → **200** `{ "temporaryPassword": "..." }`.
- `PATCH /staff/users/:id` `{ name?, role?, active? }` → **200** `{ "user": usuario }` (el front no usa el cuerpo). `role` solo vale para cuentas `cliente`; mandar `tenantKey` o `accountType` → `400`.

## C7. Endpoint nuevo: `GET /panel/api/staff/tenants`

- Permiso `staff.users` (y lo usará también la bandeja, con `staff.tickets`: se sugiere aceptar cualquiera de los dos).
- Respuesta, **sin paginar** (es la fuente de un selector, no una tabla):

```json
{
  "items": [
    { "tenantKey": "ACME", "companyName": "Acme Industrial", "status": "active" },
    { "tenantKey": "INITECH", "companyName": "Initech Servicios", "status": "suspended" }
  ]
}
```

- Incluye los tenants suspendidos.
- **Por qué:** para crear un usuario de cliente hay que elegir su empresa, y la lista de usuarios filtra por empresa. Alternativa descartada: escribir el `tenantKey` a mano.

## C8. Orden de la lista de usuarios

- `createdAt` descendente (los más nuevos primero).

## C9. Nadie se desactiva a sí mismo

- `PATCH /staff/users/:id` con `active: false` sobre el propio usuario → **400** `validation_error` ("No puedes desactivar tu propia cuenta").
- El front ya oculta las acciones sobre la fila propia; el backend debe rechazarlo igual.
