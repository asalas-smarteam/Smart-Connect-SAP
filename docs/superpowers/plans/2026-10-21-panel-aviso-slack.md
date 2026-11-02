# Panel — Plan 8: aviso de tickets nuevos en Slack (pedido 4v del front, K1 a K6) — Plan de implementación

> **Estado:** **suspendido y revertido** (2026-10-21). Se implementó y después se deshizo a pedido del
> usuario. El workspace de Slack llegó a su límite de apps, así que no se puede crear la app del
> webhook ni la del bot (plan 8b). Del cambio solo queda una cosa: la línea con el valor real de
> `PANEL_JWT_SECRET` sigue fuera de `.env.example`. La sección "Ejecución" describe lo que se hizo
> antes de revertir; sirve de guía si se retoma.

**Goal:** cuando un cliente crea un ticket, mandar un mensaje a un canal de Slack (Incoming Webhook)
con la empresa, el código, el título y el enlace a la Bandeja. **Ningún endpoint ni respuesta cambia.**

**Contrato:** `smartHubPanel/docs/contrato-backend/10-aviso-slack.md` (K1 a K6). Se copia a este
repo con una nota del backend.

**Depende de:** plan 2 (tickets, `ClientTickets.create`).

## Global Constraints

- Solo capa del panel. **No cambia el núcleo** (webhooks, syncs, rutas admin, OAuth, Bull Board).
- El aviso **nunca** afecta la creación:
  - sin `await` en el camino de la respuesta;
  - 5 s de corte y sin reintentos;
  - si falla, solo un `warn` en el log.
- La URL del webhook es un secreto: no se loguea ni sale en respuestas.
- `main`, sin ramas. Sin `git add`, `commit` ni `push`. Al terminar, dejar en el chat qué cambió,
  en qué archivos y por qué.

## Aplica a qué tenant

A todos: cualquier ticket que cree una cuenta cliente. Es un solo canal para todas las empresas.

## Hechos verificados en el código

| Hecho | Dónde |
|---|---|
| `ClientTickets.create` guarda el ticket y responde `201` con `toClientDetail(ticket)`. Si falla al guardar, borra las imágenes y relanza el error | `src/application/use-cases/panel/ClientTickets.js` |
| `ticketRepository.create` devuelve el ticket con `id`, `code` (por ejemplo `PRN-0012`) y `title` | `MongooseTicketRepository.create` |
| `ClientTickets` hoy no recibe `tenantDirectory` ni `logger`. `StaffTickets`, `StaffInbox` y `TicketMetrics` sí | `panel.composition.js` (`buildPanelTicketUseCases`) |
| `tenantDirectory.findByKey(tenantKey)` → `{ tenantKey, companyName, status }` o `null` | `SaaSClientTenantDirectory` |
| Config del panel en `panel.config.js` (lee `process.env` con dotenv) | `src/infrastructure/config/panel.config.js` |
| El contenedor usa `node:20-alpine`: `fetch` y `AbortSignal.timeout` vienen en Node | `Dockerfile` |

## Decisiones (cambiables antes de aprobar)

1. **Cuándo** (K1): solo en `ClientTickets.create`, **después** de que `ticketRepository.create`
   devolvió el ticket. Validación, contexto, imágenes o base con error → no hay aviso.
   Respuestas, reaperturas y acciones de Smarteam no avisan.
2. **Sin bloquear** (K4). Tras guardar, `create` lanza `this.notifyCreated(tenantKey, ticket)`
   **sin `await`**, con `.catch`, y responde `201` enseguida. `notifyCreated`:
   - busca `companyName` con `tenantDirectory.findByKey`. Si falla o no hay nombre, usa el
     `tenantKey`. Esa búsqueda también queda fuera del camino de la respuesta;
   - llama a `ticketNotifier.ticketCreated({ tenantKey, companyName, ticket: { id, code, title } })`.
     **Solo esos tres campos del ticket**: nada de descripción, adjuntos, contexto ni datos de
     quien lo creó;
   - cualquier rechazo inesperado → `logger.warn({ msg, tenantKey, code })`.
