# smartHubPanel: alcance general y Fase 1 (acceso, soporte, eventos y syncs)

## Contexto

El conector hoy se administra por Postman con `x-internal-key` (llave que abre **todos** los tenants y que nunca debe llegar a un navegador). No hay forma de que un cliente vea qué pasó con su integración ni de reportar un problema con contexto.

El panel es **un solo portal para dos públicos**:

- **Cliente** (usuarios de la empresa cliente): reportan problemas, siguen su estado, leen la respuesta y ven qué pasó con sus eventos y syncs.
- **Smarteam** (equipo interno): ve en una bandeja los problemas de **todos** los tenants, responde, los resuelve y opera la integración.

Decisiones previas que este spec respeta: dashboard propio (no dentro de HubSpot), instalaciones privadas, Fase A y enmascarado de secretos ya desplegados (`5fd5978`).

## Decisiones del usuario (2026-10-12)

| Tema | Decisión |
|---|---|
| Soporte | Dentro del panel. **Sin asignaciones, sin correos, sin SLA.** Bandeja única de Smarteam con todos los tenants. |
| Cierre | Smarteam marca **resuelto**. Si el error persiste, el cliente lo **devuelve a abierto**. |
| Notas | Dos: (1) **respuesta al cliente**, con texto e imágenes; (2) **resolución interna**, que el cliente nunca ve, para que a futuro una IA aprenda cómo se resolvieron los casos. |
| Imágenes | Sí desde la Fase 1, para dar contexto del problema. |
| Login | HubSpot si se puede; si no, usuario y contraseña que entrega Smarteam, con **cambio obligatorio en el primer ingreso**. |
| Cuentas y roles | **Smarteam es un tipo de cuenta aparte.** Dentro de cada empresa cliente hay dos roles, **`admin`** y **`usuario`**, y una empresa puede tener **varios usuarios de cada rol**. Las rutas se protegen por usuario y rol. |
| Visibilidad | Todo usuario de una empresa ve **todos los tickets de su empresa**, no solo los suyos. |
| Alta de usuarios | **Solo Smarteam** crea, desactiva y restablece usuarios. |
| Dónde viven los datos | **Tickets en la base de cada tenant.** Lo administrativo (usuarios del panel, tenants) en la **master**. |
| Proyecto del frontend | **Proyecto aparte con su propio git: `smartHubPanel`.** Frontend y backend no comparten código; hablan solo por HTTP. |
| Alcance | **Por ahora solo este backend.** No se diseña para varias integraciones (no hay fecha para una segunda). |
| Nombres | **Todo genérico, sin "SAP" ni "HubSpot"** en el frontend (nombres de archivos, rutas, textos de la UI) ni en el contrato de `/panel/api` (rutas y campos de las respuestas). La API traduce los nombres internos (ver §3). |
| Dominio | Por definir; probablemente `panel.smarteamcr.com`. No bloquea los planes 1 a 3. |
| Infraestructura | Servidor en **Hostinger**, despliegue con **Docker**, base **MongoDB**. |
| Tablas | **Todas paginadas.** Los campos JSON se muestran **formateados**. |
| Diseño | **Por ahora no.** Prioridad: funcionalidad. Se usan los estilos por defecto de los componentes. |
| Control de calidad | Registrar **cuándo se abrió y cuándo se cerró** cada ticket. |
| Futuro | Claude API resolverá algunos casos. |

## Cuentas, roles y permisos

| Tipo de cuenta | Rol | Dónde vive | Alcance |
|---|---|---|---|
| `smarteam` | — | `PanelUsers` (master), sin `tenantKey` | Todos los tenants, incluidos los suspendidos. |
| `cliente` | `admin` o `usuario` | `PanelUsers` (master), con `tenantKey` | Solo su empresa. El tenant sale **siempre de la sesión**, nunca de un parámetro. |

**Las rutas se protegen por permiso, no por nombre de rol.** Cada ruta declara el permiso que necesita (`requirePermission('tickets.create')`), y una tabla en código dice qué permisos tiene cada rol. Así, cuando en la Fase 2 el `admin` del cliente gane acciones que el `usuario` no tiene, solo cambia la tabla, no las rutas.

| Permiso | Smarteam | Cliente `admin` | Cliente `usuario` | Fase |
|---|---|---|---|---|
| `tickets.read`, `tickets.create`, `tickets.reply`, `tickets.reopen` | — (usa los de staff) | ✓ | ✓ | 1 |
| `events.read`, `syncs.read` | ✓ (cualquier tenant) | ✓ | ✓ | 1 |
| `staff.tickets` (bandeja, responder, resolver, nota interna) | ✓ | | | 1 |
| `staff.users` (crear, desactivar, restablecer) | ✓ | | | 1 |
| `staff.events.raw` (ver `payload` y `audit`) | ✓ | | | 1 |
| `events.retry`, `owners.edit`, `config.read`, `mappings.read` | ✓ | ✓ | | 2 |
| `config.edit`, `mappings.edit`, `credentials.edit`, `sync.run`, `tenants.create` | ✓ | | | 3 |

**En la Fase 1, `admin` y `usuario` del cliente tienen los mismos permisos.** La diferencia aparece en la Fase 2, con las acciones que pueden romper algo (reintentar, editar vendedores). El rol se guarda desde el primer día para que no haya que migrar usuarios después.

## Casos de uso (todas las funcionalidades del panel)

Fases: **1** = este spec. **2** = acciones operativas. **3** = herramientas de Smarteam. **Futuro** = después de estabilizar.

### Acceso

