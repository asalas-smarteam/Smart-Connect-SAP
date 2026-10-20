# Reglas generales de `/panel/api`

## Rutas y origen

- El navegador llama a `/api/*` en el dominio del panel. El proxy (Vite en desarrollo, nginx en producción) reenvía a `/panel/api/*` del backend. En estos documentos las rutas se escriben como las ve el backend: `/panel/api/...`.
- Mismo origen: no hace falta CORS.

## Sesión

- Cookie `panel_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api` (como dice el spec). El front nunca la lee.
- Sin sesión válida (no existe, vencida, usuario inactivo o `tokenVersion` distinto): **401** `{ "error": "unauthorized" }`.
- Con cambio de contraseña pendiente: **403** `{ "error": "password_change_required" }` en todo menos `POST /auth/change-password`, `POST /auth/logout` y **`GET /auth/me`** (ver C1).
- Sin el permiso de la ruta: **403** `{ "error": "forbidden" }`.

## Header CSRF

- Toda mutación (`POST`, `PUT`, `PATCH`, `DELETE`) llega con `X-Panel-Request: 1`. Si falta: **403** `{ "error": "missing_panel_header" }`.
- Los `GET` nunca lo llevan.

## Formato de error

```json
{ "error": "codigo_en_snake_case", "message": "Texto opcional, en español si lo ve el usuario" }
```

- `error` es un **código estable** que el front usa para decidir qué mostrar; `message` es opcional.
- El front también tolera el formato actual del backend (`{ "ok": false, "message": "..." }`) y el de Fastify por defecto (`{ "statusCode", "error": "Bad Request", "message" }`), pero en `/panel/api` se pide usar siempre el formato de arriba.
- Para `validation_error`, el front muestra `message` tal cual: debe ser una frase para el usuario.

### Códigos que el front reconoce

| Código | Status | Dónde |
|---|---|---|
| `unauthorized` | 401 | Sin sesión válida. |
| `invalid_credentials` | 401 | Login: mismo error para "no existe", "inactivo" y "contraseña incorrecta". |
| `too_many_attempts` | 429 | Login: 5 fallidos por email en 15 min. |
| `password_change_required` | 403 | Cambio de contraseña pendiente. |
| `invalid_current_password` | **400** | Cambio de contraseña: la actual no coincide (C2). |
| `forbidden` | 403 | Falta el permiso. |
| `missing_panel_header` | 403 | Mutación sin `X-Panel-Request: 1`. |
| `validation_error` | 400 | Datos inválidos; `message` legible. |
| `email_taken` | 409 | Alta de usuario con correo existente. |
| `not_found` | 404 | No existe **o es de otro tenant** (no confirmar existencia). |
| `invalid_transition` | 409 | Ticket: transición de estado no permitida (D9). |
| `too_many_images` | 400 | Más de 5 imágenes por mensaje (D9). |
| `invalid_image` | 400 | Tipo de imagen no permitido, validado por bytes (D9). |
| `image_too_large` | 413 | Imagen de más de 5 MB (D9). |
| `page_window_exceeded` | 400 | Bandeja con `page × pageSize` > 1000 (D9). |

## Paginación

- Query: `?page=1&pageSize=25`. `page` empieza en 1; `pageSize` máximo 100 (si no, `400 validation_error`).
- Respuesta: `{ "items": [...], "page": 1, "pageSize": 25, "total": 137 }`.

## Fechas

- Siempre ISO 8601 en UTC (`"2026-10-12T20:15:00.000Z"`) o `null`.

## Nombres

- Nada de nombres de sistemas concretos en rutas ni campos de respuesta (regla del spec). El front tiene un test que falla si aparecen en su código.

## Respuestas de las mutaciones

- El front **no depende del cuerpo** de las mutaciones salvo donde se indica (temporal de usuarios, `id` del ticket creado). Después de cada acción vuelve a pedir los datos. Aun así, se recomienda devolver el recurso actualizado.
