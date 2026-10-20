# Endurecimiento del acceso (para el front)

Cambios del backend en `/panel/api` que el front debe conocer. Spec: `docs/superpowers/specs/2026-10-13-panel-acceso-endurecimiento-design.md` del repo `SAP`. Copiar este archivo a la carpeta `contrato-backend/` de `smartHubPanel`.

## R5. Nuevo 429 por saturación

- Las rutas que calculan contraseñas pueden responder **429** `{ "error": "too_many_attempts", "message": "Hay demasiados intentos en este momento. Intenta de nuevo en unos segundos." }` con el header `Retry-After: 5`:
  - `POST /auth/login`
  - `POST /auth/change-password`
  - `POST /staff/users`
  - `POST /staff/users/:id/reset-password`
- Solo pasa bajo carga anormal. El front muestra `message` y no reintenta solo.

## Límite de login por IP

- `POST /auth/login` también da **429 `too_many_attempts`** tras 30 intentos desde la misma IP en 15 min, además del límite por correo que ya existía. Mismo código y mismo tratamiento en el front.

## Logout

- Sin cambios para el front: sigue respondiendo **204** siempre. Ahora además invalida esa sesión en el servidor; las otras sesiones del mismo usuario siguen abiertas.

## nginx del panel (plan 4)

El backend lee la IP del cliente de `X-Forwarded-For` solo si la petición viene de un proxy listado en `PANEL_TRUSTED_PROXIES`. El nginx del panel debe mandar el header, y conviene que además limite el login:

```nginx
# http {}
limit_req_zone $binary_remote_addr zone=panel_login:10m rate=10r/m;

# server {}
location = /api/auth/login {
    limit_req zone=panel_login burst=5 nodelay;
    limit_req_status 429;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://api:3000/panel/api/auth/login;
}

location /api/ {
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://api:3000/panel/api/;
}
```

**A verificar al desplegar:** si delante del nginx del panel hay otro proxy con TLS, `$binary_remote_addr` es la IP de ese proxy. Hace falta `real_ip_header X-Forwarded-For;` y `set_real_ip_from <red del proxy>;` en el nginx del panel, y la red de ese proxy también en `PANEL_TRUSTED_PROXIES` del backend.
