# Decisiones y problemas — Smart-Connect-SAP

Handoff técnico. Verificado contra el código en `1305b31` (2026-10-11). Fuentes: vault Obsidian
`07-Historial-y-Migraciones.md`, specs/plans en `docs/superpowers/` (22 specs, 19 plans, jul–sep 2026)
y memoria persistente del autor original. Rutas `src/...` citadas tal como aparecen en los specs —
verificar línea exacta contra el código actual antes de asumirla vigente.

---

## 1. Decisiones de arquitectura/diseño

### 1.1 Auditoría completa de tráfico SAP (`sapAudit`)

Spec: `docs/superpowers/specs/2026-08-06-webhook-sap-audit-design.md`.

- **Qué**: cada `WebhookEvent` guarda, en un campo nuevo de primer nivel `sapAudit` (no dentro de
  `payload`), todo lo que se envió y recibió de SAP para BusinessPartner/ContactEmployee/documento,
  tanto en éxito como en error.
- **Por qué**: antes la propagación era asimétrica entre los 4 use cases de webhook — solo 2 de 4
  colgaban el payload de SAP en el error, y nunca la respuesta. Un `createQuotation` fallido quedaba
  sin forma de diagnosticarse sin reproducir el caso.
- **Decisiones puntuales**: una sola escritura al cerrar el evento (no por reintento); el último
  intento sobrescribe; alcance = los 4 use cases de webhook de deal; las claves viejas
  (`payload.payloadSAP`, `payload.payloadBPSAP`, `payload.responseBPSAP`) se dejan de escribir porque
  se verificó que nadie las lee.
- **Corrección posterior (2026-08-13)**: el diseño original solo auditaba el valor de **retorno** de
  cada adapter, así que la llamada que **lanza** (ej. un `POST /BusinessPartners` rechazado por un
  stored procedure) no dejaba rastro y `sapAudit` quedaba `null`. Se agregó `createSapCallRecorder`
  (`src/infrastructure/sap/sapCallRecorder.js`), que envuelve los adapters a nivel de transporte y
  graba la llamada **antes** de saber si va a fallar.
- Ver también §2.1 (bug de claves `$` en Mongo) y §2.2 (eventos `skipped` con `sapAudit: null`), que
  salieron de este mismo trabajo.

### 1.2 Fallo parcial y audit log en el webhook de precios de line items