3. **Mensaje** (K2). Función pura `buildTicketCreatedMessage({ tenantKey, companyName, ticket, publicUrl })`
   en `src/domain/panel/ticketNotification.js`, que devuelve `{ text, blocks }` con el formato
   exacto del contrato:
   - escapa `&`, `<` y `>` en empresa, código y título (así no se rompe el enlace ni entra
     `<!channel>`);
   - enlace: `${publicUrl}/bandeja/${encodeURIComponent(tenantKey)}/${encodeURIComponent(id)}`,
     con `publicUrl` sin `/` final. Sin `publicUrl`, la segunda línea va sin enlace;
   - `text` (respaldo para la notificación) también va escapado.
4. **Configuración** (K3), en `panel.config.js`:
   - `slackWebhookUrl` = `PANEL_SLACK_WEBHOOK_URL`. Solo se acepta si empieza con `https://`.
     Si no, se trata como vacía y al arrancar se registra **un** aviso sin la URL;
   - `publicUrl` = `PANEL_PUBLIC_URL`, sin `/` final. Solo `http://` o `https://`; si no, sin
     enlace;
   - `.env.example`: las dos variables, **vacías**, con un comentario.
5. **Adaptadores** (K5), en `src/infrastructure/notifications/`:
   - `SlackTicketNotifier({ webhookUrl, publicUrl, fetch = globalThis.fetch, timeoutMs = 5000, logger })`:
     un `POST` JSON con `AbortSignal.timeout(5000)` y sin reintentos;
   - si la respuesta no es 2xx o hay error de red o timeout, hace
     `logger.warn({ msg, tenantKey, code, status })`. Para errores de red solo loguea el nombre o
     código del error (`TimeoutError`, `ECONNRESET`), **nunca** el mensaje ni la URL, porque
     podrían traerla. **No lanza** nunca;
   - `NoopTicketNotifier`: no hace nada, ni loguea.
   - En `buildPanelTicketUseCases`, `ticketNotifier` por defecto es `SlackTicketNotifier` si hay
     `slackWebhookUrl`, y si no `NoopTicketNotifier`. Las pruebas inyectan uno falso.
6. **Puerto** `TicketNotifierPort` (`ticketCreated`) en `application/ports/panel/`. `ClientTickets`
   recibe `ticketNotifier`, `tenantDirectory` y `logger`, con defaults (`Noop`, `null`, `null`)
   para que las pruebas actuales sigan igual.

## Archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/domain/panel/ticketNotification.js` | Crear | Mensaje (K2), escapado y enlace |
| `src/application/ports/panel/ticket-notifier.port.js` | Crear | Puerto |
| `src/infrastructure/notifications/SlackTicketNotifier.js` | Crear | `POST` al webhook, timeout y `warn` |
| `src/infrastructure/notifications/NoopTicketNotifier.js` | Crear | Sin webhook configurado |
| `src/infrastructure/config/panel.config.js` | Modificar | `slackWebhookUrl` y `publicUrl` |
| `src/application/use-cases/panel/ClientTickets.js` | Modificar | `notifyCreated` sin `await` después de guardar |
| `src/composition/panel.composition.js` | Modificar | Elegir el notificador y pasar `tenantDirectory` y `logger` a `ClientTickets` |
| `.env.example` | Modificar | `PANEL_SLACK_WEBHOOK_URL=` y `PANEL_PUBLIC_URL=` vacías; **quitar la línea con el valor real de `PANEL_JWT_SECRET`** (ver abajo) |
| `docs/contrato-backend/10-aviso-slack.md` | Copiar + nota | Contrato |
| `README.md` | Modificar | Sección 20 |
| Pruebas | Crear / Modificar | Ver abajo |

## Pruebas (K6)

