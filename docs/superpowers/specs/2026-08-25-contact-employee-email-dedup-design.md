# ContactEmployees con email duplicado: identidad por internalcode + email `+InternalCode`

**Fecha:** 2026-08-25
**Estado:** aprobado (diseño validado en sesión con el usuario)
**Tenant que lo motivó:** Printer (B1), BP `CLO061498` con dos ContactEmployees que comparten `recepcion@tecnopack.net`

## Problema

Cuando un BusinessPartner trae 2+ ContactEmployees con el mismo `E_Mail` (o un CE
comparte email con su BP padre), HubSpot — que fuerza email único en contacts —
los colapsa en un solo contacto o rechaza el create con 409:

- **Camino secuencial** (`hubspotBatchSize: 1`, el de Printer hoy): el find del CE
  usa `defaultFindHubspot` (`idsap`), que el payload de CE no trae, así que
  siempre intenta create. El primero entra; el segundo muere en 409 o, si el
  primero vino de una corrida anterior, el flujo lo pisa.
- **Camino batch** (`SyncCompanyContactsInBatches`): el tier de email único del
  `CrmObjectIndex` matchea al dueño del email y el CE ajeno se convierte en
  update de OTRO contacto, o va a create y muere en 409 (documentado en el
  comentario de claims, `SyncCompanyContactsInBatches.js:222-229`).

Resultado observado: GC PLASTICS quedó con un solo contacto en HubSpot en vez de
dos (Marleni `InternalCode` 91643 y Sofia 91794).

## Regla acordada

1. **La llave de identidad de un contacto según su origen:**
   - contacto que viene de un **BP persona** → `idsap` (lo que ya hace
     `defaultFindHubspot`; no se toca);
   - contacto que viene de un **ContactEmployee** → `internalcode`, y el email
     se consulta **al final**, nunca primero.
2. **Email duplicado → plus addressing con el InternalCode:** si el email limpio
   del CE ya tiene dueño (otro contacto de HubSpot, otro CE de la misma corrida,
   el BP padre, o un contacto sin `internalcode`), el CE se envía con
   `localpart+InternalCode@domain` — ej. `recepcion+91794@tecnopack.net`.
   El dueño del email limpio lo conserva.
3. **Sin migración:** los contactos ya colapsados por el comportamiento viejo se
   auto-corrigen en la próxima corrida — el dueño actual del email limpio lo
   conserva (aunque no sea el primer CE del array de SAP) y el gemelo se crea
   aparte con `+InternalCode`. Decisión explícita del usuario.

## Decisiones tomadas en sesión

| Pregunta | Decisión |
| --- | --- |
| ¿Ambos caminos o solo el secuencial? | **Ambos** (secuencial y batch), misma regla. |
| ¿Cómo detectar que el email ya existe? | **Búsqueda previa por email** + registro en memoria de la corrida. NO crear-y-reintentar-en-409. |
| ¿Migrar contactos ya colapsados? | **No.** Auto-corrección en la corrida siguiente. |

## Arquitectura

### Componente nuevo: `src/application/services/contactEmployeeIdentity.service.js`

Servicio **puro** (sin I/O), única fuente de la regla para los dos caminos —
mismo motivo por el que existe `mappingValueResolver.service.js` (su cabecera
documenta el costo de duplicar la regla entre caminos).

- `plusAddressEmail(email, internalCode)` → `recepcion@x.net` + `91643` =
  `recepcion+91643@x.net`. Devuelve `null` si el email base es inválido (misma
  validación que `generateFallbackEmail`,
  `src/infrastructure/hubspot/utils/email.utils.js:3-20`: localpart y domain no
  vacíos, contiene `@`, lowercase/trim).
- `resolveContactEmployeeEmail({ email, internalCode, owner, claimedEmails })` →
  email final:
  - sin dueño y no reclamado en la corrida → **limpio** (el caller lo reclama);
  - dueño con el **mismo** `internalcode` → limpio (es él mismo);
  - dueño distinto — otro `internalcode`, un contacto sin `internalcode`, un
    BP-contacto que solo trae `idsap`, u otro CE anterior de la corrida →
    **`+InternalCode`**.

  `owner` es `{ internalcode }` o `null`; `claimedEmails` es un
  `Map<emailNormalizado, internalCode>` que vive en el caller.

