# Panel — Plan 5c: intercambio del evento (`exchange`, H1) — Plan de implementación

> **Estado:** aprobado por el usuario el 2026-10-14.

**Goal:** que el detalle de un evento traiga las tres partes del intercambio, como las columnas del Excel de errores pendientes:
- **Recibido** del CRM: `payload`;
- **Enviado** al ERP: `sapAudit.payloadSap`;
- **Respuesta** del ERP: `sapAudit.responseSap`.

**Contrato:** `docs/contrato-backend/07-intercambio-evento.md` del front (H1). Se copia a este repo.

**Depende de:** el plan 3 (eventos) y el plan 5 (vistas de cliente y de staff). No reemplaza `2026-08-06-webhook-sap-audit.md` (cómo se guarda `sapAudit`): este plan solo lo lee.

## Global Constraints

- Solo capa del panel y solo lectura. **No cambia cómo se guardan `payload` ni `sapAudit`.**
- `main`, sin ramas. Sin `git add`, `commit` ni `push`. Al terminar, dejar en el chat qué cambió, en qué archivos y por qué.

## Aplica a qué tenant

A todos. Las claves de `payloadSap` y `responseSap` cambian según la versión del ERP (B1 o S4HANA) y el tipo de evento. El saneo de cliente no depende de esas claves: recorre todo el árbol.

## Hechos verificados

| Hecho | Dónde |
|---|---|
| `sapAudit` = `{ payloadSap, responseSap, sapCalls, skipped, responseHubspot, responseHubspotContactEmployees, capturedAt }`, o `null` | `buildWebhookSapAudit`, `src/infrastructure/sync/syncLog.service.js` |
| `sapCalls` trae rutas (`path`), parámetros, `request` y errores de las llamadas al ERP | `serializeAuditCall` |
| En el Excel de Printer, `responseSap.businessPartner.businessPartner.ContactEmployees[].Password` trae valores reales (`"12017"`). Es la única clave sensible en las 288 claves distintas de las tres columnas | `registros_errores_pendientes_2026_08_14.xlsx` |
| `payload` es el webhook del CRM: `portalId`, `deal`, `company`, `line_items`… | Excel, columna "Recibido" |
| Hoy el detalle de evento no lee `payload` ni `sapAudit`, salvo el detalle de staff con `staff.events.raw` (`withRaw`) | `TenantOperationsReader.findEvent` |

## Decisiones (cambiables antes de aprobar)

1. **Campo `exchange` solo en el detalle** (`GET /events/:id` y `GET /staff/tenants/:tenantKey/events/:id`), nunca en la lista ni en el snapshot de tickets.
   - `exchange = { received, sent, response }`. Cada parte es `null` si no existe.
   - `exchange` es `null` si las tres son `null`.
2. **Lectura:**
   - el detalle pide a la base `payload`, `sapAudit.payloadSap` y `sapAudit.responseSap`, **nunca `sapCalls`** ni el resto de la auditoría;
   - con `staff.events.raw` se sigue leyendo `sapAudit` completo para `audit`, como hoy;
   - se evita el choque de rutas de proyección: si se lee `payload` entero, no se pide además `payload.deal.hs_object_id`.
3. **Vista de cliente: saneo profundo** de las tres partes, sobre una copia (lo guardado no cambia):
   - **Se quitan**, a cualquier profundidad, las claves cuyo nombre indique credenciales o rutas internas (sin distinguir mayúsculas):
     - credenciales: `password`, `passwd`, `pwd`, `pass`, `pin`, `token`, `accessToken`, `refreshToken`, `secret`, `clientSecret`, `apiKey`/`api_key`, `authorization`, `auth`, `cookie`, `session`, `sessionId`, `credential(s)`, `privateKey`;
     - rutas: `sapCalls`, `path`, `url`, `uri`, `endpoint`, `host`, `hostname`, `baseUrl`, `serviceLayerUrl`;
     - claves que empiezan con `@odata` o `odata.`.
   - **Textos:** se enmascaran IPs (v4 y v6), `host:puerto` y URLs → `[servidor]` y `[enlace]`.
     - **No** se tocan correos, direcciones ni nombres: son datos del negocio del propio cliente y es lo que necesita ver (como en el Excel).
   - Límites: profundidad máxima 20 y textos de hasta 5 000 caracteres; lo que pasa se corta. Así un documento raro no puede trabar el proceso.