| # | Actor | Historia | Cómo lo vive | Fase |
|---|---|---|---|---|
| A1 | Smarteam | Dar acceso a un cliente nuevo | Termina de instalar a "Printer". En **Usuarios** crea a la jefa de ventas como `admin` y a dos vendedores como `usuario`. El panel genera una contraseña temporal por persona y la muestra **una sola vez**. El dev se las pasa por el canal que ya usan con el cliente (el panel no manda correos). | 1 |
| A2 | Cliente | Entrar por primera vez | Un vendedor de Printer entra con su temporal y el panel no lo deja hacer nada hasta que elige una contraseña propia. Desde ahí, nadie en Smarteam la conoce. | 1 |
| A3 | Cliente | Olvidó la contraseña | Escribe a Smarteam. Un dev entra a **Usuarios**, pulsa "Restablecer" y le pasa la nueva temporal; al entrar se le pide que la cambie. Su sesión vieja queda invalidada. | 1 |
| A4 | Smarteam | Quitar acceso | Un vendedor deja la empresa. El dev lo **desactiva**; su sesión abierta deja de funcionar en el siguiente request. | 1 |
| A5 | Smarteam | Cambiar el rol de alguien | Un vendedor pasa a jefe. El dev le cambia el rol de `usuario` a `admin`; el cambio rige en el siguiente request. | 1 |
| A6 | Cliente | Entrar con HubSpot | Pulsa "Entrar con HubSpot", autoriza, y el panel verifica que su cuenta pertenece al portal del tenant **y** que su correo está dado de alta como usuario. | 1b (tras verificar, ver §5) |
| A7 | Smarteam | Entrar al panel | Entra con su cuenta de Smarteam y ve la bandeja de todos los tenants. La primera cuenta de Smarteam se crea con un script desde el servidor. | 1 |

### Soporte (tickets)

| # | Actor | Historia | Cómo lo vive | Fase |
|---|---|---|---|---|
| S1 | Cliente | Reportar un problema | Una cotización no llegó a SAP. Entra a **Soporte → Nuevo**, elige la categoría "Documentos", describe qué pasó y pega dos capturas con Ctrl+V. Recibe el número `PRINTER-0007` y lo ve en estado **Abierto**. | 1 |
| S2 | Cliente | Reportar desde un evento fallido | En **Eventos** ve un `createQuotation` en rojo con el error de SAP. Pulsa **Reportar problema**: el ticket se crea con el evento enlazado y el error ya copiado. No tiene que explicar nada técnico. | 1 |
| S3 | Cliente | Reportar desde una sync fallida | Igual que S2, desde una corrida de **Syncs** con errores. | 1 |
| S4 | Cliente | Seguir un caso de un compañero | La jefa de ventas ve en **Soporte** los tickets de toda su empresa, incluido el que abrió un vendedor que está de vacaciones, y contesta ella. | 1 |
| S5 | Smarteam | Ver todo lo pendiente | Abre la **Bandeja**: todos los tickets de todos los tenants, paginados, primero los de actividad más reciente, con filtros por estado, tenant y categoría, y contadores por estado arriba. | 1 |
| S6 | Smarteam | Entender el problema | Abre `PRINTER-0007`: ve la descripción, las capturas y, como vino de un evento, el `eventType`, el estado y el `lastError` del evento, con el JSON formateado, sin salir del panel. | 1 |
| S7 | Smarteam | Responder | Escribe "Lo estamos revisando, el código de artículo no existe en SAP" y adjunta una captura. El ticket pasa solo a **En progreso** y queda registrada la **primera respuesta**. | 1 |
| S8 | Smarteam | Pedir información | Necesita saber qué lista de precios usó el vendedor. Responde y marca **Esperando cliente**. | 1 |
| S9 | Cliente | Contestar | Ve el indicador de **respuesta nueva** en su lista, contesta con otra captura y el ticket vuelve solo a **En progreso**. | 1 |
| S10 | Smarteam | Resolver | Corrige el mapeo. Pulsa **Resolver**: el panel le exige dos textos: el **mensaje al cliente** ("Corregimos el mapeo, reenvía la cotización") y la **resolución interna** ("FieldMapping ItemCode apuntaba a hs_sku; se cambió a sku_sap. Causa: alta nueva del cliente"). Queda la fecha de cierre. | 1 |
| S11 | Cliente | Reabrir | El error vuelve a aparecer. Abre el ticket resuelto, pulsa **Sigue fallando**, escribe por qué y vuelve a **Abierto**. Se suma un contador de reaperturas. | 1 |
| S12 | Smarteam | Control de calidad | En cada ticket ve la línea de tiempo: abierto, primera respuesta, cada cambio de estado con quién y cuándo, resuelto y reaperturas. | 1 |
| S13 | Smarteam | Métricas de calidad | Un reporte con tiempo medio a primera respuesta, tiempo medio de resolución y tasa de reapertura, por tenant, categoría y dev. Los datos ya los guarda la Fase 1. | 2 |
| S14 | Smarteam | Abrir un ticket en nombre del cliente | El cliente avisó por WhatsApp; el dev lo registra igual en el panel para que quede la trazabilidad. | 2 |
| S15 | Smarteam + IA | Sugerencia de Claude | Al abrir un ticket, Claude lee la descripción, el error enlazado y las **resoluciones internas** de casos parecidos, y redacta una respuesta. El dev la revisa y la envía o la corrige. | Futuro |
| S16 | IA | Respuesta automática | Para categorías donde las sugerencias resultaron confiables, Claude responde directo y el ticket queda marcado como respondido por IA. | Futuro |

### Eventos y syncs

