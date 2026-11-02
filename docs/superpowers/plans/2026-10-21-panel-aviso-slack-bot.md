# Panel — Plan 8b: aviso de tickets por bot de Slack (reemplaza el webhook del plan 8) — Plan de implementación

> **Estado:** **suspendido sin implementar** (2026-10-21). El bot también necesita una app propia de
> Smarteam en Slack, y el workspace llegó a su límite de apps. Se retoma si se libera un espacio
> (ver el plan 8).

**Por qué:** el workspace de Smarteam llegó al límite de apps de Slack, así que no se puede crear
una app nueva con Incoming Webhook. Smarteam ya tiene un bot en un canal, y ese bot puede publicar
con `chat.postMessage` usando su token y el id del canal.

**Goal:** mismo aviso del plan 8 (K1, K2 y K4 sin cambios), enviado por el bot en lugar del webhook.

**Depende de:** plan 8 (`2026-10-21-panel-aviso-slack.md`), ya ejecutado.

## Global Constraints

- Solo capa del panel. Ningún endpoint ni respuesta cambia; el núcleo tampoco.
- El aviso sigue sin afectar la creación del ticket:
  - sin `await` en el camino de la respuesta;
  - 5 s de corte y sin reintentos;
  - si falla, solo un `warn` en el log.
- El token del bot es un secreto: no se loguea ni sale en respuestas.
- `main`, sin ramas. Sin `git add`, `commit` ni `push`. Al terminar, dejar en el chat qué cambió,
  en qué archivos y por qué.

## Aplica a qué tenant

A todos, igual que el plan 8: un solo canal para todas las empresas.

## Hechos (API de Slack)

| Hecho | Nota |
|---|---|
| `POST https://slack.com/api/chat.postMessage` con `Authorization: Bearer xoxb-…`. Cuerpo JSON `{ channel, text, blocks }` | El token del bot empieza con `xoxb-` |
| Responde **HTTP 200 aunque falle**: `{ ok: false, error: 'not_in_channel' }`. Hay que leer el JSON | Los códigos de error (`invalid_auth`, `channel_not_found`, `not_in_channel`, `ratelimited`) no traen el token |
| El bot necesita el permiso `chat:write` y estar en el canal (`/invite @bot`). Con `chat:write.public` podría escribir en canales públicos sin estar invitado | Lo configura Smarteam |
| `unfurl_links: false` y `unfurl_media: false` evitan que Slack abra el enlace del panel para armar una vista previa | |

## Decisiones (cambiables antes de aprobar)

1. **Se reemplaza el webhook, no se suman dos caminos.**
   - Se quitan `PANEL_SLACK_WEBHOOK_URL`, su validación y `SlackTicketNotifier` (webhook).
   - Nada de eso está en producción todavía.
2. **Configuración** (`panel.config.js` y `.env.example`, vacías):
   - `PANEL_SLACK_BOT_TOKEN`: solo se acepta si empieza con `xoxb-`;
   - `PANEL_SLACK_CHANNEL_ID`: solo se acepta si cumple `^[CG][A-Z0-9]{8,}$` (por ejemplo,
     `C0CB28L3RK8`);
   - `PANEL_PUBLIC_URL`: sin cambios.
   - **Faltan las dos** → `NoopTicketNotifier`, sin red ni logs.
   - **Falta una o alguna es inválida** → `Noop`, y al arrancar **un** aviso que dice cuál falta
     o es inválida, **sin los valores**.
3. **Adaptador** `SlackBotTicketNotifier({ token, channelId, publicUrl, fetch, timeoutMs = 5000, logger })`
   en `src/infrastructure/notifications/`:
   - un `POST` a `chat.postMessage` con
     `{ channel, text, blocks, unfurl_links: false, unfurl_media: false }`,
     `AbortSignal.timeout(5000)` y sin reintentos (tampoco ante `ratelimited`);
   - éxito = HTTP 2xx **y** `body.ok === true`;
   - si falla, `logger.warn({ msg, tenantKey, code, status, slackError })`:
     - `slackError` es el código de Slack (`not_in_channel`…), recortado a 100 caracteres;
     - de los errores de red, solo el nombre o código, como en el plan 8;
     - **nunca** el token, el header ni el cuerpo de la respuesta;
   - no lanza nunca.
4. **Mensaje:** `buildTicketCreatedMessage` (plan 8) sin cambios. El bot agrega solo `channel` y
   los `unfurl_*`.
5. **Composición:** `buildTicketNotifier({ slackBotToken, slackChannelId, publicUrl, logger, fetch })`:
   bot si están las dos, si no `Noop`.

## Archivos

| Archivo | Acción |
|---|---|
| `src/infrastructure/notifications/SlackBotTicketNotifier.js` | Crear |
| `src/infrastructure/notifications/SlackTicketNotifier.js` | Borrar (webhook) |
| `src/infrastructure/config/panel.config.js` | `slackBotToken`, `slackChannelId` y `slackConfigProblem`; se quita lo del webhook |
| `src/interfaces/http/panel/panelPlugin.js` | Aviso de arranque con el problema de config, sin valores |
| `src/composition/panel.composition.js` | `buildTicketNotifier` con bot |
| `.env.example` | `PANEL_SLACK_BOT_TOKEN=` y `PANEL_SLACK_CHANNEL_ID=` en lugar de `PANEL_SLACK_WEBHOOK_URL=` |
| `tests/unit/infrastructure/panelTicketNotifier.test.js` | Rehacer para el bot |
| `docs/contrato-backend/10-aviso-slack.md` | Nota del backend: K3 con las variables nuevas y la configuración del bot |
| `README.md` y el plan 8 | Actualizar la sección y dejar referencia a este plan |

## Pruebas

- **Adaptador** (con `fetch` falso):
  - URL de `chat.postMessage`, header `Authorization`, cuerpo con `channel`, `text`, `blocks` y
    `unfurl_*` en `false`;
  - `signal` con timeout;
  - HTTP 200 con `ok: false` (`not_in_channel`) → `warn` con `slackError`;
  - HTTP no 2xx, error de red y timeout → `warn`;
  - **el token no aparece en ningún log**;
  - nunca lanza.
- **Config** (proceso aparte):
  - token y canal válidos → bot;
  - falta uno → `Noop` con problema "falta…";
  - token sin `xoxb-` o canal inválido → `Noop` con problema "inválido…", sin el valor;
  - sin ninguno → `Noop` sin problema.
- **Composición:** sin config no hay llamadas de red.
- **Sin cambios** (deben seguir pasando): las pruebas del mensaje, de `ClientTickets` y de
  `panelTicketsApi`.

## Configuración en Slack (la hace Smarteam)

1. En <https://api.slack.com/apps>, abrir la app del bot que ya existe → **OAuth & Permissions**.
2. En **Bot Token Scopes**, confirmar que esté `chat:write`. Si se agrega, hay que **reinstalar**
   la app en el workspace (Slack lo pide).
3. Copiar el **Bot User OAuth Token** (`xoxb-…`) en `PANEL_SLACK_BOT_TOKEN` del `.env` del VPS.
   Es un secreto.
4. En el canal de tickets, escribir `/invite @<nombre del bot>`.
5. `PANEL_SLACK_CHANNEL_ID=C0CB28L3RK8`,
   `PANEL_PUBLIC_URL=https://smartspanel.smarteamcr.com` y `docker compose up -d --build`.
6. Probar creando un ticket con una cuenta de cliente. Si no llega, el log del backend dice el
   código de Slack (`not_in_channel`, `invalid_auth`, `missing_scope`…).