### Camino secuencial — `HandleHubspotAssociations.syncCompanyContacts`

Rutas verificadas leyendo el archivo (no reportadas por subagentes):

- `src/application/use-cases/HandleHubspotAssociations.js:225` — firma de
  `syncCompanyContacts`; `:245-251` — los CE salen de
  `rawSapData._s4Contacts ?? rawSapData.ContactEmployees`.
- `:299-307` — `buildCompanyContactPayload` construye el payload (SIN cambios:
  precedencia email SAP > mapeado > fallback por empresa,
  `src/application/services/companyContactPayload.service.js:8-39`).
- `:358-364` — find actual vía `this.contactHandler.find` (usa
  `defaultFindHubspot` = `idsap`, que el CE no trae → hoy devuelve null
  siempre). **Se reemplaza SOLO para CE** por el find nuevo de abajo.
- `:366-393` — update/create + `registerBaseObjectMapping` con
  `sapInternalCode`: sin cambios.
- `:406-417` — guarda de auto-asociación para padre `contact`: se conserva como
  red de seguridad (con emails separados casi no debería dispararse).
- `:470` y `:508` — los dos callers (`handleContactAssociations` /
  `handleCompanyAssociations`): sin cambios.

Flujo nuevo dentro del loop por CE:

1. Payload como hoy.
2. Dueño del email limpio: primero el `Map` de emails reclamados (creado **por
   llamada** a `syncCompanyContacts`, nunca en el estado de la instancia — el
   use-case es compartido entre tenants), después
   `findContactByEmail` (`src/infrastructure/hubspot/hubspotClient.js:132-134`,
   delega en la Search API vía `findContactByProperty:136-144`). La búsqueda ya
   devuelve `internalcode` porque está en `CONTACT_SEARCH_PROPERTIES`
   (`src/infrastructure/hubspot/handlers/contact.handler.js:9-16`).
3. `resolveContactEmployeeEmail(...)` decide el email final y se reescribe en
   `contactPayload.properties.email`; se reclama en el Map.
4. **Find nuevo para CE** — función nueva `findContactEmployee` en
   `contact.handler.js` (el `find` genérico de BP-contactos con
   `buildConfiguredSearchCriteria`,
   `src/infrastructure/hubspot/handlers/utils/searchCriteria.utils.js`, NO se
   toca): `findContactByProperty('internalcode', ...)` → si nada,
   `findContactByEmail(email resuelto)` → update o create, igual que hoy.

Nota que simplifica el riesgo: el update de contactos manda **solo
identificadores** (`buildIdentifierOnlyPayload`,
`src/infrastructure/hubspot/handlers/utils/updateDecision.utils.js:31-47`
conserva únicamente `idsap`/`internalcode`), así que un update jamás puede
escribir un email duplicado, y cuando el CE matchea por email a un contacto sin
`internalcode`, el update se lo adopta.

### Camino batch — `SyncCompanyContactsInBatches`

- `src/composition/hubspot-sync.composition.js:53-65` — ya se compone con
  `identityProperty: 'internalcode'`.
- `CrmObjectIndex` (`src/application/services/crmObjectIndex.service.js`) gana
  un accessor de solo lectura `emailOwner(email)` que consulta el tier único de
  email (`byUnique`, poblado en `add():63-70`; contacts declaran `email` único
  en `HUBSPOT_UNIQUE_PROPERTIES:12-15`). Las tres tiers de `find():76-117` NO
  cambian.
- En el loop de claims (`SyncCompanyContactsInBatches.js:205-275`): por cada
  entry, ANTES de `index.find(properties)`, se resuelve el email con el servicio
  (dueño = `claimedEmails` del `execute` o `index.emailOwner(...)`) y se
  reescribe en `entry.contactPayload.properties.email`. El resto del flujo de
  claims/colapso queda idéntico: con el email ya resuelto, el tier único solo
  matchea cuando es el mismo contacto, y el caso que hoy va a create condenado a
  409 (`:222-229`) llega al create con `+InternalCode` y entra.
- El reporte de emails duplicados (`duplicateContactEmail.report.js`) se
  mantiene; el registro anota que se aplicó email de fallback en vez de "create
  condenado a 409".