| # | Actor | Historia | Cómo lo vive | Fase |
|---|---|---|---|---|
| E1 | Cliente | ¿Llegó mi cotización a SAP? | En **Eventos** filtra por el id del negocio y ve sus eventos, paginados, con estado, reintentos y el último error. No ve el payload ni la auditoría interna. | 1 |
| E2 | Cliente | ¿Corrió la sync de anoche? | En **Syncs** ve cada corrida por tarea: hora, registros procesados, enviados, fallidos, omitidos con su motivo, y el error si lo hubo. | 1 |
| E3 | Smarteam | Lo mismo, para cualquier tenant | Elige el tenant y ve sus eventos y syncs, incluidos los de tenants suspendidos. En el detalle de un evento ve además el `payload` y la auditoría (`audit`) como JSON formateado y plegable. | 1 |
| E4 | Cliente `admin` / Smarteam | Reintentar un evento fallido | Pulsa **Reintentar** en un evento `errored`; vuelve a la cola. | 2 |
| E5 | Cliente / Smarteam | Estado de la integración | Una portada con: conexión a HubSpot válida, conexión a SAP, última corrida de cada tarea y eventos fallidos de las últimas 24 h. | 2 |
| E6 | Smarteam | Eventos de precios | Ver los eventos de `LineItemPriceWebhookEvent` (webhook de line-items/prices). | 2 |
| E7 | Smarteam | Reportes de calidad de datos | Ver los `WebhookEvents` con `status: 'report'` en su propia pestaña. | 2 |
| E8 | Smarteam | Logs técnicos | Buscar en el log del servidor por tenant y rango de fechas. Nunca visible para el cliente: mezcla a todos los tenants. | 3 |

### Configuración y operación

| # | Actor | Historia | Cómo lo vive | Fase |
|---|---|---|---|---|
| C1 | Cliente `admin` | Mapear un vendedor nuevo | Entró un vendedor; en **Vendedores** relaciona su owner de HubSpot con su código de SAP, sin pedirlo a Smarteam. | 2 |
| C2 | Cliente `admin` | Ver los mapeos de campos | Ve qué propiedad de HubSpot va a qué campo de SAP, por objeto y dirección. Solo lectura. | 2 |
| C3 | Smarteam | Editar mapeos de campos | Edita un FieldMapping y lo prueba con datos de ejemplo antes de guardar (ya existe `POST /mapping/test`). | 3 |
| C4 | Cliente `admin` | Ver la configuración | Ve qué tareas están activas y en qué horario. Solo lectura. | 2 |
| C5 | Smarteam | Editar configuración y credenciales | Edita tareas, horarios y credenciales SAP. Las credenciales se ven siempre como `********`. | 3 |
| C6 | Smarteam | Ejecutar una sync a mano | Reemplaza el `POST /sap-sync/run` de Postman. | 3 |
| C7 | Smarteam | Dar de alta un tenant | Reemplaza los pasos de Postman: crea el tenant, genera el link de instalación de HubSpot y, al terminar, crea los primeros usuarios (A1). | 3 |

## Arquitectura general

```
                       Hostinger VPS (Docker)
 navegador ──HTTPS──▶  proxy con TLS (el actual)
                          │
                          ├─ dominio del panel/      ─▶ contenedor smartHubPanel (nginx + build estático)
                          │  (por definir, p. ej.        └─ /api/*  ─▶ http://api:3000/panel/api/*
                          │   panel.smarteamcr.com)                    (red docker compartida)
                          └─ smartsap.smarteamcr.com ─▶ contenedor api (sin cambios)
```

- **Dos proyectos, dos repos de git.**
  - **Backend** (este repo, `SAP`): agrega **solo** los endpoints `/panel/api/*`, con la misma arquitectura hexagonal. Casos de uso en `src/application/use-cases/`, repositorios en `src/infrastructure/database/repositories/`, rutas y controladores en `src/interfaces/http/`, cableado en `src/composition/`. Los controladores no importan `mongoose` ni `fastify` (`tests/unit/architecture/hexagonalBoundaries.test.js:105`).
  - **Frontend** (repo nuevo `smartHubPanel`, carpeta hermana `C:\Users\ale_1\OneDrive\Escritorio\Proyectos\smartHubPanel`): solo pantallas. No importa nada del backend. El contrato es la API HTTP descrita en este spec.
- **Mismo origen para el navegador.** El contenedor del panel sirve el build y reenvía `/api/*` al contenedor `api` por una red de Docker compartida. El navegador solo ve el dominio del panel: no hace falta CORS y la cookie de sesión es de ese dominio. El diseño funciona igual sea cual sea el dominio final.
- **En desarrollo** se usa el mismo esquema: el proxy de Vite manda `/api` a `http://localhost:3000/panel/api`.
- **Nada existente cambia de comportamiento.** Webhooks, syncs y rutas admin de Postman siguen igual, y el `Dockerfile` del backend no se toca.

### Stack del frontend

| Necesidad | Elección |
|---|---|
| Base | Vite + React + TypeScript (SPA, build estático) |
| Estilos | Tailwind CSS v4 |
| Componentes | shadcn/ui (Radix + Tailwind) con su tema por defecto; **sin trabajo de diseño en la Fase 1** |
| Íconos | lucide-react |
| Gráficos | shadcn charts (Recharts), recién para S13 y E5 en la Fase 2 |
| Datos del servidor | TanStack Query |
| Tablas | TanStack Table, con **paginación del servidor** en todas |
| Formularios | React Hook Form + Zod |
| Rutas | React Router |
| Fechas | date-fns con locale `es` |
| JSON | Visor JSON formateado y plegable para todo campo `Mixed` (`context.snapshot`, `errors`, `errorMessage`, `payload`, `audit`); la librería se fija en el plan |
| Imágenes | Input de archivo + **pegar desde el portapapeles (Ctrl+V)** |
| Tests | Vitest + Testing Library |
| Calidad | ESLint + Prettier |
| Contenedor | Dockerfile multi-etapa del repo del panel: `node` compila, `nginx:alpine` sirve `dist/` con fallback a `index.html` y el proxy de `/api` |