Spec: `docs/superpowers/specs/2026-08-17-line-item-price-partial-failure-audit-design.md` (PR #111).

- **Qué**: una línea de deal con 404 al leerla de HubSpot, o sin lista de precios en SAP, ya no tumba
  el deal completo — se descarta esa línea y las demás se valorizan. Se agrega un campo `audit` en
  `LineItemPriceWebhookEvent` con el detalle por ronda (`stage: hubspot_read | sap_price |
  hubspot_write`). Al final hay **una sola ronda de reconciliación** que relee el deal y reusa una
  caché de SAP por invocación.
- **Alternativas descartadas** (tabla completa en el spec): colección nueva de auditoría (duplicaría
  consultas); arreglar solo el `SyncLog` (mezclaría precios con todas las demás sincronizaciones);
  reconciliación en el controlador (lo convierte en orquestador de negocio); bucle de reconciliación
  hasta que no haya progreso (impredecible, HubSpot corta webhooks lentos); reconciliación diferida en
  worker (mete infraestructura de cola en un flujo síncrono); detectar "sin precio" mirando solo
  `price == 0` (un 0 puede ser legítimo); tolerar también fallos "fatal" (marcaría como bueno un
  evento que no hizo nada); reutilizar `buildWebhookSyncErrorEntry` para el audit (no sanitiza claves
  `$`, rompería el `$set` — ver §2.1).
- **Deuda explícita**: migrar la estrategia hermana `dealPriceList` al mismo lector tolerante a
  fallos queda fuera de alcance (ya tolera parcialmente); unificar las 3 copias de "leer deal+líneas"
  que existen en el repo también queda pendiente.

### 1.3 Múltiples horas de ejecución por `ClientConfig`

Spec: `docs/superpowers/specs/2026-09-06-client-config-multi-execution-times-design.md`.

- **Qué**: `executionTime` pasa de `String` a `[String]` (ej. `["07:00","12:00","15:00"]`). BullMQ no
  soporta un único cron agrupado salvo que todas las horas compartan minuto, así que la solución es
  **un `upsertJobScheduler` por hora** (`sap-sync:<tenant>:<configId>:<i>`, índice 0-based sobre el
  array ya ordenado y deduplicado).
- **Alternativas descartadas**: tres `ClientConfig`, una por hora (se descartó porque los
  `FieldMapping` se buscan por `clientConfigId` y no se copian al crear una config nueva — serían 3
  juegos de mapeos a mantener sincronizados a mano); campo nuevo `executionTimes` dejando el viejo
  como legacy (el normalizador tolerante hace falta igual por `.lean()`, así que no compra nada); un
  solo scheduler con cron agrupado (rompe con minutos mezclados: `0,30 7,12 * * *` dispara también a
  las 07:30 y a las 12:00); borrado por prefijo en Redis (cambia la semántica de borrado de configs
  que hoy funcionan bien); sufijo por hora en vez de por índice (el conjunto de nombres posibles deja
  de ser fijo y el borrado vuelve a depender de conocer el estado anterior).
- **Trampa evitada**: guardar el array sin tocar el scheduler no da error — `resolveSchedulePlan` hace
  `String(["07:00","12:00"])` → `"07:00,12:00"`, no matchea el regex de hora, y la tarea se **borra**
  en silencio. Por eso el cambio de schema y el del scheduler van en un solo commit.

### 1.4 Alta, baja y actualización completa de líneas en `updateQuotation` (Distelsa)

Spec: `docs/superpowers/specs/2026-09-10-quotation-line-add-remove-design.md`.

- **Problema medido**: `updateQuotation` solo sabía actualizar líneas existentes; una línea agregada
  en HubSpot se descartaba con un `warn` y el evento cerraba `completed` sin error.
- **Hallazgos empíricos sobre el Service Layer** (medidos contra `SBO_DISTELSA_PROD`, no documentados
  por SAP): con `B1S-ReplaceCollectionsOnPatch: true` y `LineNum` explícito en cada entrada, SAP hace
  merge por `LineNum` (conserva campos no enviados), elimina las filas cuyo `LineNum` no viene, y
  agrega las de `LineNum` nuevo. **Una entrada sin `LineNum` hace merge posicional** y cruza campos
  entre artículos **en silencio** — es la trampa que obligó a rediseñar el spec original.
- **Decisión**: `B1S-ReplaceCollectionsOnPatch` con `LineNum` explícito en *todas* las entradas, sin
  flag por tenant (el comportamiento de las líneas existentes no cambia, así que no hay nada que
  aislar), sin echo-back (el merge por `LineNum` ya preserva lo no enviado), altas con
  `max(LineNum existente) + 1` (nunca `length`, porque los `LineNum` dejan huecos al borrar).
- **Decisión 7 — vaciar un campo mapeado en HubSpot lo vacía en SAP**: distingue *propiedad ausente*
  (se omite del PATCH, como hoy) de *propiedad presente y vacía* (viaja como `''` para limpiar el
  campo). Es un cambio de comportamiento deliberado: un campo corregido a mano en SAP que quede vacío
  en HubSpot se limpia en el siguiente update.
- **Alternativas descartadas**: reemplazo total sin `LineNum` (el diseño original, descartado por la
  trampa del merge posicional); echo-back del estado de SAP (innecesario, ~200 campos a mantener);
  convergencia con el builder de creación (cambiaría el comportamiento de líneas existentes); flag
  `quotationLineSyncMode` por tenant (aísla un cambio que, medido, no existe); cancelar y recrear la
  oferta (cambia el `DocNum` que ya se le dio al cliente); `DELETE` de líneas individuales (no existe
  en el Service Layer); `Quantity: 0` o `LineStatus: bost_Close` para "eliminar" (deja la línea
  visible en la oferta impresa).
- **Fuera de alcance**: reordenar líneas existentes (reasignaría `LineNum`, la misma trampa); paginación
  de `/associations/line_items` en los workflows de HubSpot (límite 500/página; con eliminación activa
  una página perdida **borraría** líneas de SAP — deuda anotada); el trigger de los workflows de
  HubSpot (sin re-enrollment, el cambio no se ejecuta si nadie corrige el workflow).

### 1.5 Crear ofertas de venta en SAP S/4HANA desde HubSpot (Multiquímica)

Spec: `docs/superpowers/specs/2026-09-14-s4-create-quotation-design.md`.

Seis decisiones de diseño, cada una con alternativa descartada explícita:

- **D1 — Bifurcación por puerto + factory, no casos de uso paralelos.** `ProcessHubspotCreateQuotation`
  conserva intactos idempotencia, `SapDocumentLink`, audit trail y write-back; solo se le inyectan 3
  colaboradores resueltos por `sapFlavor` (`SapDocumentBusinessPartnerPort`, `SalesDocumentBuilderPort`,
  `SapSalesDocumentPort`). *Descartado*: casos de uso paralelos (duplicaría ~280 líneas de
  idempotencia/auditoría/write-back por flujo; con los 3 flujos pendientes serían ~1.100 líneas
  desincronizables); modelo de documento neutro + traductor (obliga a reescribir el builder que corre
  en 4 tenants de producción).
- **D2 — El adapter de S/4 devuelve una respuesta con forma de B1** (`DocEntry`/`DocNum`/
  `DocumentLines[].LineNum` normalizados desde `SalesQuotation`/`SalesQuotationItem`). *Descartado*:
  hacer `updateAfterSap` consciente del flavor (mete SAP en una capa de HubSpot que hoy no sabe nada
  de eso).
- **D3 — Área de ventas y clase de documento: mapeo del negocio, con default de configuración**
  (mapeo `deal/orders-quotations` → default `s4SalesDocument` → error). *Descartado*: una combinación
  fija por tenant (Multiquímica tiene 10 organizaciones y 16 combinaciones org/canal vivas); reusar
  `s4PriceList.defaultPriceListBySalesArea` (mezclaría precios con documentos).
- **D4 — Precio: por defecto no se manda.** S/4 valoriza con sus propias condiciones (ZPR0); mandar un
  precio de HubSpot pisaría una revaloración legítima con un número viejo. Configurable vía
  `s4SalesDocument.priceConditionType`.
- **D5 — Vendedor por función de interlocutor** (`to_Partner: [{PartnerFunction, Personnel}]`), con la
  misma regla de omisión que `DocumentsOwner` en B1: si no se resuelve, la clave no viaja nunca en
  `null`.
- **D6 — Recorte: no se crean contactos en S/4** en esta entrega (en S/4 un contacto es otro
  `A_BusinessPartner` + relación `BUR001`, con su propio rango de numeración — más caro que el
  `ContactEmployee` anidado de B1).
- **Hallazgo que forzó una corrección del spec**: una versión previa decía `to_Customer.BPTaxLongNumber`
  para la cédula; ese campo **no existe** (404 del gateway). El número vive en
  `to_BusinessPartnerTax.BPTaxLongNumber`, que además es una **colección** (72 BPs tienen más de una
  fila de impuesto) — quedarse con la primera es una decisión explícita, no un detalle.
- **Riesgo documentado**: todo el spec se escribió sin acceso de red al sistema real (`TCP timeout` en
  `172.23.2.28:44300`); los nombres de campo exactos quedan sujetos a la "Tarea 0" de verificación en
  vivo antes de codificar.

### 1.6 ContactEmployees con email duplicado — implementado y revertido

Spec: `docs/superpowers/specs/2026-08-25-contact-employee-email-dedup-design.md`. **Estado: REVERTIDO**
(commit `4bae00c`, 2026-08-26).

- **Qué se intentó**: identidad de ContactEmployee por `internalcode` (no `idsap`) y, cuando el email
  limpio ya tenía dueño, plus-addressing (`localpart+InternalCode@domain`) para separar CEs que
  comparten correo.
- **Por qué se revirtió**: en producción duplicó contactos. El contacto viejo que tenía el email limpio
  no traía `internalcode`, la regla lo trató como "otro dueño" y creó `x+1062@…` al lado de `x@…`.
  Pedido explícito del cliente tras el incidente: **el email nunca se reescribe**.
- **Qué sobrevivió**: el find de ContactEmployee por `internalcode` primero y email al final (sin la
  parte de plus-addressing) — es el comportamiento vigente desde el 2026-08-25/26.

### 1.7 La cabecera de SAP sale solo del `FieldMapping`, en todos los flujos

Spec: `docs/superpowers/specs/2026-08-20-fieldmapping-only-header-fields-design.md`.

- **Regla textual del dueño del proyecto**: *"Si no viene en el payload de HS y no está en el
  FieldMapping, no se toma. Así para todos, incluyendo inventory transfer. [...] Si por error algún
  campo no viaja en el payload de HubSpot, entonces es un error que se debe corregir desde HubSpot."*
  Ver también §3 (gotcha de dirección de FieldMapping) y la memoria `client-owned-field-mappings`.
- **Qué se cerró**: 5 propiedades de Noelito que estaban hardcodeadas por nombre en
  `ProcessHubspotWebhookEvent.js` y en `order-builder.service.js` (teléfono, direcciones, comments) se
  movieron a filas de `FieldMapping` reales — **en ese orden**, filas primero, código después, porque
  borrar el código sin las filas le habría borrado esos datos a Noelito sin ningún error visible.
  También se cerró `updateQuotation`, el único flujo que nunca llamaba a `mapHubspotToSapFields`.
- **Efecto colateral intencional**: editar líneas de una cotización ya no pisa la cabecera de SAP con
  valores viejos, porque `mapHubspotToSapFields` solo produce clave para lo que el evento trae.
- **Alternativa descartada explícita**: mandar la cabecera mapeada incondicionalmente en cada PATCH,
  incluidos los campos vacíos — dejaría a HubSpot como fuente única de verdad, pero cualquier corrección
  manual en SAP se perdería en la siguiente edición de líneas. Rechazado por el dueño del proyecto.
- **Efecto secundario (bug cerrado a medias)**: `mapHubspotToSapFields` pasa a tratar los textos
  `'null'`/`'undefined'` igual que `null` real (con `warn` nombrando los dos campos involucrados), para
  que el valor sucio se corrija en HubSpot y no en código. Aplicar lo mismo en `toNonEmptyString`
  (208 usos en 34 archivos, en su mayoría identificadores) se descartó por el tamaño del cambio —
  queda anotado como deuda.

### 1.8 Propiedad total de todas las bodegas (B1) — revierte una decisión anterior

Spec: `docs/superpowers/specs/2026-09-02-b1-warehouse-total-property-design.md`.

- El spec del 2026-08-20 (`b1-warehouse-stock-metric-design.md`) había decidido que la columna
  acumulativa de bodegas se resolvería con una propiedad calculada del portal. **Esa salida no existe**:
  HubSpot no permite propiedades calculadas ni workflows sobre productos. Se revierte: el total se
  calcula en `b1-item-warehouse.strategy.js`, como una entrada más de `fieldsWareHouseHS` con
  `valueSAP: "*"` (mismo comodín que ya usa S/4 en `stockType`).
- **Decisión clave**: el total suma solo las bodegas **declaradas** en la config (menos las excluidas),
  no todo lo que reporte SAP — así cuadra con la suma de las columnas visibles y una bodega nueva en B1
  no se filtra sola al inventario publicado.
- **Alternativas descartadas**: clave de config nueva `warehouseTotalProperties` (separaría en dos
  lugares una config que se edita junta); flags `"total": true` (forma de entrada nueva que la UI
  admin tendría que aprender); sumar todo `ItemWarehouseInfoCollection` (deja de ser auditable desde
  HubSpot); redondear también las columnas por bodega (movería valores ya en producción).

### 1.9 Precio de producto desde `ItemPrices` según lista de precios (Printer)

Spec: `docs/superpowers/specs/2026-08-18-product-price-from-item-prices-design.md`.

- **Problema**: el sync de productos escribía siempre `0.0` salvo que el record viniera marcado por una
  de dos strategies existentes, ninguna aplicable a un tenant cuyo precio vive dentro del array
  `ItemPrices` filtrado por `PriceList`.
- **Decisión**: config `productSyncStrategy.requirePrice.source` opcional y anidada
  (`{from: 'itemPrices', priceField, onMissingPrice}`); **ausente o `from: 'mapped'` reproduce la ruta
  de hoy byte por byte**, protegiendo al tenant productivo que ya usa ese documento.
- **Restricción dura explícita**: cualquier diseño que exigiera tocar el documento `productSyncStrategy`
  del tenant productivo existente quedaba descartado de entrada.
- **Alternativas descartadas**: mapeo directo `ItemPrices.Price → hs_price_gtq` (funciona *de
  casualidad* porque el resolver toma `current[0]` sin mirar `PriceList` — con `mappingFallback`
  activo se llevaría el precio de cualquier lista sin aviso: "bug latente disfrazado de config");
  reinterpretar `requirePrice.value: true` (cambia el significado para el tenant productivo); enricher
  nuevo en vez de resolver en la strategy (válido como plan B, pero leería la config dos veces);
  matchear por moneda (`"QTZ"` es el código interno de B1, no el ISO `GTQ` — no calza sin mapa de
  traducción).

### 1.10 `upsertDataSAP` — actualizar BP/ContactEmployee existentes desde webhooks de deal

Spec: `docs/superpowers/specs/2026-08-10-upsert-data-sap-design.md`.

- **Qué**: hoy un BusinessPartner o ContactEmployee que ya existe no se actualiza nunca desde un
  webhook de deal (solo se crea si no existe). Config nueva `upsertDataSAP` con listas explícitas de
  campos SAP (`fieldsUpdated_BP`, `fieldsUpdated_CE`) que, si difieren del valor mapeado de HubSpot,
  disparan un PATCH.
- **Decisiones**: passthrough genérico de nombres de campo SAP (máxima flexibilidad, el tenant es
  responsable de usar nombres reales); **el fallo del PATCH no bloquea** la creación del documento —
  se registra en el audit trail y el flujo sigue; un valor vacío/ausente de HubSpot nunca borra un
  dato en SAP; comparación tolerante a formato (`3` vs `"3"` no dispara PATCH, mayúsculas sí).
- **Alcance deliberado**: solo webhooks de deal; el sync batch (`mainDataInUpdate: 'SAP'`) no se toca
  para no afectar tenants que ya lo usan.

### 1.11 Reenvío de webhooks de HubSpot tras un fallo definitivo

Spec: `docs/superpowers/specs/2026-08-17-webhook-event-resend-design.md`.

- **Problema de fondo**: un workflow de HubSpot no se vuelve a ejecutar una vez corrido, y mover el
  deal de etapa para forzar re-enrollment no es viable en pipelines que no retroceden. Además, el
  payload guardado es una foto — reenviar el evento viejo mandaría la misma data mala. **El reenvío
  tiene que traer un payload fresco desde HubSpot.**
- **Solo el estado `errored` habilita reenvío** — es el único que garantiza que no hay documento creado
  en SAP. `sap_created_hubspot_error` (SAP sí creó el documento) queda explícitamente fuera: reprocesar
  crearía un segundo documento; se resuelve escalando a soporte.
- **`updateQuotation` queda fuera del cambio a propósito**: no está en `DEDUPLICATED_EVENT_TYPES`
  porque actualizar una cotización varias veces es legítimo; aplicarle la regla nueva *agregaría* una
  restricción que hoy no existe.
- **Índice único nuevo con `dedupActive` dentro de la llave** (no solo en el filtro parcial): es lo que
  permite que el índice viejo y el nuevo convivan durante la migración (Mongo no acepta dos índices con
  la misma llave que difieran solo en `partialFilterExpression`), evitando una ventana sin protección
  sobre `createDeal`.
- **Propiedad de estado en HubSpot** (`sap_integration_status`, 4 valores que ciclan) en vez de un
  checkbox o una UI extension. *Alternativas descartadas*: volver a mover la etapa (choca con el
  problema original); checkbox que el workflow desmarca (se puede quedar trabado); botón con UI
  extension (agrega una plataforma entera que mantener); reintento parcial post-SAP (sería un segundo
  flujo de reproceso completo — se deja para si el cliente lo pide seguido).
- **Invariante explícito**: *"El sistema nunca duplica en SAP. Lo que HubSpot muestre en la propiedad
  es informativo y puede desincronizarse sin costo."*

### 1.12 BusinessPartner completo HubSpot→SAP (`BPAddresses` + `ContactEmployees` + `Properties1..64`)

Spec: `docs/superpowers/specs/2026-08-11-business-partner-full-creation-design.md`.

- **Qué**: convertir el whitelist cerrado de 9 campos del POST de creación de BP en una **strategy por
  configuración** (`businessPartnerCreation.payloadStrategy`: `legacyWhitelist` default vs
  `fullMapped`), capaz de anidar `BPAddresses` y `ContactEmployees` en un único POST y de expandir
  `Properties1..64` desde una propiedad multi-select de HubSpot.
- **Restricción dura**: cero regresión — la strategy por defecto reproduce el comportamiento actual
  byte a byte; ningún tenant cambia de conducta sin configuración explícita.
- **Por qué no es un cambio global**: los `FieldMapping` de contexto `businessPartner` se leen en
  **ambas direcciones** (ver gotcha §3). Activar "enviar todo lo mapeado" para todos los tenants habría
  empezado a mandar en la creación campos que un tenant solo declaró para leer de SAP.
- **`Properties1..64` nunca es un `FieldMapping`**: es 1 propiedad de HubSpot → N campos de SAP, y el
  índice único de `FieldMapping` es por `sourceField` — no puede expresar un mapeo 1→N.
- Alcance **solo B1**: en S/4 direcciones y contactos son entidades separadas con sus propios POSTs
  (ver 1.5/D6).

### 1.13 Área de ventas y lista de precios desde el negocio (S/4, Multiquímica)

Spec: `docs/superpowers/specs/2026-08-24-s4-price-list-sales-area-from-deal-design.md`. Reemplaza la
decisión de área de `2026-08-18-s4-price-list-line-item-webhook-design.md`.

- **Qué cambia**: el negocio de HubSpot pasa a declarar `sales_organization` y `distribution_channel`
  como propiedades obligatorias; el webhook de precios filtra `A_CustomerSalesArea` por esas dos
  (`Customer + SalesOrganization + DistributionChannel` identifica una sola fila, verificado contra
  8974 filas reales), en vez de desempatar entre las áreas que el cliente ya tiene.
- **Decisión del cliente, caso "0 filas"**: si el cliente no está registrado en esa área, no se cotiza
  con un default — se escriben precios en `0` y una nota explicando por qué, **sobrescribiendo**
  cualquier precio bueno de una corrida anterior (a propósito: un 0 frena la cotización, un precio
  viejo con área equivocada pasa desapercibido).
- **Alternativas descartadas**: lista de precios en una propiedad de la empresa vía `FieldMapping`
  (probado en vivo y funciona técnicamente, pero la propiedad de la empresa es una sola y el cliente
  cotiza en varias organizaciones — resuelve el problema equivocado); pedir también `Division` (es
  `SC` en el 100% de las filas, cero efecto); filtrar por `Currency` (no es parte de la clave y es
  heterogéneo dentro del mismo org/canal); dejar `s4PriceList.salesArea` como fallback (decisión
  explícita del cliente de no cotizar en silencio en un área no elegida).

### 1.14 Decisiones de identidad y ownership (de memoria, confirmadas en producción)

- **Los `FieldMapping` son del cliente.** Si un mapeo produce errores en SAP (ej. `jobtitle → Title`
  de SAP truncando a ~10 caracteres), la respuesta correcta es hacer visible el error, nunca
  "arreglarlo" redirigiendo a otro campo sin que el cliente lo pida. Dicho textualmente por el cliente
  el 2026-08-17.
- **Un `FieldMapping` no declara su dirección**: la decide el par `objectType` + `sourceContext`.
  `includeInServiceLayerSelect` solo filtra el `$select`/`$expand` de SAP; nunca decide qué lado lee el
  mapeo. Es, según la memoria del proyecto, "el error de configuración #1" al armar payloads
  HubSpot→SAP (casos reales: `NumAtCard` en Distelsa, `FederalTaxID → ruc` en Distelsa).
- **Búsqueda SAP→HubSpot: `idsap` primero, `defaultFindHubspot` solo si no existe, nunca adoptar un
  registro con OTRA llave SAP** (`src/domain/sync/sap-record-ownership.js`). Regla pedida por el
  cliente, implementada sin spec/plan aprobados el 2026-10-05 y comiteada dentro de `5fd5978`
  (2026-10-06). Resolvió duplicados diarios de BPs sin email (ver §2.5).
- **`SalesPersonCode` (SlpCode) y `DocumentsOwner` (EmployeeID) son catálogos distintos en B1.** Mandar
  el `sapOwnerId` de `OwnerMappings` en `DocumentsOwner` asigna a otra persona y SAP lo acepta **sin
  error** (5 de 7 casos medidos en Distelsa). Resuelto con un segundo campo `OwnerMappings.sapOwnerId_2`
  (ver §2.6).

---

## 2. Bugs conocidos y resueltos

### 2.1 Mongo rechaza el `$set` completo por una clave con `$` — RESUELTO

**Causa raíz**: el Mongo de producción es anterior a la 5.0 y rechaza cualquier clave con `$` al
inicio (`The dollar ($) prefixed field '$select' ... is not valid for storage`). El primer grabador de
`sapAudit` guardaba `params` de OData como objeto, así que `$select` viajaba como clave. Mongo rechazó
el `$set` **completo**, no solo el campo de auditoría — se perdieron también `status`/`retries`/
`lastError`. Dos `WebhookEvent` quedaron colgados en `sap_order_created` con la orden ya creada en SAP.

**Fix**: `params` se guarda como query string, no como objeto; `sanitizeAuditKeys` sanea toda clave de
todo cuerpo (descarta `@odata.*`, prefija con `_` lo que empiece con `$`, reemplaza `.` por `_`); y
`MongooseWebhookEventRepository.applyUpdates` reintenta sin el `sapAudit` si el `$set` es rechazado, de
forma que el estado del evento siempre se guarda. Documentado en
`docs/superpowers/specs/2026-08-06-webhook-sap-audit-design.md`.

**Trampa para QA**: `mongodb-memory-server` (el de los tests de integración) corre Mongo ≥ 5.0 y **sí**
acepta esas claves — un test de integración en verde no prueba que el documento se pueda guardar en el
Mongo real del cliente.

### 2.2 Eventos `skipped` por idempotencia con `sapAudit: null` — RESUELTO

13 eventos `createQuotation` cerraron `completed` con `sapAudit: null` porque tomaron el atajo de
idempotencia (la cotización ya existía) y no hicieron ninguna llamada a SAP. Un `null` ahí era
indistinguible de "la auditoría está rota". Fix: los 3 flujos con idempotencia marcan
`auditTrail.skipped = {reason, sapDocEntry, sapDocNum}` antes del `return`, y eso cuenta como contenido
real del audit.

### 2.3 `SyncLog` verde con 0 registros — RESUELTO (PR #113 `4ee7267`, commit `b58ac7f`, 2026-08-19)

Tres causas silenciosas que hacían pasar una tarea por "sin novedades" cuando en realidad no corrió:

1. `integrationModeId` apuntando a un `ObjectId` inexistente — `SapSyncDataAdapter.fetchData` caía en
   `default: return null` sin abrir conexión al Service Layer.
2. Un filtro dinámico sobre un campo fecha sin `dynamicType: 'date'` — el builder emitía
   `UpdateDate ge <hoy HH:mm>` contra un campo que SAP guarda a medianoche, así que no pasaba ninguna
   fila a ninguna hora del día.
3. `SAP_TEST_FIXED_DATETIME` en el `.env` de producción enmascaraba la causa 2 (ensanchaba el filtro en
   vez de hacerlo imposible), así que "probarlo bien" quitándola rompía lo que funcionaba.

**Fix**: `SyncLog` ahora persiste `updated`/`skipped`/`skippedReasons`; los descartes dejan de sumar a
`sent`; `fetchData` lanza (en vez de `null`) cuando la config no existe o su modo no resuelve, y el
error queda en `SyncLog.errorMessage` **y** `ClientConfig.lastError`. Script de diagnóstico:
`scripts/diagnose-invoice-sync.mjs <tenantKey> [dealId]`.

### 2.4 Fallo parcial en precios de line items (404 tumbaba el deal completo) — RESUELTO

Ver §1.2. Un `Promise.all` todo-o-nada en `resolveLineItems` hacía que una sola línea con 404 (índice
de asociaciones de HubSpot desfasado tras eliminar una línea) descartara el precio de **todas** las
demás líneas del deal. Resuelto con lectura tolerante por línea (`readDealLineItems`), caché de SAP por
invocación y una ronda de reconciliación.

### 2.5 Duplicados diarios de BP sin email en Noelito — RESUELTO (commit `5fd5978`, 2026-10-06)

**Causa raíz**: un BP de SAP compartía email con otro ya existente en HubSpot (`CL00441`); la capa de
email único del índice lo emparejaba con ese otro registro, y `batch/update` devolvía
`Duplicate IDs found in batch input` — un fallo de payload que manda **el chunk entero** al
`sequentialFallback`. Ese fallback buscaba solo por email, así que **todo BP sin email del chunk** se
creaba de nuevo: 60 duplicados el 01/10, 26 el 02/10.

**Fix**: `src/domain/sync/sap-record-ownership.js` — la segunda validación (email, teléfono…) nunca
adopta un registro que ya trae otra llave SAP (`idsap`/`internalcode`). Un lead sin llaves sí se
adopta. Los duplicados ya creados antes del fix siguen en el portal y hay que fusionarlos aparte (ver
gotcha de merge, §3).

### 2.6 SlpCode vs EmployeeID asignaba el vendedor equivocado — RESUELTO (2026-09-11)

`SalesPersonCode` (tabla `/SalesPersons`) y `DocumentsOwner` (tabla `/EmployeesInfo`) son dos
numeraciones distintas en B1. Usar `OwnerMappings.sapOwnerId` (pensado para `SalesPersonCode`) también
para `DocumentsOwner` asignaba a otra persona — medido en Distelsa: 5 de 7 casos pasaban **sin error**
de SAP (ej. SlpCode 53 → EmployeeID 53 es una persona distinta).

**Fix**: segundo campo `OwnerMappings.sapOwnerId_2` (el `EmployeeID` real), leído solo en dirección
HubSpot→SAP por `resolveDocumentsOwnerCode`. El interruptor por tenant es el propio `FieldMapping`
`DocumentsOwner → <propiedad>`; sin esa fila, el resolver devuelve `null` y el payload no cambia. Bug
de datos vivo y no corregido: dos owners de Distelsa (`82534997` y `82929213`) comparten
`sapOwnerId: 38`, así que un negocio de uno sale a SAP con el vendedor del otro.

### 2.7 ContactEmployee con email duplicado — plus-addressing revertido

Ver §1.6. Implementado (`dba7c40` → `c60cb85`, 2026-08-25) y revertido (`4bae00c`, 2026-08-26) por
duplicar contactos en producción. Queda vigente solo el find por `internalcode` → email.

### 2.8 Textos `"null"`/`"undefined"` escritos literalmente en SAP (Noelito) — RESUELTO

`toNonEmptyString('null')` devuelve `'null'` (es una cadena no vacía), así que `U_ACO_Telefono2` y
`Address` de Noelito llegaban a SAP con el texto literal `"null"`. Fix: `mapHubspotToSapFields` trata
`'null'`/`'undefined'` (sin distinguir mayúsculas, tras `trim()`) igual que `null` real, con un `warn`
que nombra el campo SAP y la propiedad de HubSpot — ver §1.7. No se tocó `toNonEmptyString` en general
(208 usos, mayoría identificadores) — deuda anotada.

### 2.9 BP sin email nunca se actualiza (Noelito) — NO RESUELTO, abierto

`ProcessCrmObjectBatches` valida email **antes** de `index.find()`: un BP sin `EmailAddress` en SAP no
llega ni a create ni a update, **aunque ya exista en HubSpot por `idsap`**. Auditoría del 2026-09-30
sobre 691 BPs de Noelito: 51 existentes sin email que nunca se actualizan, 376 sin email que nunca se
crean, 7 con email inválido, 9 que comparten email con otro BP. `bypassEmail: true` destraba los 51 pero
crea los 376+7 como contactos nuevos sin email, no emparejables con contactos cargados a mano. El
arreglo real es de código: aplicar la validación de email solo al camino de `create`. **Sin hacer a la
fecha del vault (2026-10-11).**

### 2.10 Bugs de costura (mocks que esconden el punto de encuentro producer/consumer) — RESUELTOS

Tres casos de la misma familia, documentados en memoria `mocked-resolver-hides-fetch-seam`:

1. **Batch/expiry (2026-08-13, ya en producción)**: `warehouses: []` significa "todas" en el dominio,
   pero `buildBatchQueryTargets` devolvía `[]` para esa misma config y `fetchStockRows([])` no hacía
   ninguna llamada HTTP — el resultado fue 8.080 productos con 7 propiedades de lote/caducidad
   escritas en blanco, con el sync en `completed`. Invisible por tarea porque el test del adapter
   inyectaba un `stockResolverFactory` doble con fixtures fijas.
2. **Fechas de caducidad en `null` (2026-08-18, ya en producción)**: `parseODataDate` solo aceptaba la
   forma cruda `/Date(ms)/` del Gateway, pero `S4GatewayTransport.fetchAll` ya normaliza a ISO-8601
   antes de que el parser la vea — la forma que el parser aceptaba nunca llega en producción.
3. **Resolver de BusinessPartner en S/4 (2026-09-14, atrapado ANTES de producción)**: el resolver leía
   `response?.value` (forma de colección OData v4) sobre un transporte v2, que entrega un array pelado
   vía `unwrapODataV2Envelope`. Con el `defaultFindSAP` heredado (`EmailAddress`), ese era el camino
   por defecto del tenant — habría creado un BusinessPartner duplicado en cada oferta.

**Lección aplicable al handoff**: una fixture de test debe imitar lo que la capa **inmediatamente
anterior** emite (el transporte ya normalizado), no lo que emite el sistema remoto.

### 2.11 Parámetros de constructor sin cablear en composition, con toda la suite verde

Memoria `composition-wiring-verification`. Ocurrió 3 veces en una sola sesión (ejecución de los planes
de BusinessPartner, 2026-08-11/12): `businessPartnerCreationConfigRepository` agregado al constructor
de `SyncSapConfigToHubspot` pero no pasado por `sap-sync.composition.js` hasta una tarea posterior
(feature silenciosamente no-op mientras tanto); un guard de composition-test con
`expect.any(Object)`, que matchea `null` sin dientes; `logger` agregado y nunca cableado, cada `warn`
previsto se fue a `console` crudo en vez del logger real. Ninguno lo detectó un test — todos los tests
por tarea mockean sus propias dependencias. **Regla operativa**: al revisar un constructor con un
parámetro nuevo, `grep` el nombre exacto en el archivo de composición real, no inferir del test.

### 2.12 5.691 duplicados en HubSpot por matching 1-a-1 — RESUELTO (julio 2026)

Línea de trabajo de 15 commits (28–30 julio 2026, ver `docs/superpowers/plans/2026-07-29-hubspot-crm-batch-sync.md`
y `2026-07-29-hubspot-prefetch-index-matching.md`): el sync masivo buscaba companies/contactos 1-a-1
contra la Search API, generando duplicados por falta de identidad consistente. Resuelto con
`CrmObjectIndex` (prefetch + matching en memoria de dos niveles: identidad + fallback), identity
properties conectadas por tenant y el guardrail "refuse to create when identity property is not
writable" (commit `013801f`, que referencia el incidente real de 5.691 duplicados).

### 2.13 Campo de impuesto inexistente en S/4 (`to_Customer.BPTaxLongNumber`)

Ver §1.5. Una versión anterior del spec de creación de ofertas S/4 asumía ese campo; no existe (404).
Corregido a `to_BusinessPartnerTax.BPTaxLongNumber`, verificado contra el sistema el 2026-09-14. Nota
sin resolver: Multiquímica tiene **dos** `FieldMapping` hacia `cedula` y uno usa la ruta inexistente —
los mapeos con el mismo `targetField` se pisan (gana el último por `_id`, aunque resuelva a `null`),
así que uno de los dos nunca llega a escribir nada. No es parte de ningún spec cerrado — pendiente de
revisar con el cliente.

---

## 3. Gotchas / limitaciones a tener en cuenta

### HubSpot

- **Search API limitada a 5 req/s por cuenta** (policy group propio) — acotar concurrencia en el
  cliente HTTP no acota la tasa. Resuelto en el transporte (`hubspotRateLimiter.js` +
  `hubspotTransport.js`, commit `ecd4ed0`, 2026-08-03) pero sigue siendo el techo real de cualquier
  trabajo masivo contra HubSpot.
- **No existen propiedades calculadas ni workflows sobre productos.** Cualquier totalización o lógica
  derivada sobre objetos `product` tiene que resolverse en el conector, nunca en el portal (ver §1.8).
- **No existen workflows de tipo "Elemento de pedido" (line item).** No se puede disparar un workflow
  sobre un cambio de línea directamente.
- **Los criterios de asociación no sirven como disparador de re-inscripción**, y un criterio ya
  cumplido tampoco re-inscribe (exige la transición no-cumplido → cumplido). Editar líneas solo mueve
  el negocio por los rollups (`amount`, `hs_num_of_associated_line_items`) — una descripción o bodega
  sola, o una cotización con todos los precios en 0, no dispara nada.
- **HubSpot archiva y recrea TODOS los line items en cada edición de la tabla de elementos de pedido**,
  conservando el `createdate` original en el clon. `hubspotLineItemId` nunca es una llave estable; un
  mismo negocio puede tener 3-4 juegos de ids en un día. Solución adoptada en Distelsa: una propiedad
  de control (`enviar_cambios`, con valores que ciclan "Enviado"/"Reenvíar") como único disparador de
  re-inscripción.
- **Fusionar companies (`POST .../merge`) genera un `hs_object_id` NUEVO**, no conserva el del
  primario. `batch/read` **no resuelve alias** (da un falso "no existe"); un grupo de 3 necesita
  re-resolver el ID entre merges; `AssociationRegistries.baseHubspotId` queda apuntando al ID viejo y
  hay que corregirlo a mano tras cada merge. El merge es irreversible (no hay un-merge).
- **La ruta `/associations/default/` exige `Content-Type` aunque no lea el body** — sin `{}` responde
  415 y el fallo se traga en silencio si no se revisa explícitamente.
- **Trampa de enumeraciones**: el portal guarda el label como `value` mientras SAP manda el código, así
  que un filtro contra una lista desplegable puede salir vacío sin ningún error.

### MongoDB

- **El Mongo de producción es anterior a la 5.0 y rechaza cualquier clave con `$` al inicio**, y
  rechaza el `$set` **completo** por una sola clave inválida (no solo el campo malo) — ver §2.1.
  `mongodb-memory-server` (≥ 5.0, usado en tests) sí las acepta: un test de integración en verde no
  prueba que el documento se pueda persistir en producción.
- Cualquier campo de diagnóstico que guarde entrada cruda del cliente (ej. una fórmula mal escrita)
  debe serializarse a string (`JSON.stringify`/`String()`), nunca guardarse como objeto anidado — un
  aviso de error que falla al insertarse se traga en silencio.

### SAP Service Layer / B1

- **No expone las líneas de documento como entidad direccionable** — no hay `DELETE` de una línea. La
  única vía de eliminación es `B1S-ReplaceCollectionsOnPatch` con `LineNum` explícito (ver §1.4).
- **El Service Layer devuelve 20 filas por página e ignora `$top`** — cualquier cruce de datos tiene
  que paginar con `$skip` o produce falsos negativos.
- **`SalesPersonCode` (SlpCode) y `DocumentsOwner` (EmployeeID) son catálogos distintos** (ver §2.6);
  asignar el código equivocado no da error de SAP.

### Configuración y mapeos (Smart-Connect-SAP)

- **Un `FieldMapping` no declara su dirección**: la decide `objectType` + `sourceContext`. Un documento
  en el contexto equivocado no da error, simplemente nadie lo consulta. `includeInServiceLayerSelect`
  solo filtra el `$select`/`$expand` de SAP, nunca la dirección HubSpot→SAP. Diagnosticar "no se mapea
  nada" sin saber esto exige un trace completo por 4 archivos. Ver §1.14 y la memoria
  `hubspot-field-mapping-direction`.
- **Los mapeos duplicados con el mismo `targetField` se pisan, no caen en cascada** — gana el último
  por `_id`, aunque resuelva a `null`. Causó ~219 compañías con `cedula` vacía en otro tenant (resuelto
  con `mappingValueResolver.service.js`, commit `ecd4ed0`) y hoy afecta potencialmente a Multiquímica
  (§2.13).

### Testing / composición

- **Un parámetro de constructor puede quedar sin cablear en composition con toda la suite verde**,
  porque cada test mockea sus propias dependencias (ver §2.11). `expect.any(Object)` matchea `null`.
- **Una fixture de test debe imitar la capa inmediatamente anterior, no el sistema remoto** — si hay un
  normalizador en medio (ej. `S4GatewayTransport`), la fixture va ya normalizada (ver §2.10).
- `npm test` no corre en Windows (`cmd.exe` no interpreta `NODE_OPTIONS=`); comando real:
  `NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns='[\/]node_modules[\/]|[\/]\.claude[\/]'`.
  Los worktrees viven dentro del repo (`.claude/worktrees/`) y jest los levanta si no se excluyen.

---

## 4. Pendientes abiertos

### Multiquímica (S/4HANA)

Abiertos desde la sesión del 2026-08-03 (memoria `multiquimica-project-status`, desactualizada —
verificar estado real antes de asumir nada):

1. **Reporte de duplicados de contactos/companies** (mismo email en varias companies rompe la
   restricción de email único de HubSpot). Sin trabajo registrado específico para Multiquímica (sí
   existe la batería de scripts de deduplicación para otros tenants, §"Scripts operativos" del vault).
2. **Filtros de BP por tax type + tax number**: el motor existe (ver §1.5/§2.13), falta terminar de
   acordar y cargar los `FieldMapping` — y hay un mapeo duplicado hacia `cedula` sin resolver.
3. **Visibilidad de almacén filtrada por grupo de usuario de HubSpot**: no implementado; solo existe el
   mapeo de stock por bodega a propiedades (`warehouseStock.js`), sin control de visibilidad por grupo.
4. **Batch/expiry**: el ítem original (¿puede SAP exponer lote y caducidad vía API?) **ya se resolvió**
   — implementado y mergeado como `batch-expiry-sync` (`e56df7a`, 2026-08-13,
   `docs/superpowers/specs/2026-08-13-batch-expiry-sync-design.md`). No queda pendiente, pero el
   encabezado del spec en el repo sigue diciendo "pendiente de plan" — contradicción documentada, no
   corregida a la fecha del vault.
5. **S/4 `createQuotation`**: solo esa operación está implementada (`3f15c67`, 2026-09-25).
   `updateQuotation`, `convertQuotationToOrder`, `createDeal` (pedido directo),
   `inventoryTransferRequest` y `purchaseQuotation` siguen sin flujo para S/4 — el diseño de puertos ya
   los admite sin rediseñar, pero no están escritos.
6. **Creación de contacto de negocio en S/4** (D6 del spec de §1.5): fuera de alcance deliberado, sin
   fecha.
7. **`sapLineNum` en `SapDocumentLink` es `Number`**, pero la clave real de una posición en S/4 es la
   cadena `'000010'`. Alcanza para crear; el futuro PATCH de `updateQuotation` en S/4 va a necesitar un
   campo `sapLineId: String` nuevo.

### Datos de conexión en texto plano dentro del repo (no la contraseña en sí)

`docs/superpowers/specs/2026-08-10-s4-product-stock-sync-configs.md` (línea 197) trae el usuario real
del Service Layer de Multiquímica (`smarteam`); la contraseña ahí es un placeholder ("la contraseña que
ya tienes en Postman"), no el valor real. `2026-09-14-s4-create-quotation-design.md` (líneas 49 y 90-91)
trae el host real (`vhmldqs4ci.hec.multidomsa.com:44300`) y la topología de red VPN interna
(`172.23.0.0/22` vía `192.168.250.6`, y el host interno `172.23.2.28:44300`). **Acción pendiente**:
sacar usuario/host/IPs del repo (ya quedaron en el historial de git) y, ya que el usuario real está
expuesto junto con el host, tratar la contraseña asociada como potencialmente comprometida y rotarla
por higiene — no porque la contraseña misma esté en el repo.

### Deuda técnica anotada en specs ya implementados

- **Unificar las 3 copias de "leer deal + sus líneas"** y las 2 de "línea → su deal" en el flujo de
  precios de line items (§1.2). Migrar la estrategia `dealPriceList` al lector tolerante compartido.
- **`errors` vs `errorMessage` y la llave `response_SAP`** en el `SyncLog` de precios de line items,
  para un error que en realidad viene de HubSpot.
- **El controlador de precios de line items solo procesa `req.body[0]`**; HubSpot agrupa eventos en
  array y el resto se descarta — hoy disimulado porque cada evento recalcula el deal entero.
- **Paginación de `/associations/line_items` (límite 500) no cubierta** en los workflows de HubSpot;
  con eliminación de líneas activa (§1.4), una página perdida borraría líneas reales de SAP.
- **`toNonEmptyString` no trata `'null'`/`'undefined'` como vacío** fuera del caso ya cerrado de
  cabecera (§1.7/§2.8) — 208 usos en 34 archivos, mayoría identificadores (`hs_object_id`, `cardCode`,
  `itemCode`); cambiar la semántica exige su propia tanda de regresión.
- **BP sin email nunca se actualiza en el sync SAP→HubSpot** (§2.9) — sigue sin arreglarse de raíz.
- **Migración `migrate-mongo` no funcional**: `migrate-mongo-config.cjs` apunta a
  `scripts/migrations`, carpeta eliminada en `48b82a6` (2026-03-03) y nunca repuesta. Los scripts
  `npm run migrate:*` de `package.json` fallarían o reportarían "no migrations". El equipo usa scripts
  one-off en `scripts/*.mjs` (dry-run por defecto) para cualquier cambio de datos.
- **Contradicciones spec↔código** detectadas en la auditoría del vault (2026-10-11): el reenvío de
  webhooks (§1.11) cubre hoy **5** tipos deduplicados (se sumó `purchaseQuotation` en `f806ebc`)
  mientras el spec, el comentario del índice y la migración siguen hablando de 4 — el script de
  migración importa la lista real del código, así que el comportamiento es correcto, solo la
  documentación quedó atrás.

---

## 5. Fuentes

- Vault Obsidian: `C:\Users\ale_1\OneDrive\Documentos\Obsidian Vault\Smart-Connect-SAP\07-Historial-y-Migraciones.md`
  (verificado contra `1305b31`, 2026-10-11).
- Specs (`docs/superpowers/specs/`, rutas relativas a la raíz del repo):
  `2026-08-06-webhook-sap-audit-design.md`,
  `2026-08-17-line-item-price-partial-failure-audit-design.md`,
  `2026-09-06-client-config-multi-execution-times-design.md`,
  `2026-09-10-quotation-line-add-remove-design.md`,
  `2026-09-14-s4-create-quotation-design.md`,
  `2026-08-25-contact-employee-email-dedup-design.md`,
  `2026-08-20-fieldmapping-only-header-fields-design.md`,
  `2026-09-02-b1-warehouse-total-property-design.md`,
  `2026-08-18-product-price-from-item-prices-design.md`,
  `2026-08-10-upsert-data-sap-design.md`,
  `2026-08-11-business-partner-full-creation-design.md`,
  `2026-08-17-webhook-event-resend-design.md`,
  `2026-08-24-s4-price-list-sales-area-from-deal-design.md`.
- Plans (`docs/superpowers/plans/`): `2026-07-29-hubspot-crm-batch-sync.md`,
  `2026-07-29-hubspot-prefetch-index-matching.md` (contexto del incidente de 5.691 duplicados).
- Memoria persistente del autor
  (`C:\Users\ale_1\.claude\projects\C--Users-ale-1-OneDrive-Escritorio-Proyectos-SAP\memory\`):
  `client-owned-field-mappings.md`, `hubspot-field-mapping-direction.md`,
  `sap-sync-silent-zero-records.md`, `mocked-resolver-hides-fetch-seam.md`,
  `bp-without-email-never-updates.md`, `sync-find-order-idsap-then-default.md`,
  `sap-slpcode-vs-employeeid.md`, `hubspot-merge-changes-object-id.md`,
  `hubspot-workflow-line-item-triggers.md`, `mongo-dollar-prefixed-keys.md`,
  `composition-wiring-verification.md`, `multiquimica-project-status.md`.

Nota de vigencia: las memorias tienen entre 11 y 62 días de antigüedad a la fecha de este documento
(2026-10-11); varias llevan advertencia explícita de "verificar contra el código actual". Tratarlas como
observaciones puntuales, no como estado vivo garantizado.
