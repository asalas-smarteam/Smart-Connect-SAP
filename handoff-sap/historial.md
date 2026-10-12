# Historial del proyecto Smart-Connect-SAP

Línea de tiempo del conector SAP↔HubSpot, desde el primer commit (`fa618ed`, 2025-11-20) hasta hoy (2026-10-11, commit `1305b31`). 623 commits en total.

Reconstruido con:
- `git log` del repo (fuente primaria de fechas y mensajes de commit).
- claude-mem (`mem_search`) — memoria de sesiones pasadas de trabajo sobre este repo.
- `07-Historial-y-Migraciones.md` de la bóveda Obsidian (al día con `1305b31`, 2026-10-11) — cubre en detalle agosto-octubre 2026, que es donde está la mayor densidad de specs/planes documentados.

> Nota de cobertura: claude-mem tiene buena señal desde finales de julio 2026 en adelante (matching de duplicados, rate limiting, incidentes de producción, trabajo por tenant). Para noviembre 2025 – julio 2026 la señal de claude-mem es escasa o nula; esa parte del historial se reconstruyó casi exclusivamente de los mensajes de commit de `git log`, que en ese tramo son menos descriptivos (commits tipo "fix some bugs", "Just load"). Donde no hay evidencia de causa raíz, se dice explícitamente en vez de inferirla.

---

## Noviembre 2025 – Arranque del proyecto

- `fa618ed`, `e9ccb14`, `d620b9c` (2025-11-20): commit inicial. Proyecto Node.js arrancando desde cero (`codex/generate-complete-package.json-for-node.js-project`).
- Primeras semanas: configuración base (dotenv, estructura de carpetas). Sin señal de claude-mem para este período; reconstruido solo de `git log`.

## Diciembre 2025 – Enero 2026 — Primer sync SAP↔HubSpot y migración de base de datos