**No se usa Next.js.** Es un panel detrás de login, sin SEO: el SSR no aporta, agrega un proceso Node más que mantener en producción, y sus server actions invitan a poner lógica de backend en el frontend, que es lo que la separación quiere evitar. Las versiones exactas se fijan en el plan, verificadas contra npm.

## Fase 1 en detalle

### 1. Acceso

**Modelo `PanelUser` (master, colección `PanelUsers`)**, junto a `SaaSClient` en `src/infrastructure/database/models/global/`:

| Campo | Tipo | Notas |
|---|---|---|
| `email` | String, único, lowercase | Usuario de login. Único en todo el panel: una persona de dos empresas necesita dos correos. |
| `name` | String | Se muestra como autor de los mensajes. |
| `accountType` | `'smarteam' \| 'cliente'` | |
| `tenantKey` | String \| null | Obligatorio si `accountType === 'cliente'`; `null` para Smarteam. Debe existir en `SaaSClients`. |
| `role` | `'admin' \| 'usuario'` \| null | Obligatorio si `accountType === 'cliente'`; `null` para Smarteam. |
| `passwordHash` | String | `crypto.scrypt` de Node con sal aleatoria por usuario. Sin dependencia nueva. |
| `mustChangePassword` | Boolean | `true` al crear y al restablecer. |
| `active` | Boolean | `false` = desactivado (A4). |
| `tokenVersion` | Number | Se incrementa al cambiar o restablecer la contraseña y al desactivar: invalida las sesiones abiertas. |
| `lastLoginAt`, `createdAt`, `updatedAt`, `createdBy` | | |

**Sesión:**
- `POST /panel/api/auth/login` `{ email, password }` → cookie `panel_session` con un JWT `{ sub, tv, pwdChange, exp }`. El JWT **no** lleva rol ni tenant: se leen del usuario en cada request, así un cambio de rol (A5) o una desactivación rigen de inmediato.
- Cookie `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`, 8 h de vida. `Path=/api` porque el navegador ve la API en `<dominio del panel>/api`. `Secure` funciona también en `http://localhost` durante el desarrollo.
- Firmada con una variable **nueva, `PANEL_JWT_SECRET`**, distinta de `JWT_SECRET`. Motivo verificado: `tenantResolver` acepta cualquier bearer firmado con `JWT_SECRET` que traiga `tenantKey` (`src/interfaces/http/middlewares/tenantResolver.js:86-89`). Si el panel usara ese secreto, una sesión de cliente abriría también los webhooks de su tenant.
- **Hook de sesión** (`onRequest` en el plugin encapsulado de `/panel/api`): verifica la firma, carga el `PanelUser` por `sub` y rechaza con `401` si no existe, si `active === false` o si `tokenVersion !== tv`. Deja en `req.panelUser` `{ id, name, accountType, role, tenantKey, permissions }`. Es una consulta a la master por request, aceptable para un panel.
- **Guard por permiso**, `requirePermission(perm)`, como `preHandler` de cada ruta: `403` si el usuario no lo tiene. Las rutas de cliente además resuelven el tenant desde `req.panelUser.tenantKey` y cargan `getTenantModels` (`src/infrastructure/database/tenant/tenantDatabase.js:46-49`). **No** reusan `tenantResolver` ni `adminTenantResolver`, que leen el tenant del request.
- Con `pwdChange: true` solo responden `POST /panel/api/auth/change-password` y `POST /panel/api/auth/logout`; el resto da `403 { error: 'password_change_required' }`.
- `POST /panel/api/auth/logout` borra la cookie. `GET /panel/api/auth/me` devuelve `{ name, email, accountType, role, tenantKey, companyName, permissions, mustChangePassword }`. El frontend usa `permissions` solo para mostrar u ocultar botones.
- Las mutaciones exigen además el header `X-Panel-Request: 1`, como defensa CSRF extra a `SameSite=Strict`: un formulario de otro sitio no puede mandar headers propios.
- **Límite de intentos:** 5 logins fallidos por email cada 15 min (contador en el Redis existente). Es por email y no por IP porque Fastify no tiene `trustProxy` (`src/infrastructure/config/app.config.js:26-30`) y detrás del proxy todas las requests llegan con la misma IP. Activar `trustProxy` es una decisión de despliegue aparte. El error es el mismo para "usuario no existe" y "contraseña incorrecta".
- **Contraseñas:** mínimo 10 caracteres; la nueva no puede ser igual a la temporal.

**Usuarios (permiso `staff.users`):**
- `GET /panel/api/staff/users?tenantKey=&page=&pageSize=`
- `POST /panel/api/staff/users` `{ email, name, accountType, tenantKey?, role? }` → `{ user, temporaryPassword }`. La temporal se devuelve **una sola vez** y no se guarda en claro.
- `POST /panel/api/staff/users/:id/reset-password` → `{ temporaryPassword }`
- `PATCH /panel/api/staff/users/:id` `{ name?, role?, active? }`. Cambiar `tenantKey` o `accountType` no se permite: se crea otro usuario.

**Primera cuenta de Smarteam:** script `scripts/create-panel-staff.js <email> <name>` que imprime la temporal. Se corre una vez en el servidor (`docker compose exec api node scripts/create-panel-staff.js ...`).

**Estado del tenant:** el login de un cliente no depende del 402 de `attachTenant` (`tenantResolver.js:110-118`). Un cliente de un tenant suspendido puede entrar y usar Soporte. Decisión por defecto, cambiable.

### 2. Soporte (tickets)

**Dónde:** colecciones `Tickets` y `TicketCounters` en la **base de cada tenant**, registradas en `registerTenantModels` (`src/infrastructure/database/models/tenant/index.js:20-44`). Las imágenes van en un bucket GridFS `TicketAttachments` de la **misma base del tenant**.

**Modelo `Ticket`:**