- **Mensaje:**
  - formato exacto del contrato;
  - escapado de `&`, `<` y `>` (con `<!channel>` y `|` en el título);
  - sin `publicUrl` no hay enlace;
  - `publicUrl` con `/` final;
  - `tenantKey` e `id` codificados;
  - sin `companyName` usa el `tenantKey`;
  - no incluye descripción ni datos del usuario.
- **Caso de uso:**
  - crear llama a `ticketCreated` una vez, solo con `{ id, code, title }` y el nombre de la
    empresa;
  - validación, contexto o guardado con error → no lo llama;
  - el notificador rechaza o nunca resuelve → igual `201`;
  - `findByKey` falla → avisa con el `tenantKey`;
  - responder, reabrir y las acciones de staff no avisan.
- **Adaptador Slack** (con `fetch` falso):
  - cuerpo y headers;
  - `signal` con timeout;
  - respuesta no 2xx, error de red y timeout → `warn` con `tenantKey`, `code` y `status`, sin la
    URL en ningún campo, y sin lanzar.
- **Config y composición:**
  - sin `PANEL_SLACK_WEBHOOK_URL` → `NoopTicketNotifier` y ninguna llamada de red;
  - URL que no es `https` → `Noop`.
- **HTTP:** `POST /tickets` responde `201` con un notificador que nunca resuelve.

## Aviso aparte: secreto en el repositorio

`.env.example` tiene, al final, una línea `PANEL_JWT_SECRET=` **con un valor real**. Entró en el
commit `a261e9c`, que ya está en `origin/main`.

- El plan quita esa línea; la variable ya está declarada más arriba, vacía.
- **Quitarla no alcanza:** el valor sigue en el historial. Si se usa en algún entorno, hay que
  generar uno nuevo y cambiarlo. Al cambiarlo, se cierran las sesiones abiertas del panel.

## Ejecución

Hecho según el plan, con un ajuste:

- **Nuevos:**
  - `ticketNotification.js`: mensaje, escapado y enlace;
  - el puerto `ticket-notifier.port.js`;
  - los adaptadores `SlackTicketNotifier.js` y `NoopTicketNotifier.js`.
- **Ajuste:** `SlackTicketNotifier` loguea `error.cause.code` o `error.code` solo si son texto; si
  no, el nombre del error. Un timeout de `fetch` trae un `code` numérico (23), y así queda
  `TimeoutError`.
- `panel.config.js`: `slackWebhookUrl` (solo `https`), `slackWebhookUrlInvalid` y `publicUrl`.
  `panelPlugin.js` avisa una vez si la URL no es `https`, sin incluirla.
- `ClientTickets`: `notifyCreated` sin `await` después de guardar. Recibe `ticketNotifier`,
  `tenantDirectory` y `logger`, con valores por defecto.
- `panel.composition.js`:
  - `buildTicketNotifier`: Slack si hay webhook, si no `Noop`;
  - el parámetro `ticketNotifier` en `buildPanelTicketUseCases` y `buildPanelUseCases`.
- `.env.example`:
  - `PANEL_SLACK_WEBHOOK_URL=` y `PANEL_PUBLIC_URL=`, vacías;
  - **quitada la línea con el valor real de `PANEL_JWT_SECRET`**.
- **Pruebas:**
  - nuevas: `panelTicketNotification` (dominio) y `panelTicketNotifier` (adaptador, composición
    y config en un proceso aparte);
  - ampliadas: `clientTickets` (seis casos K1 a K4) y `panelTicketsApi` (`201` con un
    notificador que nunca termina, sin aviso si la creación falla);
  - `RecordingTicketNotifier` en `ticketFakes`;
  - `routeAuthWiring` y la integración `panelTickets` inyectan un notificador falso, para que un
    `.env` local con webhook no mande mensajes reales.
- **Pendiente del usuario:** cambiar el `PANEL_JWT_SECRET` filtrado en `a261e9c` si se usa en
  algún entorno.