- Integración inicial contra SAP Service Layer (B1) y HubSpot, con MySQL/Sequelize como base de datos (arquitectura original).
- **Migración MySQL/Sequelize → MongoDB/Mongoose** (`0e69f5d`, `a1da7b5`, 2026-01-15): se reemplaza el motor de persistencia completo. Mensaje de `a1da7b5`: "Remove SQL deps and document external DB status".
- **Arranque de la arquitectura multi-tenant** (`c326de1`, 2026-01-16): "add multi-tenant data model scaffolding" — primer commit que introduce el modelo de master DB + DB por tenant que sigue vigente hoy.
- Entre enero y marzo 2026 (PRs #65 a #85, todos `codex/...`): se completa la migración a Mongoose, se mueven los modelos a `tenant/`, se arma el provisioning de tenant (seed de documentos, endpoint interno de alta), autenticación JWT y resolución de tenant por header.

## Febrero 2026 — Webhooks HubSpot→SAP y Service Layer

- `40bea9f` (02-06): primer intake de webhooks de HubSpot.
- `1914631` (02-10): manejo de mappings compuestos en el webhook de deals.
- `f6f7508` (02-18): builder de URLs de SAP Service Layer y flujo de configuración — la base de cómo el conector arma sus consultas OData contra B1.
- `97ca51f` (02-26): sesión de SAP respaldada en Redis con lock por tenant (para no pisar sesiones concurrentes de distintos tenants contra el mismo Service Layer).

## Marzo 2026 — Colas, mappings dinámicos y primer webhook de creación de deals

- `aae078b` (03-24), `d5b571b` (03-25): se introduce BullMQ como sistema de colas para las tareas de sync (reemplaza ejecución directa), con `ClientConfig` ajustado para permitir sync full o por intervalos.
- `1a14f02` (03-25): webhook de creación de deals en SAP (origen del flujo HubSpot→SAP de órdenes).
- `48b82a6` (03-03): **se borra la carpeta `scripts/migrations`** usada por `migrate-mongo`. Esto deja una deuda que persiste hasta hoy: `migrate-mongo-config.cjs` sigue apuntando a un directorio que no existe desde este commit — documentado en el vault (`07-Historial-y-Migraciones.md`), y el equipo migró en la práctica a scripts one-off en `scripts/` corridos a mano por tenant.
- `3c8c104`/`f14074d` (03-03/03-05): seed de mappings de HubSpot al provisionar tenant, y CRUD tenant-safe para las entidades de mapping — primera versión del sistema de `FieldMapping` configurable que es el corazón del conector hoy.

## Abril 2026 — Precios y refinamiento de mapeos

- `5430953` (04-08): webhook para traer lista de precios de productos.
- Resto de abril: ajustes de refresh token, reintentos ante error 449 ("too many tries") de HubSpot, manejo de descuentos y de precio en línea de pedido. Mensajes de commit de esta época son escuetos ("fix some bugs", "fix in queues bullmq"); no hay señal de claude-mem que documente causa raíz de estos fixes puntuales.

## Mayo 2026 — Migración a arquitectura hexagonal

- **PR #110 "Hexagonal Architecture and SOLID principles"** (`67f1445`, merge 2026-05-08): reescritura estructural grande — separación en `application/domain/ports/infrastructure/interfaces/shared/main`, casos de uso explícitos (health, provisioning, OAuth, asociaciones, webhooks, sync, precios), adaptadores de infraestructura (Mongo, SAP Service Layer, HubSpot, BullMQ, locks por tenant, logging, schedulers), rutas movidas a `src/interfaces/http`.
- `e8ed3ff` (05-09, al día siguiente del merge): "recover repository after filesystem corruption" — incidente de corrupción del repo justo después del merge grande; se resuelve con un commit de recuperación, sin más detalle en el mensaje.
- Este fue el único release etiquetado formalmente en `CHANGELOG.md`: `[1.3.19] - 2026-04-30`, descrito como "el release base" (arquitectura MongoDB multi-tenant, provisioning con seeding, CRUD tenant-safe, Service Layer con filtros configurables, sesión SAP en Redis, webhooks, colas BullMQ, CRUD de credenciales SAP, auto-creación de campos HubSpot, sync logs). El changelog no se volvió a actualizar después de esto — todo el trabajo de julio a octubre 2026 (la mayor parte de este documento) no está reflejado ahí.

## Junio–Julio 2026 — Incidente: 5,691 duplicados en el sync masivo

El hallazgo mejor documentado del proyecto. Entre el release base (abril) y finales de julio, el sync masivo SAP→HubSpot matcheaba contra HubSpot **buscando registro por registro** (1-a-1 contra la Search API) en vez de con un índice. Esto, combinado con reglas de identidad poco estrictas, produjo un incidente real de **5,691 contactos/companies duplicados** en producción (referenciado explícitamente en el commit `013801f`).

Línea de trabajo de reparación, 28–30 de julio 2026 (una secuencia continua de 15 commits):

- `a004f15` (07-29): introduce `CrmObjectIndex` — prefetch completo del CRM de HubSpot a memoria, con matching en dos niveles (identidad + fallback), reemplazando las búsquedas 1-a-1.
- `0338c6a` / `71b9ebb`: endurecen `listAllObjects` — si el guard de paginación (`maxPages=2000`) se alcanza con páginas pendientes, **lanza** una excepción en vez de devolver un índice parcial (un índice parcial habría hecho que el sync recreara como "duplicados" registros que sí existían pero no se habían indexado todavía).
- `d786ce2` → `fcdb70d`: refinamiento del algoritmo — dedupe de altas dentro de la misma corrida, cierre de duplicación cross-tier, identificación de contactos hijos de una company por `internalcode`, exclusión de contactos con `internalcode` propio del grupo de reclamo de otra fila.
- `8278313`: corrige un bug de integridad separado — productos recién creados se atribuían por **posición en la respuesta del batch** de HubSpot, no por SKU; se corrige para atribuir **solo por `hs_sku`**.
- `9c83cff` → `013801f` (07-29): conectan las **identity properties** en composición (qué propiedad de HubSpot identifica a un registro, configurable) y agregan el guardrail "refuse to create when identity property is not writable" — si la propiedad de identidad no se puede escribir en HubSpot, el conector se niega a crear el registro en vez de crear un duplicado silencioso. `9c83cff` incluye además una migración de tenant (script `migrate-s4-contact-internalcode.mjs`) para corregir `FieldMapping`s legacy de tenants S/4 (`targetField: idsap` → `internalcode`).

Causa raíz, en síntesis: matching 1-a-1 contra una API de búsqueda que no garantiza ver todo el CRM en una sola consulta, sin reglas de identidad explícitas ni guardrails ante paginación incompleta. Solución: prefetch + índice en memoria, reglas de identidad configurables por tenant, y fallar ruidosamente en vez de degradar silenciosamente.

Dos features colaterales de la misma semana, documentadas aparte: "dynamic description" (`7f6c158`) y "exclusive discount properties" (`01c8c0f`).

## Agosto 2026 (primera quincena) — Transporte HubSpot: rate limiting y manejo de fallos de batch

- **`ecd4ed0`** (08-03): commit grande (34 archivos) que agrupa cinco frentes, todos relacionados con "cómo hablamos con HubSpot y qué hacemos cuando falla":
  1. **Rate limiting y retry** (`hubspotRateLimiter.js` + `hubspotTransport.js`). Hallazgo de fondo: la Search API de HubSpot vive en su **propio policy group**, topado a **5 req/s por cuenta** — acotar la concurrencia de las llamadas no acota la tasa real contra HubSpot, hace falta un limitador de tasa explícito. Confirmado en producción: los 429 cayeron a cero tras este fix.
  2. **Clasificación de fallos de batch** (`hubspotBatchFailure.service.js`, `createWithConflictSplit`). Antes, *cualquier* error en un batch degradaba el chunk entero a ~200 requests individuales, justo en el momento en que HubSpot ya estaba limitando la tasa — un círculo vicioso. Ahora los conflictos (409) se bisecan y el resto del chunk no se amplifica innecesariamente.
  3. **Cadena de fallback en mappings** (`mappingValueResolver.service.js`, motor único que reemplaza lógica duplicada entre contactos y companies). Corrige un bug donde un `targetField` duplicado en `FieldMapping` sobreescribía silenciosamente con `null` el valor correcto (porque "el último mapping por `_id` gana"), dejando **~219 compañías con `cedula` vacía**.
  4. **Reportes de calidad de datos**: tercer tier de matching por propiedades únicas (email de contacto), más `sapDuplicateContactEmailReport` persistido para visibilizar que SAP tiene emails de contacto duplicados — ese problema se corrige en SAP, el código no lo "arregla" automáticamente.
  5. **Campos mapeables en `DocumentLines`**: nuevo set `product`/`orders-quotations` para líneas HubSpot→SAP, con `PriceAfterVAT` desplazando a `UnitPrice` cuando corresponde.

- `d928281` (08-06) → `37aeddf` → `2356584` (08-13): **auditoría completa del tráfico SAP**. `sapCallRecorder` graba método, path, params, body y respuesta de cada llamada a SAP, persistida en `WebhookEvent.sapAudit` tanto en éxito como en fallo (reemplaza los campos ad-hoc `payloadSAP`/`payloadBPSAP`).
  - **Incidente asociado (08-13):** `$select` como clave dentro del objeto de audit tumbó el `$set` completo de Mongo en producción (Mongo < 5.0 rechaza claves con `$`), dejando dos `WebhookEvent` en estado `sap_order_created` sin poder avanzar — `applyUpdates` reintentaba sin el campo de audit. Lección que quedó en memoria del proyecto: un `$set` de Mongo se cae **completo** por una sola clave mala, arrastrando también `status`/`lastError` consigo.

- `37aeddf` (08-07): notificación de fallos de webhook con mensajes legibles — `error-message.service.js` extrae y trunca el mensaje de error de SAP; `lastError` se coacciona a string porque un objeto de SAP en un campo `String` de Mongoose producía `CastError`.

## Agosto 2026 (resto del mes) — Reenvío de webhooks, BusinessPartner completo, S/4, bodegas

- **Reenvío de webhooks tras fallo definitivo** (spec `6aad43e`, impl `17bb6b6`, 08-18): se agrega `dedupActive` + índice único parcial nuevo en `WebhookEvent`; solo el estado `errored` libera el cupo de reenvío. Requiere correr `migrate-webhook-event-dedup-active.mjs` en los cuatro tenants de producción, en un orden estricto (backfill antes de crear el índice nuevo, crear el índice nuevo antes de tumbar el viejo) para no dejar una ventana sin protección contra duplicados en SAP.
- **BusinessPartner completo, HubSpot→SAP** (specs y plan 08-11, impl 08-11): creación de BP vía *strategy* (`legacy` vs `fullMapped`), con direcciones (`BPAddresses`), `ContactEmployees` y flags `Properties1..64` desde un multi-select de HubSpot.
- **BusinessPartner completo, SAP→HubSpot** (08-12): ContactEmployees también para BP tipo persona (no solo company); compuerta `requireAddress` que avisa que la sync de direcciones SAP→HubSpot no existe.
- **SAP S/4HANA — onboarding de Multiquímica** (spec 08-10, impl `4c8e76f`): primer tenant sobre S/4 (vs. B1 en el resto). Estrategia `s4-plant-storage-location` para productos/stock por centro y almacén de SAP.
- **Lotes y caducidad S/4** (merge `e56df7a`, 08-13): `BatchExpiryEnrichmentAdapter` + `S4BatchResolver`, con default `source: 'none'` para que los tenants B1 no paguen ni una llamada extra.
- **Fallo parcial + audit en precios de line items** (PR #111, 08-17/18): una línea sin precio o con 404 ya no bloquea el resto del deal.
- **Red de Docker — incidente de producción** (`5e93f74`, 09-25 — ver sección de septiembre; mencionado aquí por continuidad del tema infraestructura).
- **Emails duplicados de ContactEmployees — implementado y revertido** (spec/plan 08-25, impl `dba7c40`→`c60cb85`, **revert `4bae00c` el 08-26**): se intentó separar ContactEmployees que comparten email con "plus addressing" (`email+InternalCode`). En producción **duplicó contactos**: un contacto viejo con el email limpio no tenía `internalcode`, la regla lo trató como "otro dueño" y creó `x+1062@…` al lado de `x@…`. Se revirtió por pedido explícito del cliente de que el email nunca se reescribe. Lo único que sobrevivió de ese esfuerzo: el find de ContactEmployee por `internalcode` primero, email al final — así dos CEs que comparten correo igual resuelven al mismo contacto de HubSpot.
- **Limpieza de duplicados en portales de HubSpot** (`7609dcb` 08-19, `8f3e638` 08-26, `b20505e` 09-01): batería de scripts de auditoría/análisis/merge/borrado/backfill para limpiar los duplicados históricos en los portales de los clientes (no el código del sync, sino los datos ya duplicados). El merge real de Distelsa (2026-08-28) es de donde sale el hallazgo documentado de que **fusionar companies en HubSpot genera un `hs_object_id` nuevo** (no conserva el del primario), que `batch/read` no resuelve los alias (da un falso "no existe"), y que `AssociationRegistries.baseHubspotId` queda apuntando al ID viejo tras un merge (ningún script lo corrige automáticamente).

## Septiembre 2026 — Scheduler, owners, cotizaciones, incidente de red

- **Múltiples horarios por `ClientConfig`** (`f86346d`, 09-07): `executionTime` pasa de string a array; un job de scheduler por hora configurada.
- **`userField` / owners** (`5242a4a` 09-03, `f2f706b` 09-11): traducción de `SalesPersonCode` ↔ ownerId de HubSpot vía `OwnerMappings`. Incidente evitado documentado en memoria: `SlpCode` (de `/SalesPersons`) y `DocumentsOwner`/`EmployeeID` (de `/EmployeesInfo`) **no son el mismo catálogo** — mandar el código equivocado asigna otra persona en SAP sin que SAP devuelva error (pasó en 5 de 7 casos en Distelsa antes de separar `sapOwnerId` de `sapOwnerId_2`).
- **Cotizaciones B1 (Distelsa/Printer)**: `ItemDescription` editable (09-03); campos de línea al convertir cotización en orden, en el mismo POST (09-09); alta y baja de líneas en `updateQuotation` (`3d9a632`, 09-10) usando `B1S-ReplaceCollectionsOnPatch` con `LineNum` explícito — **sin `LineNum` el PATCH es posicional** y pega los campos de un artículo sobre otro devolviendo 204 (éxito aparente, dato corrompido).
- **Incidente de producción — caída por red de Docker** (`5e93f74`, commit 09-25, causa el 2026-09-25): tras una recreación de contenedores, la API y el worker quedaron en una red de Docker distinta a la de MongoDB (`mongodb-4-kfyz_default`). Síntoma: crash-loop con `getaddrinfo EAI_AGAIN`, nginx devolviendo 502 en HTML (que HubSpot interpretaba como fallo de parseo JSON, no como error del integrador). Causa raíz: el `docker-compose.yml` no declaraba la red de Mongo como `external`, así que una reconstrucción de contenedores perdía la conexión de red manual hecha anteriormente. Solución: declarar la red externa y asignarla explícitamente a los servicios `api` y `worker`. Quedó sin reenviar automáticamente: los eventos de HubSpot durante la ventana de caída no se reintentan solos (hubo que reenviar a mano al menos una cotización de Distelsa).
- **S/4 — área de ventas y lista de precios desde el deal** (PR #114, 08-24/26, cerrado en septiembre): organización de ventas y canal vienen del negocio de HubSpot, sin fallback a configuración.

## Octubre 2026 — Seguridad de rutas, creación de ofertas S/4, AddressExtension

- **Autenticación de rutas, OAuth firmado y secretos enmascarados** (`5fd5978`, 2026-10-06): se introduce `adminTenantAuth` (llave interna + `x-tenant-id` por header obligatorio) para todas las rutas de administración de tenant; `state` de OAuth firmado con HMAC y con vencimiento a 15 minutos, rechazo con 403 si se autorizó un portal distinto al registrado; contraseñas y tokens se devuelven como `********` en vez de en texto plano. El mismo commit incluye el fix de **"idsap primero, defaultFindHubspot después"** (`sap-record-ownership.js`): un registro hallado por validación secundaria (email, teléfono) que ya trae otra llave SAP propia no se adopta como si fuera el mismo — esto cerró una causa de duplicados diarios en Noelito donde `Duplicate IDs` en `batch/update` degradaba al fallback de a uno, que buscaba solo por email y recreaba el BP sin email.
- **Creación de ofertas de venta en S/4** (spec+plan+impl, `3f15c67`, culminado 09-25/10-xx): `ProcessHubspotCreateQuotation` se bifurca por `salesDocumentStrategyFactory` (B1 vs S/4); solo el flujo de creación de cotización quedó cubierto para S/4 (update/convert/pedido/traslado/compra siguen siendo exclusivos de B1). En el camino se encontró y corrigió un error de ruta OData: el spec original asumía `to_Customer.BPTaxLongNumber` para el número de identificación tributaria, que **no existe** en el modelo S/4 (da 404); la ruta correcta es `to_BusinessPartnerTax.BPTaxLongNumber` (colección, una fila por tipo de impuesto, hay que elegir la primera a propósito). De paso se detectó que Multiquímica tiene dos `FieldMapping` apuntando a `cedula`, uno de ellos con la ruta vieja inexistente, que queda sobreescrito por el que gana por orden de `_id` — pendiente de que el cliente decida cuál conservar.
- **`AddressExtension` en cotizaciones** (`4eb6e6a`, 10-08; merge PR #117 `1305b31`, 10-11 — el commit más reciente del repo): BillTo/ShipTo se arman desde un objeto `addressExtension` propio del payload del webhook, mapeado por `FieldMapping` (`sourceContext: 'addressExtension'`), construido **antes** de buscar o crear el BP (para no dejar un cliente huérfano en SAP si el payload viene malformado). Solo aplica a la creación de la cotización; `updateQuotation` no cambia.

---

## Clientes (tenants) y cuándo entraron

No hay un registro explícito de "fecha de alta de cliente" en git ni en claude-mem; la señal disponible es indirecta, por la primera vez que aparece trabajo específico de cada tenant:

- **Distelsa** y **Printer** (B1): los tenants más antiguos y con más configuración; aparecen en prácticamente todas las olas de trabajo desde mediados de 2026 (cotizaciones, bodegas, owners). Printer tiene mapeo completo de `businessPartnerCreation` con direcciones; AMC no.
- **AMC** (B1): bodegas con 20 almacenes (60 entradas de métrica), configurado en `a6b4405` (agosto 2026). Sin mapeos de dirección (`bpAddress`) configurados a la fecha de este documento.
- **Multiquímica** (S/4HANA): único tenant sobre S/4; entra en escena en agosto 2026 (`4c8e76f`, spec 08-10) y concentra todo el trabajo específico de S/4 (lotes/caducidad, precios por lista, área de ventas, creación de ofertas).
- **Noelito** (B1): el tenant con más incidentes de calidad de datos documentados — el análisis de duplicados de octubre 2026 encontró **2,334 grupos de contactos duplicados (6,968 contactos)** en un universo de ~49,714 contactos, de los cuales solo 244 eran fusión segura automática y 3,546 requerían revisión manual por evidencia contradictoria (email/teléfono). Es también donde se detectó el patrón "551 BPs sin email nunca se actualizan" (247 OK, 51 existentes pero obsoletos, 376 nunca creados) por un filtro de validación de email que corre antes del índice de matching.

---

## Incidentes resueltos — resumen de causa raíz y solución

| Incidente | Cuándo | Causa raíz | Solución |
|---|---|---|---|
| 5,691 duplicados en sync masivo | jun–jul 2026 | Matching 1-a-1 contra Search API de HubSpot sin índice ni reglas de identidad; paginación incompleta degradaba a índice parcial | `CrmObjectIndex` (prefetch + matching en 2 niveles), `listAllObjects` lanza en vez de devolver parcial, identity properties configurables, guardrail "refuse to create si la identity property no es escribible" |
| 429 de HubSpot (rate limit) | ago 2026 (atacado en `ecd4ed0`) | Search API de HubSpot tiene policy group propio a 5 req/s por cuenta; acotar concurrencia no acota tasa | `hubspotRateLimiter` + `hubspotTransport` con limitador de tasa explícito — confirmado en cero en producción |
| Amplificación de fallos de batch | ago 2026 | Cualquier error en un batch degradaba ~200 requests a individuales, justo cuando HubSpot ya limitaba | `createWithConflictSplit`: bisección de conflictos 409, el resto del chunk no se amplifica |
| ~219 compañías con `cedula` vacía | ago 2026 | `FieldMapping` duplicado para el mismo `targetField`; el último por `_id` sobreescribe incluso con `null` | `mappingValueResolver.service.js` (motor único) + cadena de fallback configurable |
| `$set` de Mongo se cae completo | ago 2026 (13-08) | `$select` como clave literal dentro de `sapAudit`; Mongo < 5.0 rechaza claves con `$` | (documentado como lección; el audit evita incluir claves con `$` sin castear) |
| Duplicación de ContactEmployees con plus-addressing | ago 2026 (revert 08-26) | Contacto viejo con email limpio sin `internalcode`; la nueva regla de identidad lo trató como "otro dueño" | Revert completo; se conserva solo "find por internalcode primero, email al final" |
| Caída de producción — 502 / crash-loop | sep 2026 (25-09) | API/worker recreados en red de Docker distinta a la de MongoDB (`EAI_AGAIN`) | `docker-compose.yml` declara la red de Mongo como `external` y la asigna explícitamente a `api`/`worker` |
| Duplicados diarios en Noelito por `Duplicate IDs` | oct 2026 (resuelto en `5fd5978`, 10-06) | `Duplicate IDs` en `batch/update` mandaba el chunk al fallback de a uno, que buscaba solo por email y recreaba el BP sin email | `sap-record-ownership.js`: un registro hallado por validación secundaria con otra llave SAP propia no se adopta como existente |
| Ruta OData inexistente para cédula en S/4 | sep 2026 (spec 09-14) | `to_Customer.BPTaxLongNumber` no existe en el modelo S/4; da 404 | Ruta correcta `to_BusinessPartnerTax.BPTaxLongNumber` (colección, primera fila por `BPTaxType`) |
| `DocumentsOwner` asignaba otra persona sin error | sep 2026 | `SlpCode` (`/SalesPersons`) y `EmployeeID` (`/EmployeesInfo`) son catálogos distintos; se usaba el mismo código para ambos | `OwnerMappings.sapOwnerId_2` separado, con `resolveDocumentsOwnerCode` condicionado por el flag `userField` del `FieldMapping` |
| PATCH posicional corrompe líneas de cotización | sep 2026 | `B1S-ReplaceCollectionsOnPatch` sin `LineNum` hace merge posicional, no por `LineNum` | Siempre enviar `LineNum` explícito; altas con `max(LineNum)+1` |
| Carpeta de `migrate-mongo` eliminada | mar 2026 (`48b82a6`), sin resolver a la fecha | Se borró `scripts/migrations` sin actualizar `migrate-mongo-config.cjs` | No resuelto formalmente; el equipo usa scripts one-off en `scripts/` corridos a mano por tenant, documentados en el vault |

---

## Fuentes

- **`git log`** (vía `Bash`, de solo lectura) sobre el checkout local en `C:\Users\ale_1\OneDrive\Escritorio\Proyectos\SAP`: listado completo de 623 commits desde `fa618ed` (2025-11-20) hasta `1305b31` (2026-10-11), y `git show -s --format` puntual para confirmar fechas exactas de ~25 commits hito citados en este documento. Es la fuente de todas las fechas y hashes.
- **`mcp__plugin_claude-mem_mcp-search__mem_search`** (modo `auto`, filtrado por `project: SAP`): 7 búsquedas sobre temas clave — arquitectura/migración inicial, autenticación de rutas y OAuth (10-06), AddressExtension (10-08), rate limiting de HubSpot, el incidente de 5,691 duplicados, la caída de red Docker (09-25), onboarding de tenants (Distelsa/Printer/AMC/Multiquímica/Noelito), la ruta OData de cédula en S/4, y los duplicados de contactos en Noelito. Devolvió observaciones consolidadas de sesiones de trabajo pasadas (no transcripciones crudas) con causa raíz, archivos tocados y cifras concretas (por ejemplo, el desglose de 2,334 grupos de duplicados en Noelito y el de 691 BPs sin email). La búsqueda sobre "inicio del proyecto / migración Sequelize→MongoDB" no devolvió señal propia — esa parte se cubrió con `git log` solamente.
- **`07-Historial-y-Migraciones.md`** (bóveda Obsidian `Smart-Connect-SAP`, verificada contra `1305b31`, 2026-10-11): fuente principal para la narrativa de agosto-octubre 2026 (las "olas" de trabajo, el estado de `migrate-mongo`, el catálogo de scripts de migración y operativos, y el índice de specs/planes en `docs/superpowers/`). Se usó para estructurar y verificar, no se copió literalmente.

No se inventó ninguna fecha, cifra ni causa raíz que no apareciera en alguna de estas tres fuentes. Donde el período (nov. 2025 – jun. 2026) solo tiene mensajes de commit poco descriptivos y sin respaldo de claude-mem, se dice explícitamente en la sección correspondiente.