| Campo | Tipo | Notas |
|---|---|---|
| `number` | Number, único | Correlativo por tenant (`TicketCounters`, `findOneAndUpdate` con `$inc` y `upsert`). |
| `code` | String | `${TENANTKEY}-${number con 4 dígitos}`, ej. `PRINTER-0007`. Único también en la bandeja global. |
| `title` | String ≤ 150 | |
| `description` | String ≤ 5000 | |
| `category` | `'sincronizacion' \| 'documentos' \| 'precios' \| 'mapeos' \| 'acceso' \| 'otro'` | Genéricas: "documentos" cubre cotizaciones, pedidos y similares. |
| `status` | `'abierto' \| 'en_progreso' \| 'esperando_cliente' \| 'resuelto'` | |
| `context` | `{ type: 'webhookEvent' \| 'syncLog', refId, snapshot }` \| null | `snapshot` copia `eventType`, `status` y `lastError` del evento (o los contadores y el `errorMessage` de la sync) al crear el ticket, para no depender de que el registro siga existiendo. |
| `createdBy` | `{ userId, name, role }` | |
| `messages` | array | `{ _id, authorType: 'cliente' \| 'smarteam' \| 'ia', authorId, authorName, body ≤ 5000, attachments: [{ fileId, filename, contentType, size }], createdAt }`. El valor `'ia'` queda reservado y no se usa en la Fase 1. |
| `internalResolution` | `{ text, updatedAt, updatedBy }` \| null | **Solo Smarteam.** Nunca sale en una respuesta a un cliente. |
| `statusHistory` | array | `{ from, to, byType, byId, byName, at }` |
| `openedAt` | Date | |
| `firstResponseAt` | Date \| null | Primer mensaje de Smarteam. |
| `resolvedAt` | Date \| null | Última resolución. Las anteriores quedan en `statusHistory`. |
| `reopenCount` | Number | |
| `lastActivityAt`, `lastPublicAuthorType` | | Para ordenar la bandeja y calcular novedades. |
| `clientLastSeenAt`, `staffLastSeenAt` | Date | Indicador de "respuesta nueva": hay novedad si `lastActivityAt` es posterior a la última vista y el último autor es del otro lado. Es por ticket, no por usuario: la empresa cliente comparte la vista. |

Los mensajes y el historial van **embebidos**. Un ticket tiene decenas de mensajes, no miles, y las imágenes viven en GridFS, así que el documento queda muy lejos del límite de 16 MB.

**Transiciones:**

| De → a | Quién | Cómo |
|---|---|---|
| (nuevo) → `abierto` | cliente | Crea el ticket. |
| `abierto` → `en_progreso` | Smarteam | Automática con su primer mensaje; también fija `firstResponseAt`. |
| `en_progreso` → `esperando_cliente` | Smarteam | Manual, al pedir información. |
| `esperando_cliente` → `en_progreso` | cliente | Automática cuando un usuario del cliente responde. |
| cualquiera menos `resuelto` → `resuelto` | Smarteam | Acción **Resolver**. Exige `message` (al cliente) **y** `internalResolution` (texto). |
| `resuelto` → `abierto` | cliente | Acción **Sigue fallando**. Exige mensaje. Suma `reopenCount`. |
| `resuelto` → `en_progreso` | Smarteam | Por si Smarteam necesita volver a trabajarlo. |

Cualquier otra transición da `409`. No se borran tickets ni se editan mensajes: son el registro de calidad.

**Paginación (todas las listas del panel):** `?page=1&pageSize=25`, con `pageSize` máximo 100. La respuesta es `{ items, page, pageSize, total }`.

**API del cliente** (el tenant sale de la sesión):

| Método y ruta | Permiso | Qué hace |
|---|---|---|
| `GET /panel/api/tickets?status=&category=&page=&pageSize=` | `tickets.read` | Lista de su empresa sin `messages` ni `internalResolution`, con `hasNews`. |
| `POST /panel/api/tickets` (multipart: `title`, `description`, `category`, `contextType?`, `contextId?`, `images[]`) | `tickets.create` | Si trae contexto, busca ese evento o esa sync **en la base del tenant de la sesión**; si no está ahí, `404`. |
| `GET /panel/api/tickets/:id` | `tickets.read` | Detalle **sin `internalResolution`**. Marca `clientLastSeenAt`. |
| `POST /panel/api/tickets/:id/messages` (multipart: `body`, `images[]`) | `tickets.reply` | |
| `POST /panel/api/tickets/:id/reopen` `{ message }` | `tickets.reopen` | |
| `GET /panel/api/tickets/:id/attachments/:fileId` | `tickets.read` | Devuelve la imagen. |

**API de Smarteam** (permiso `staff.tickets`):

| Método y ruta | Qué hace |
|---|---|
| `GET /panel/api/staff/tickets?status=&tenantKey=&category=&page=&pageSize=` | Bandeja global con `tenantKey` y `companyName`. |
| `GET /panel/api/staff/tickets/summary` | Contadores por estado y tenant. |
| `GET /panel/api/staff/tenants/:tenantKey/tickets/:id` | Detalle **con** `internalResolution`. Marca `staffLastSeenAt`. |
| `POST /panel/api/staff/tenants/:tenantKey/tickets/:id/messages` (multipart) | Responder. |
| `POST /panel/api/staff/tenants/:tenantKey/tickets/:id/status` `{ to: 'esperando_cliente' \| 'en_progreso' }` | Cambio manual de estado. |
| `POST /panel/api/staff/tenants/:tenantKey/tickets/:id/resolve` (multipart: `message`, `internalResolution`, `images[]`) | Resolver. |
| `PUT /panel/api/staff/tenants/:tenantKey/tickets/:id/internal-resolution` `{ text }` | Completar o corregir la nota interna después. |
| `GET /panel/api/staff/tenants/:tenantKey/tickets/:id/attachments/:fileId` | Devuelve la imagen. |