4. **Vista de Smarteam:** `exchange` sin sanear, con o sin `staff.events.raw`. `payload` y `audit` siguen como hoy (solo con `staff.events.raw`).
5. **Contrato:** se copia `07-intercambio-evento.md` del front y se le agrega una nota con la lista exacta de claves que se quitan (decisión 3).

## Archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/domain/panel/exchangeView.js` | Crear | Arma `exchange` y su saneo profundo para cliente |
| `src/infrastructure/database/repositories/TenantOperationsReader.js` | Modificar | `findEvent(…, { withExchange })`: proyección con las tres partes, sin `sapCalls` |
| `src/application/use-cases/panel/PanelOperations.js` | Modificar | `getEvent` pide y agrega `exchange` según el lado |
| `tests/…` | Crear / Modificar | Pruebas de saneo, lectura, caso de uso y HTTP (cliente vs. staff) |
| `docs/contrato-backend/07-intercambio-evento.md` | Copiar + nota | Contrato |
| `README.md` | Modificar | Sección 20 |

## Pruebas

- Saneo de cliente:
  - `Password` dentro de `ContactEmployees[]` (el caso del Excel) desaparece;
  - claves anidadas en arrays, variantes de mayúsculas, `sapCalls`, `path`/`url`/`host`;
  - IPs y URLs en textos;
  - correos y direcciones intactos;
  - límites de profundidad y largo.
- Lectura: la proyección del detalle incluye las tres partes y no incluye `sapCalls`; sin choque de rutas.
- Cliente: `exchange` saneado; sin `payload` ni `audit` en la raíz, igual que hoy. Staff: `exchange` crudo.
- La lista de eventos no trae `exchange`.
- Evento en cola sin auditoría → `exchange.received` presente y `sent`/`response` en `null`.
- Integración (Windows): un evento con la forma del Excel (incluido `Password`) por las dos rutas.

## Ejecución (2026-10-14)

Ejecutado sin cambios respecto al plan. El core no se tocó.

Archivos:
- `src/domain/panel/exchangeView.js` (nuevo): arma `exchange` y lo sanea para el cliente sobre una copia.
- `TenantOperationsReader.findEvent`: opción `withExchange`, que proyecta `payload`, `sapAudit.payloadSap` y `sapAudit.responseSap`, sin `sapCalls`.
- `PanelOperations.getEvent`: agrega `exchange` según el lado.
- `docs/contrato-backend/07-intercambio-evento.md`: copiado del front, con la nota del backend.
- README.

Precisión sobre la decisión 3: las credenciales se reconocen por subcadena (`password`, `passwd`, `secret`, `token`, `api_key`, `private_key`, `credential`), así también cae `DBPassword`. Las claves cortas se reconocen por nombre exacto (`pwd`, `pass`, `pin`, `auth`…), para no quitar `Author`, `Pinned` ni `Passport`. Además se cortan los arrays de más de 1 000 ítems.

Pruebas:
- Suite unitaria: 237 suites / 3010 tests, con los mismos 4 suites / 6 tests rojos previos.
- Nueva: `tests/unit/domain/panelExchangeView.test.js`, con la forma del Excel, incluido `Password: "12017"`.
- Casos nuevos en `panelOperations.test.js`, `panelOperationsReader.test.js` y `panelOperationsApi.test.js`.
- Integración en `tests/integration/panelOperations.test.js` (Windows).