## Casos borde

- **CE sin email** → sin cambios: `generateFallbackEmail(emailEmpresa, código)`
  y si tampoco hay, el skip/bypass actual
  (`HandleHubspotAssociations.js:337-357`).
- **Email base inválido** (sin `@`) → `plusAddressEmail` devuelve null y el
  flujo actual sigue con el email tal cual venga.
- **El email `+InternalCode` ya tiene dueño distinto** (creado a mano) → el find
  por email lo matchea y lo actualiza; como el update es identifier-only, adopta
  el `internalcode`. Warning en log, sin abortar.
- **Padre persona (BP-contacto) con el mismo email que su CE** → el CE ya no
  resuelve al contacto del padre: recibe `+InternalCode` y se crea aparte, y la
  asociación contacto↔contacto se crea de verdad. Cambia el caso
  "auto-asociación → skip" por "dos contactos asociados" — es el objetivo.
- **Idempotencia** → corridas siguientes matchean por `internalcode` (tier 1) y
  no consultan el email.
- **Ventana de consistencia eventual de la Search API** → entre BPs de la misma
  corrida secuencial, un contacto creado hace segundos puede no aparecer en la
  búsqueda; el Map por llamada cubre los gemelos del mismo BP y el 409 del
  create sigue siendo el error honesto para la ventana restante.

## Manejo de errores

Sin categorías nuevas. Una búsqueda de dueño que falle cae en el catch
por-contacto existente (secuencial, `HandleHubspotAssociations.js:425-434`) o
degrada el chunk (batch). El 409 se conserva como respaldo honesto.

## Tests

- **Unitarios puros** del servicio nuevo: todas las ramas de dueño (sin dueño /
  mismo internalcode / distinto / sin internalcode / reclamado en corrida /
  email inválido).
- **`contact.handler`**: `findContactEmployee` busca `internalcode` primero y
  email al final; el `find` genérico no cambia de comportamiento.
- **Secuencial** (`tests/unit/application/` de HandleHubspotAssociations): dos
  CEs con el mismo email → el primero limpio, el segundo `+InternalCode`; CE ya
  existente matchea por `internalcode` y no toca el email.
- **Batch** (`tests/unit/application/syncCompanyContactsInBatches.test.js`):
  las guardas de regresión del comportamiento viejo (colapso por email y
  auto-asociación por email compartido) **cambian de expectativa** y se
  reescriben para la regla nueva.
- Baseline de jest antes de empezar (regla del repo): correr con
  `--testPathIgnorePatterns=worktrees`; 5 suites rojas preexistentes al
  2026-08-25 (`internalTenant`, `sendMappedItemsToHubspot`,
  `lineItemPriceWebhook`, `serviceLayerFlow` por fecha fija,
  `serviceLayerService`).

## Alternativas descartadas

- **B — Lógica inline en cada camino** (sin servicio compartido): duplica la
  regla entre `HandleHubspotAssociations` y `SyncCompanyContactsInBatches`; es
  el bug histórico que ya se pagó con el mapeo de campos (ver cabecera de
  `mappingValueResolver.service.js:1-4`).
- **C — Resolver dentro de `buildCompanyContactPayload`**: lo vuelve async y
  mete I/O en un constructor puro de payloads; el camino batch no puede
  aprovecharlo porque su dueño del email vive en el índice, no en una búsqueda.
- **Crear y reintentar en 409**: el 409 no distingue "soy yo mismo" de "es
  otro", genera ruido de errores y no aplica al camino batch.
- **Estricto por orden SAP** (el primer CE del array siempre con email limpio):
  obliga a renombrar emails de contactos existentes en HubSpot — más
  escrituras, y pisa contactos que el cliente pudo haber editado.
- **Job de migración para contactos ya colapsados**: innecesario; la regla
  nueva converge sola en la corrida siguiente.

## Contexto de configuración (Mongo, verificado por el usuario)

- `defaultFindHubspot = 'idsap'` — sigue gobernando el find de BP (companies y
  BP-contactos). Los CE dejan de depender de esta config.
- `defaultFindSAP = 'EmailAddress'` — dirección HubSpot→SAP, fuera del alcance
  de este ajuste.