`:tenantKey` se valida contra `SaaSClients`; si no existe, `404`.

**Bandeja global con tickets por tenant.** Como cada tenant tiene su base, la bandeja consulta **todas en paralelo**:
1. `SaaSClient.find({})`: todos los tenants, incluidos los suspendidos. Hoy la única lista existente filtra por `status: 'active'` (`src/infrastructure/tenants/tenantSubscriptions.js:36`).
2. Por cada tenant: `getTenantModels(tenantKey)` (conexiones cacheadas, `src/infrastructure/database/tenant/tenantDatabase.js:7,27-31`), `countDocuments(filtro)` y `find(filtro)` sin `messages`, ordenado por `lastActivityAt` desc, con `limit = page × pageSize`.
3. Mezcla, ordena, toma la página pedida y devuelve `total` = suma de los conteos.

`page × pageSize` tiene un tope de 1000: más allá se pide filtrar. Si un tenant falla (base caída), la bandeja devuelve los demás más `warnings: [{ tenantKey, error }]`: un tenant roto no deja a Smarteam sin bandeja. Con 4 tenants hoy, y decenas a mediano plazo, alcanza. Si crecen a cientos, ver alternativas.

**Índices de `Tickets`:** `{ number: 1 }` único, `{ status: 1, lastActivityAt: -1 }` y `{ lastActivityAt: -1 }`. Se crean solos con `autoIndex` en colecciones nuevas, sin backfill.

**Imágenes:**
- Hasta 5 por mensaje y 5 MB cada una. Formatos PNG, JPEG o WebP, **validados por los bytes iniciales del archivo**, no por la extensión ni por el `Content-Type` que manda el navegador. SVG queda prohibido porque puede llevar scripts.
- Se guardan en GridFS con `metadata: { ticketId }`. La descarga verifica que `fileId` pertenezca a **ese** ticket del tenant correcto.
- Se sirven con el `Content-Type` detectado, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` y `Cache-Control: private`.
- Dependencia nueva en el backend: `@fastify/multipart`, en la rama compatible con Fastify 4 (la versión exacta se fija en el plan). El límite de tamaño se aplica en el parser, no después de leer el archivo entero.

### 3. Eventos y syncs (solo lectura)

**Eventos** (`WebhookEvents` del tenant, `src/infrastructure/database/models/tenant/WebhookEvent.js`):

| Método y ruta | Permiso |
|---|---|
| `GET /panel/api/events?status=&type=&reference=&from=&to=&page=&pageSize=` | `events.read` |
| `GET /panel/api/events/:id` | `events.read` |
| `GET /panel/api/staff/tenants/:tenantKey/events?…` | `events.read` (Smarteam) |
| `GET /panel/api/staff/tenants/:tenantKey/events/:id` | `events.read` (Smarteam); suma `payload` y `audit` con `staff.events.raw` |

**Contrato genérico del evento.** La API traduce los nombres internos; el frontend nunca ve `sapAudit` ni `hs_object_id`:

| Campo de la respuesta | Origen interno |
|---|---|
| `id` | `_id` |
| `type` | `eventType` |
| `status` | `status` |
| `retries`, `maxRetries` | iguales |
| `lastError` | `lastError` |
| `reference` | `payload.deal.hs_object_id` (el id del negocio en el CRM), o `null` |
| `createdAt`, `updatedAt` | iguales |
| `payload` (solo Smarteam con `staff.events.raw`) | `payload` |
| `audit` (solo Smarteam con `staff.events.raw`) | `sapAudit` (`WebhookEvent.js:57-60`) |

- El cliente **nunca** recibe `payload` ni `audit` (`WebhookEvent.js:12-15,57-60`).
- Las listas excluyen `status: 'report'` (`WebhookEvent.js:25-31`), que son reportes de calidad y no webhooks (E7, Fase 2).

**Syncs** (`SyncLogs` del tenant, `src/infrastructure/database/models/tenant/SyncLog.js`):

| Método y ruta | Permiso |
|---|---|
| `GET /panel/api/syncs?taskId=&status=&from=&to=&page=&pageSize=` | `syncs.read` |
| `GET /panel/api/syncs/:id` | `syncs.read` |
| `GET /panel/api/staff/tenants/:tenantKey/syncs[/:id]` | `syncs.read` (Smarteam) |

**Contrato genérico de la sync:**

| Campo de la respuesta | Origen interno |
|---|---|
| `id` | `_id` |
| `task` | `{ id, name, type }` desde `clientConfigId` → `ClientConfig.clientName` y `taskType` (`src/infrastructure/database/models/tenant/ClientConfig.js:77,86`) |
| `objectType`, `status` | iguales |
| `counts` | `{ processed: recordsProcessed, sent, failed, updated, skipped }` |
| `skippedReasons`, `errorMessage`, `startedAt`, `finishedAt` | iguales |
| `errors` (solo en el detalle, con su propio `page` y `pageSize`) | `errors` |

- Del `ClientConfig` nunca se devuelve nada más que `clientName` y `taskType`: ahí viven `apiToken` y `externalDbPassword`.

**Índices:** `WebhookEvents` hoy indexa `eventType` y `status` por separado (`WebhookEvent.js:10,34`), sin `createdAt`. Las listas ordenadas por fecha necesitan `{ createdAt: -1 }` y `{ status: 1, createdAt: -1 }`, y `SyncLogs` necesita `{ startedAt: -1 }`. Sobre colecciones existentes, `autoIndex` los construye al arrancar en los **cuatro tenants** de producción. El plan define si se crean así o con una migración `migrate-mongo`, después de medir el tamaño de las colecciones.

### 4. Frontend (Fase 1, repo `smartHubPanel`)

| Pantalla | Cliente (`admin` y `usuario`) | Smarteam |
|---|---|---|
| Login y cambio de contraseña | ✓ | ✓ |
| Soporte: lista paginada, nuevo, detalle con hilo e imágenes, "Sigue fallando" | ✓ | |
| Bandeja global paginada, con contadores y filtros | | ✓ |
| Detalle de ticket con línea de tiempo, resolución interna y Resolver | | ✓ |
| Eventos: lista paginada y detalle con JSON formateado, y "Reportar problema" | ✓ | ✓ (por tenant, con `payload` y `audit`) |
| Syncs: lista paginada y detalle con JSON formateado, y "Reportar problema" | ✓ | ✓ (por tenant) |
| Usuarios: lista paginada, crear, rol, desactivar, restablecer | | ✓ |

La UI **no decide permisos**: solo oculta botones según `permissions`. Cada regla de acceso la aplica la API.

### 5. Login con HubSpot (Fase 1b, condicionado)

Funcionaría así: OAuth con la misma app, un `state` firmado con propósito `panel-login`, y después `GET /oauth/v1/access-tokens/:token`, que devuelve el correo del usuario y el `hub_id`. Se acepta si `hub_id` es el `portalId` del tenant **y** el correo es un `PanelUser` activo de ese tenant. El token se descarta y nunca se guarda.

Antes de construirlo hay que verificar, con una prueba en un portal de test, tres cosas que hoy **no** están confirmadas:
1. Si un usuario sin permisos de instalar apps (no super admin) puede completar la autorización. Si no puede, este login solo serviría para los admins del portal.
2. Que re-autorizar la app no afecte los tokens de la instalación que usa la sync.
3. Si hace falta registrar una redirect URL adicional en la app.

Por eso usuario y contraseña va primero: Smarteam lo necesita igual y no depende de nada externo.

## Seguridad: reglas que el plan debe testear

1. El tenant del cliente sale **solo** de su `PanelUser`. Ningún endpoint de cliente acepta `tenantKey`, `tenantId` ni `x-tenant-id`.
2. `internalResolution` no aparece en **ninguna** respuesta a una cuenta `cliente`. Hay un test por cada endpoint de cliente que devuelve tickets.
3. Un cliente no puede leer ni escribir el ticket, la imagen, el evento ni la sync de otro tenant: da `404`, no `403`, para no confirmar que existe.
4. Cada ruta tiene su `requirePermission`. Una cuenta `cliente` recibe `403` en toda ruta `/panel/api/staff/*`.
5. Cambiar el rol o desactivar a un usuario rige en el siguiente request, sin esperar a que venza la sesión.
6. Una sesión del panel no sirve en las rutas existentes (webhooks, admin, master), y `x-internal-key` no sirve en `/panel/api/*`.
7. `INTERNAL_KEY` no aparece en el repo del panel ni en su build.
8. `routeAuthWiring.test.js` se extiende con cada ruta nueva del panel, su hook de sesión y su permiso.
9. Ningún log registra contraseñas, cookies ni el header `Authorization`. El hook de `src/main/app.js:23-30` loguea `req.url`, así que nada sensible va en la URL.

## Impacto en producción

- **Ninguno sobre los tenants:** webhooks, syncs, colas y rutas admin quedan igual.
- **Backend:**
  - Colecciones nuevas: `PanelUsers` en la master; `Tickets`, `TicketCounters` y el bucket `TicketAttachments` en cada tenant, que se crean al primer uso.
  - Índices nuevos en `WebhookEvents` y `SyncLogs` (§3).
  - Variable nueva en `.env`: `PANEL_JWT_SECRET`. Sin ella, `/panel/api` no se registra y se loguea un warn (*fail closed*).
  - Dependencias nuevas: `@fastify/cookie` y `@fastify/multipart`.
  - `docker-compose.yml`: el servicio `api` se suma a una red externa compartida con el panel (por ejemplo `smartconnect-panel`), igual que hoy se suma a la de Mongo (`docker-compose.yml:12,24-27`).
- **Panel (repo nuevo):** un contenedor `nginx:alpine` con su propio `docker-compose.yml`, unido a esa misma red.
- **Hostinger:** un dominio para el panel (por definir, probablemente `panel.smarteamcr.com`) con TLS apuntando al contenedor del panel. **A verificar al desplegar:** dónde termina hoy el TLS (el nginx que da los 502 cuando falla la red de Mongo) y cómo se le agrega el subdominio.
- **Solo funciona por HTTPS**, porque la cookie es `Secure`. También hay que confirmar que el puerto 3000 que publica `docker-compose.yml:7-8` no sea accesible desde internet (riesgo ya anotado en el spec de Bull Board).
- **Backups:** las imágenes engordan la base de cada tenant. Con 5 MB por imagen y el volumen de soporte esperado no es significativo, pero cuenta en el tamaño de los dumps.

## Testing (TDD)

**Backend:**
- **Casos de uso con repositorios falsos:** máquina de estados (cada transición válida y cada `409`), exigencia de los dos textos al resolver, `firstResponseAt` solo con el primer mensaje de Smarteam, `reopenCount`, `hasNews` y cálculo de `code`.
- **Permisos:** matriz rol × permiso; `requirePermission` con cada tipo de cuenta; un cambio de rol rige en el request siguiente.
- **Proyección de cliente:** `internalResolution` ausente en la lista, el detalle, la creación, el mensaje y la reapertura; `payload` y `audit` ausentes en los eventos del cliente; ningún campo de respuesta de `/panel/api` se llama con "sap" ni "hubspot".
- **Integración con `mongodb-memory-server`:** contador correlativo sin duplicados con creaciones concurrentes; bandeja global paginada con dos tenants y uno caído; GridFS con el `fileId` de otro ticket → `404`.
- **Auth:** login, bloqueo tras 5 intentos, `pwdChange` restringido, `tokenVersion` invalida la sesión, sesión del panel rechazada en `/webhooks/*` y en `/config/client`, cookie con sus atributos.
- **Imágenes:** un SVG renombrado a `.png` → `400`; un archivo de 6 MB → `413`; 6 imágenes → `400`.
- **`routeAuthWiring.test.js`** extendido.
- Suite completa contra la baseline vigente (211 suites, 5 rojas preexistentes / 10 tests). Comando: `NODE_OPTIONS=--experimental-vm-modules npx jest <archivos> --testPathIgnorePatterns=worktrees`.

**Frontend:** Vitest + Testing Library para el flujo de login con cambio de contraseña, la paginación y que los botones respeten `permissions`.

## Planes que salen de este spec

Cada uno produce algo que funciona y se prueba por sí solo, y cada uno se aprueba por separado:

1. **Acceso (backend):** `PanelUser`, permisos, login, sesión, cambio de contraseña, usuarios y script de la primera cuenta de Smarteam.
2. **Soporte (backend):** tickets, mensajes, estados, imágenes y bandeja global.
3. **Eventos y syncs (backend):** listas, detalles e índices.
4. **Panel (repo nuevo):** crear `smartHubPanel` con su git, el stack, las pantallas de la Fase 1, el Dockerfile y el compose. El repo remoto lo crea el usuario.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Tickets en HubSpot** (portal de Smarteam) | Obliga a un token del portal de Smarteam en el backend y a filtrar por tenant sobre datos que no controlamos. Además, el usuario no quiere asignación, correos ni SLA, que es lo que HubSpot aportaría. |
| **Tickets en la master** | La bandeja global sería una sola consulta, pero el usuario lo descartó: los datos de un tenant viven en la base de ese tenant. El costo de consultar en paralelo es bajo con pocas decenas de tenants. |
| **Índice de tickets en la master** (solo `tenantKey`, `code`, `status`, `lastActivityAt`) | Acelera la bandeja si crecen a cientos de tenants, pero duplica datos y se puede desincronizar. Queda como opción futura. |
| **Panel conectado directo a MongoDB** (desde el navegador o desde un backend propio del panel) | Desde el navegador, las credenciales de Mongo quedarían en el JavaScript que descarga cualquiera, con acceso a todas las bases. Con un backend propio del panel: los modelos quedarían duplicados en dos repos y se desincronizarían; las reglas que viven en los casos de uso (enmascarar secretos, la máquina de estados del ticket, la deduplicación de `WebhookEvents` con `dedupActive`, el nombre de la base del tenant de `buildTenantDatabaseName`) habría que reimplementarlas o se saltarían; y habría dos servicios con credenciales de Mongo. El panel solo habla con `/panel/api`. |
| **Front en carpeta `panel/` del mismo repo** | Mezcla commits, dependencias y despliegues de front y back. El usuario pidió un proyecto aparte. |
| **La API sirve el front con `@fastify/static`** | Ata el despliegue del front al del backend y obliga a un `Dockerfile` multi-etapa en la API. |
| **Front en otro dominio con CORS** | Más configuración (CORS con credenciales, cookies cross-site). El proxy `/api` del contenedor del panel da mismo origen sin eso. |
| **Next.js** | Panel detrás de login sin SEO: el SSR no aporta, agrega un proceso Node más y sus server actions invitan a meter lógica de backend en el front. |
| **Guards por nombre de rol** (`role === 'admin'`) | Cada diferencia nueva entre `admin` y `usuario` obligaría a tocar rutas. Con permisos, solo cambia la tabla. |
| **Rol y tenant dentro del JWT** | Un cambio de rol o una desactivación no regirían hasta que venza la sesión. |
| **Imágenes en disco del contenedor** | Se pierden al recrear el contenedor si no hay volumen, y no entran en los backups de Mongo. |
| **Imágenes en S3 u otro almacenamiento** | Infraestructura y credenciales nuevas para un volumen chico. GridFS usa el Mongo que ya se respalda. |
| **Reusar `JWT_SECRET`** | `tenantResolver` aceptaría las sesiones del panel en los webhooks (`tenantResolver.js:86-89`). |
| **Token en `localStorage`** | Cualquier XSS lo roba. La cookie `HttpOnly` no la puede leer JavaScript. |
| **Paginación por cursor** | Más eficiente en colecciones enormes, pero no permite "página 3 de 12" ni saltar páginas. Con los volúmenes actuales y los índices de §3, la paginación por página alcanza. |
| **Que el cliente cierre el ticket** | El usuario decidió que cierra Smarteam y el cliente reabre. |
| **Resolver sin resolución interna** | Sin ese texto no se arma la base que usará la IA (S15). Por eso es obligatoria al resolver. |

## Fuera de alcance

- Diseño visual y marca (se usa el tema por defecto de shadcn/ui).
- Notificaciones (correo, WhatsApp, push): el cliente se entera al entrar al panel.
- La IA (S15, S16). El modelo ya la contempla (`authorType: 'ia'` e `internalResolution`).
- Métricas agregadas (S13) y todo lo de las fases 2 y 3.
- La B1, la B2 y Bull Board (en pausa).

## Decisiones por defecto (cambiables antes de aprobar)

1. Un cliente de un tenant suspendido puede entrar y usar Soporte.
2. En la Fase 1, `admin` y `usuario` del cliente tienen los mismos permisos (tabla de permisos).
3. Todas las cuentas de Smarteam tienen los mismos permisos.
4. El cliente ve el nombre del dev que le respondió, con la etiqueta "Smarteam".
5. Un ticket resuelto se puede reabrir sin límite de tiempo.
6. La resolución interna es solo texto, sin imágenes.
7. Un correo pertenece a un solo usuario en todo el panel.
8. Dominio del panel por definir (probablemente `panel.smarteamcr.com`); hace falta recién para desplegar el plan 4.
