# SAP técnico — Smart-Connect-SAP

Documento de handoff técnico de la integración SAP↔HubSpot. Cubre autenticación, endpoints/Service Layer usados, mapeo de campos y particularidades confirmadas en producción. Multi-tenant: Distelsa, Printer, AMC, Noelito (todos SAP Business One) y Multiquímica (SAP S/4HANA).

Verificado contra el repo en el commit `1305b31` (2026-10-11).

## 1. Los dos "sabores" de SAP (`SAP_FLAVORS`)

El conector soporta dos backends distintos, seleccionados por tenant vía `Configurations.sapFlavor` (default `B1`):

| | **B1** (SAP Business One) | **S4** (SAP S/4HANA) |
|---|---|---|
| Protocolo | Service Layer, OData **v4** | Gateway, OData **v2** |
| Base path | `/b1s/v2` | `/sap/opu/odata/sap` |
| Auth | Cookie de sesión (`B1SESSION`) | HTTP Basic + CSRF token en escrituras |
| Mapper de cliente | `src/domain/sap/b1-customer.mapper.js` | `src/domain/sap/s4-customer.mapper.js` |
| Webhooks de documentos | los 6 tipos completos | solo `createQuotation` |

`sapFlavor` determina: modo de ingesta, mapper de cliente, capa de transporte, filtros por default, estrategias de stock/lotes y qué trío de builder/resolver/adapter arma los documentos de venta. Es el parámetro más transversal del sistema.

**Solo B1 (sin camino S/4):** `createDeal`, `updateQuotation`, `convertQuotationToOrder`, `inventoryTransferRequest`, `purchaseQuotation`, `PropertiesN`, `upsertDataSAP`, `B1DropdownCatalogAdapter`, la fórmula de disponible por bodega, los `ContactEmployees`.

La capa de transporte se resuelve en `sapTransportFactory.js::createSapTransport({sapFlavor, config})`, que instancia `B1ServiceLayerTransport` o `S4GatewayTransport` (fallback B1 si el flavor no resuelve).

## 2. Autenticación

### 2.1 B1 — Service Layer (cookie de sesión)

Implementado en `src/infrastructure/sap/sapSessionManager.js`.

- `POST <SAP_SERVICE_LAYER_URL>/b1s/v2/Login` con body:
  ```json
  { "UserName": "<SAP_USER>", "Password": "<SAP_PASSWORD>", "CompanyDB": "<SAP_COMPANY_DB>" }
  ```
- La respuesta trae `Set-Cookie: B1SESSION=...` y `SessionTimeout` (minutos). Credenciales viven por tenant en Mongo (`SapCredentials`: `serviceLayerBaseUrl`, `serviceLayerUsername`, `serviceLayerPassword`, `serviceLayerCompanyDB`) — nunca en `.env`.
- La cookie se cachea en Redis (`sap:session:<tenantKey>`), TTL = `SessionTimeout` SAP menos 20s de margen.
- **Lock de login distribuido** (`sap:lock:<tenantKey>`, `NX PX 12000ms`): evita logins concurrentes contra el mismo tenant; si no se obtiene el lock, se espera con backoff (hasta 2s, timeout total 10s) a que otro proceso publique la sesión en Redis.
- Reintento único ante sesión inválida (401/403 o mensaje "invalid session"/"session timeout").
- Certificado TLS: `rejectUnauthorized: false` (típico de Service Layer on-premise con certificado autofirmado).

### 2.2 S/4 — Gateway (Basic + CSRF)

Implementado en `src/infrastructure/sap/transport/S4GatewayTransport.js`.

- Toda request lleva HTTP Basic (`<S4_USER>` / `<S4_PASSWORD>`) — no hay sesión ni cookie de login equivalente al `/Login` de B1.
- **Lecturas** (`GET`): Basic auth directo, sin CSRF.
- **Escrituras** (`POST`/`PUT`/`PATCH`/`DELETE`): requieren CSRF token.
  1. `GET` sobre el documento de servicio con header `x-csrf-token: Fetch`.
  2. La respuesta trae el token en el header `x-csrf-token` y una cookie de sesión asociada.
  3. El token se cachea en memoria (`this.csrfState`) y viaja en cada escritura junto con la cookie.
  4. Si el Gateway rechaza el token (403 con `x-csrf-token: required`), se refresca una vez y se reintenta la escritura.
- Credenciales también en `SapCredentials` por tenant: `serviceLayerBaseUrl`, `serviceLayerUsername`, `serviceLayerPassword`. No hay OAuth2/`<S4_CLIENT_ID>`+secreto en este flujo — es Basic auth sobre el Gateway clásico (no se usa SAP Cloud/BTP OAuth).

## 3. Endpoints / Service Layer usados

### 3.1 B1 — paths fijos en código

| Path | Qué es | Notas |
|---|---|---|
| `/Login` | Autenticación, devuelve `B1SESSION` + `SessionTimeout` | — |
| `/BusinessPartners` | Clientes, proveedores y leads (entidad central) | `CardCode` (clave), `CardName`, `CardType`, `EmailAddress`, `Phone1`, `PriceListNum`, `GroupCode`, `PayTermsGrpCode`, `FederalTaxID`, `Properties1..64`, colecciones `ContactEmployees` y `BPAddresses` |
| `/BusinessPartners('<CardCode>')` | BP puntual | `GET` para existencia (404 = no existe) y relectura; `PATCH` para upsert y para `ContactEmployees` (array completo, B1 lo reemplaza entero) |
| `/Items` | Productos | `ItemCode` (clave), `ItemsGroupCode` (`Edm.Int32`), `ItemWarehouseInfoCollection`, `ItemPrices` |
| `/CompanyService_GetItemPrice` | Acción POST: precio que SAP aplicaría a artículo+cliente+fecha | Body `{ItemPriceParams:{ItemCode, CardCode, Date}}` |
| `/EnhancedDiscountGroups` | Grupos de descuento vigentes | `requireDiscounts` |
| `/UserFieldsMD` | Metadata de UDF (tabla, nombre, valores válidos) | Fuente de dropdowns |
| `/Orders` | Órdenes de venta (ORDR, ObjectType `17`) | Sync SAP→HubSpot de deals; `POST` desde `createDeal` y `convertQuotationToOrder` |
| `/Quotations` | Ofertas de venta (OQUT, ObjectType `23`) | `POST` desde `createQuotation` (B1) |
| `/Quotations(<DocEntry>)` | Oferta puntual | `GET`/`PATCH` desde `updateQuotation` (ver §5) |
| `/InventoryTransferRequests` | Traslado de inventario (OWTQ, ObjectType `1250000001`) | `POST` desde `inventoryTransferRequest` |
| `/PurchaseQuotations` | Oferta de compra (OPQT, ObjectType `540000006`) | `POST` desde `purchaseQuotation` |
| `/SalesPersons` | Vendedores (OSLP), clave `SalesEmployeeCode` (=SlpCode) | Fuente de `OwnerMappings.sapOwnerId` |
| `/EmployeesInfo` | Empleados (OHEM), clave `EmployeeID` | Fuente de `DocumentsOwner` / `OwnerMappings.sapOwnerId_2` |
| `/Invoices` | Facturas (OINV) | Reconciliación por linaje (ver §6) |

Catálogos para dropdowns (`dropdownOptionsSync`): `/BusinessPartnerGroups`, `/SalesPersons`, `/Currencies`, `/Countries`, `/PriceLists`, `/UserFieldsMD`.

### 3.2 S/4 — Gateway OData v2

| Path | Qué es | Notas |
|---|---|---|
| `/API_BUSINESS_PARTNER/A_BusinessPartner` | Socio de negocio (personas y organizaciones en la misma entidad, `BusinessPartnerCategory: '1'` = persona) | Navegaciones `to_BusinessPartnerAddress`, `to_BusinessPartnerTax`, `to_Customer` |
| `/API_BUSINESS_PARTNER/A_BusinessPartnerContact` | Relación empresa↔persona de contacto | Join en memoria con `A_BusinessPartner` |
| `/API_BUSINESS_PARTNER/A_CustomerSalesArea` | Área de ventas del cliente (org+canal+división) | `PriceListType` del cliente |
| `/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity` | Vigencia de condición de precio ZPR0 | Filtrable por material/org/canal/fechas |
| `/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord` | Registro de condición (tarifa real) | No filtrable por material; se cruza por `ConditionRecord` |
| `/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod` | Stock por material/centro/almacén/lote | Una sola cantidad: `MatlWrhsStkQtyInMatlBaseUnit`; tipo de stock es código (`InventoryStockType`) |
| `/API_BATCH_SRV/Batch` | Maestro de lotes (vencimientos) | Sin navegación al stock; join en memoria por `Material+Batch` |
| `/API_PRODUCT_SRV/A_Product` | Productos | `Product`, `to_Description.ProductDescription`, `BaseUnit` |
| `/API_SALES_ORDER_SRV/A_SalesOrder` | Órdenes de venta | Sync SAP→HubSpot de deals |
| `POST /API_BUSINESS_PARTNER/A_BusinessPartner` | Alta de cliente (deep create) | Antes de crear una oferta |
| `POST /API_SALES_QUOTATION_SRV/A_SalesQuotation` | Oferta de venta (deep create) | Único documento de venta soportado en S/4 |

**Paginación:** B1 pide `Prefer: odata.maxpagesize=100`; sin ese header pagina de a **20 filas e ignora `$top`** por completo. Todo el caminado de `@odata.nextLink` pasa por un único helper (`paginateODataCollection`). S/4 pagina con `__next` (URL absoluta que ya trae el `skiptoken`). **Cualquier conteo o cruce manual contra B1 que no siga la paginación completa da falsos negativos.**

**Servicios S/4 confirmados activos pero no usados en código** (Multiquímica, verificado en vivo): `A_ProductPlantStorage`, `A_ProductStorageLocation`, `A_ProductSales`, `API_WAREHOUSE` (es EWM, no el almacén clásico — no confundir), `API_SLSPRICINGCONDITIONTYPE_SRV`, `API_MATERIAL_DOCUMENT_SRV`, `API_WAREHOUSE_STORAGE_BIN`, `API_WHSE_PHYSINVENTORYITEM`. **No activados** (403 "Ningún servicio encontrado"): `API_CNDN_PRICE_SRV`, `API_PRICING_CONDITION_SRV`, `API_MAT_STOCK_SRV`. No hay API de tipos de cambio activa en ningún tenant S/4 visto.

Para descubrir servicios activos en un S/4 nuevo: `GET /sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection?$format=json&$select=ID,Title&$top=2000`. El `ID` suele tener prefijo `Z` y sufijo `_0001` (no llamable); el **`Title`** da el nombre real a usar en el path.

## 4. Mapeo de campos SAP↔HubSpot

### 4.1 Mecanismo general

El mapeo vive en documentos `FieldMapping` (Mongo), cada uno con `sourceField` (SAP), `targetField` (HubSpot o viceversa), `objectType` y `sourceContext`. **La dirección del mapeo no está en un campo explícito**: la determina la combinación `objectType` + `sourceContext` — hay que revisar cuál de los dos flujos (SAP→HubSpot o HubSpot→SAP) lee ese contexto antes de asumir dónde se usa un mapeo.

Builders de URL OData:
- B1: `serviceLayerUrlBuilder.js::buildServiceLayerUrl` — arma `$select`/`$filter`/`$orderby` OData v4 desde los `FieldMapping`s activos.
- S/4: `s4ODataQueryBuilder.js::buildS4ODataQuery` — variante OData v2, separa `$select`/`$expand` para navegaciones anidadas.

**Regla crítica — duplicados sobrescriben, no hacen fallback:** `mapFields` recorre los `FieldMapping` ordenados por `_id` ascendente y hace `result[targetField] = resolveValueByPath(...)`. El **último** gana, incluso si resuelve a `null`. Dos mapeos al mismo `targetField` no son redundancia segura: el segundo puede vaciar el primero en silencio. Existe un modo opt-in por tenant (`Configurations.mappingFallback: true`) que convierte varios mapeos activos sobre un mismo `targetField` en una cadena ordenada (gana el primer valor no vacío), más `mappingCollectionPriority` para decidir qué fila de una colección gana. Default: apagado en ambos casos.

**Un FieldMapping que SAP rechaza no se arregla cambiando el mapeo sin que el cliente lo pida** — se hace visible el error (ej.: `jobtitle → Title` con límite de 10 caracteres en SAP; la respuesta del conector es exponer el rechazo, no reescribir el mapeo).

### 4.2 Ejemplo: cédula / tax number en S/4

- `to_Customer.BPTaxLongNumber` **no existe** — el Gateway responde 404 ("El recurso no existe para el segmento 'BPTaxLongNumber'"). `A_Customer` solo expone `TaxNumber1..TaxNumber5`.
- El número largo real vive en `to_BusinessPartnerTax` (`A_BusinessPartnerTaxNumber`, clave `BusinessPartner + BPTaxType`), que es una **colección**: un BP puede tener varias filas (una por tipo de impuesto), así que "la" cédula es una decisión de negocio, no un campo único. Usar `mappingCollectionPriority` para fijar el orden de tipos (`BPTaxType`) cuando hay más de uno.
- El query builder de S/4 solo pone en `$select` la **raíz** de la navegación (`to_Customer`), nunca la hoja; por eso una hoja inválida como `BPTaxLongNumber` dentro de `to_Customer` no rompe la URL — el 404/daño es silencioso y aparece recién al mapear el valor.
- Aprox. 219 de ~5.700 compañías (medido en Multiquímica) no tienen cédula resoluble por ningún campo hoy.

### 4.3 Ejemplo: DocumentsOwner vs SalesPersonCode (B1)

Dos numeraciones SAP distintas que no deben confundirse:
- `SalesPersonCode` → `/SalesPersons`, clave `SalesEmployeeCode` (SlpCode). Es lo que guarda `OwnerMappings.sapOwnerId`.
- `DocumentsOwner` → `/EmployeesInfo`, clave `EmployeeID`. **Mandar el SlpCode acá asigna otra persona y SAP lo acepta sin error** (medido en Distelsa: 5 de 7 casos pasaban en silencio con la persona equivocada).

Resolución (`resolveDocumentsOwnerCode`, `src/application/use-cases/webhookQuotationSupport.js`):
- El interruptor por tenant es el propio `FieldMapping` `DocumentsOwner → <propiedad>` en el contexto `deal/orders-quotations`. Sin esa fila, el resolver devuelve `null` y el payload no cambia.
- `userField: true` en ese mapeo (ej. Distelsa, propiedad `digitador`): se traduce el `hubspotOwnerId` vía el campo adicional **`OwnerMappings.sapOwnerId_2`** (el EmployeeID, distinto de `sapOwnerId`).
- Sin el flag (ej. Printer, propiedad `ownercode`): el valor interno de la lista de HubSpot ya ES el EmployeeID y viaja tal cual como entero.
- Sin dato resuelto → `null` + warning, nunca lanza (un digitador sin homologar no bloquea la oferta). Nunca se manda `null` explícito a SAP (SAP completaría con el usuario del Service Layer).
- Cableado solo en `createQuotation` y `convertQuotationToOrder` — no en `createDeal`, `updateQuotation`, `inventoryTransferRequest` ni `purchaseQuotation`.

### 4.4 Ejemplo: tasas de impuesto (IVA) hacia HubSpot

Config `taxCodes`. Dos trampas confirmadas (Distelsa):
- **`FieldItem` va FUERA de `value`**, como hermano de `key`, no adentro. Si falta, `fieldItem` queda `null`, el matcheo contra los datos del Item de SAP no resuelve nada y `hs_tax_rate_group_id` **nunca se escribe** — sin ningún error visible.
- **El ID de una tasa de Configuración de HubSpot (`hs_tax_rate_group_id`) no se puede listar por API** (no hay endpoint público para "Objetos → Cotizaciones → Impuestos"). Única forma confirmada de obtenerlo: aplicar la tasa manualmente a una línea en la UI y leer `hs_tax_rate_group_id` de ese line item.
- El matcheo es asimétrico: SAP→HubSpot busca por `Code` de SAP y escribe `HSCode`; HubSpot→SAP busca por `Rate` contra `hs_tax_rate` de HubSpot. Sin una fila con `Rate: 0` configurada, el webhook lanza `PermanentWebhookError: TaxCode is not configured for hs_tax_rate 0`.
- El sync pisa en cada corrida cualquier exoneración manual que un asesor haya puesto en HubSpot, porque siempre reescribe `hs_tax_rate_group_id` con lo que diga SAP.

### 4.5 Email como índice (B1 y S/4)

La validación de `EmailAddress` del Business Partner corre **antes** del índice por `idsap` en el sync SAP→HubSpot de contactos. Consecuencia: un BP sin email nunca se actualiza en HubSpot, **aunque ya exista ahí identificado por `idsap`**. No es un problema de mapeo — es el orden de las validaciones en `ProcessCrmObjectBatches`. `bypassEmail: true` destraba la actualización pero también crea como nuevos todos los BPs sin email que aún no existen, lo cual puede duplicar contactos cargados a mano en HubSpot sin `idsap`.

## 5. Particularidades B1 vs S/4

### 5.1 Modelo de documentos de venta

Solo `createQuotation` está bifurcado por flavor; el resto de los documentos de venta (`createDeal`, `updateQuotation`, `convertQuotationToOrder`, traslados, oferta de compra) son exclusivos de B1. Para `createQuotation`, el flujo arma un **trío** (resolver de BP + builder de payload + adapter) específico por flavor — mezclar piezas de B1 con S/4 produciría un rechazo del gateway que no se detecta hasta el envío, así que el código obliga a usar el trío correcto.

| Pieza | B1 | S/4 |
|---|---|---|
| Resolver de cliente | `B1DocumentBusinessPartnerResolver` (find-or-create en `/BusinessPartners`, incluye contactos) | `S4DocumentBusinessPartnerResolver` (find-or-create en `A_BusinessPartner`, **sin contactos**) |
| Builder de payload | `buildQuotationPayload` | `buildS4QuotationPayload` |
| Adapter de escritura | `B1SalesDocumentAdapter` → `POST /Quotations` | `S4SalesDocumentAdapter` → `POST /API_SALES_QUOTATION_SRV/A_SalesQuotation` |

Diferencias de payload S/4:
- Cabecera obligatoria validada **antes** de tocar al cliente: `SalesQuotationType`, `SalesOrganization`, `DistributionChannel`, `OrganizationDivision` (clave `s4SalesDocument` como default).
- `RequestedQuantity` viaja como **string** (Gateway exige `Edm.Decimal` como string; un number se trunca o rechaza).
- Precio: por default **no se manda** — S/4 valoriza con sus condiciones ZPR0. Solo se manda `to_PricingElement` si `s4SalesDocument.priceConditionType` está configurado.
- Respuesta normalizada con forma de B1 (`DocEntry = DocNum = SalesQuotation`) para que el resto del flujo (write-back, `SapDocumentLink`) no necesite saber el flavor.
- Sin contactos: S/4 no tiene `ContactEmployees`; un contacto es otro Business Partner (categoría `1`) más una relación `BUR001`. La creación de ofertas S/4 no crea contactos.

### 5.2 PATCH de líneas — exclusivo de B1

`updateQuotation` (PATCH de `DocumentLines`) **no existe para S/4** hoy. En B1, usa el header `B1S-ReplaceCollectionsOnPatch: true`. Ver §5.3.

### 5.3 Semántica de `B1S-ReplaceCollectionsOnPatch` (medido contra producción, SAP no la documenta así)

| En el body | Resultado |
|---|---|
| `LineNum` existente presente | Actualiza la fila y conserva los campos que el body no envía (no hace falta echo-back) |
| `LineNum` existente ausente | **Elimina** la fila — es la única forma de borrar una línea |
| `LineNum` nuevo | Agrega la fila |
| Entrada **sin** `LineNum` | Merge **posicional** — pisa la fila de ese índice. Reordenar líneas sin `LineNum` pegó el `FreeText` de un artículo a otro, con respuesta 204 (sin error) |

- Los `LineNum` son **estables** y dejan huecos al borrar (ej. queda 0 y 3 tras borrar 1 y 2). Una alta nueva usa `max(LineNum) + 1`, nunca `length`.
- El header solo afecta las colecciones presentes en el body: `DocumentSpecialLines` sobrevive intacta a un replace de `DocumentLines`.
- Antes del PATCH hay que validar `DocumentStatus` y cada `LineStatus` como `bost_Open`: una oferta cerrada o con líneas ya convertidas a otro documento haría fallar el PATCH completo.

### 5.4 Precios

- **B1**: `CompanyService_GetItemPrice` (acción POST, precio que SAP aplicaría a cliente+fecha) o `ItemPrices` por lista según configuración; descuentos desde `/EnhancedDiscountGroups`.
- **S/4**: modelo de condiciones **ZPR0**. Un cliente tiene una lista de precios (`PriceListType`: ZA/ZB/ZC/ZD) por área de ventas (org+canal), resuelta en `A_CustomerSalesArea`. Las tarifas se leen en dos pasos (la entidad filtrable no trae la tarifa, la que trae la tarifa no es filtrable por material):
  1. `A_SlsPrcgCndnRecdValidity` filtrada por tipo de condición + material + org + canal + vigencia → devuelve `ConditionRecord`s.
  2. `A_SlsPrcgConditionRecord` con `or` sobre esos `ConditionRecord`s → tarifa real, moneda, `ConditionTable` (502 = por lista del cliente; 501/504 = default del producto sin lista).
  - Resolución: lista del cliente → lista default del área → default del producto. Se descartan registros con `ConditionIsDeleted: true` (pueden seguir "vigentes" por fecha) y tarifas en 0.
  - `ConditionQuantity` no siempre es 1 (hay tarifas por 1000 KG) — siempre dividir para obtener el precio unitario.
  - `$filter=PriceListType eq ''` **no** devuelve los registros sin lista — hay que traer todo por material y clasificar por `ConditionTable`.
  - No hay conversión de moneda (sin API de tipos de cambio activa en ningún tenant S/4 visto); un candidato en otra moneda se descarta explícitamente, no cae al default del producto.
  - `API_SALES_ORDER_SIMULATION_SRV` (equivalente de `CompanyService_GetItemPrice`) está **inservible** en el sistema de Multiquímica: la mayoría de las clases de pedido exigen documento de referencia o dan "documento incompleto"; la única utilizable valoriza en 0. No se usa en producción.

### 5.5 Stock y lotes

| | B1 (`b1_ItemWarehouse`) | S/4 (`s4_PlantStorageLocation`) |
|---|---|---|
| Fuente | `ItemWarehouseInfoCollection` embebida en `/Items` (sin llamada extra) | `API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod` (servicio aparte) |
| "Bodega" | `WarehouseCode` | `Plant` + `StorageLocation` (la misma `StorageLocation` se repite entre centros; `Plant` nunca es opcional) |
| Cantidad | Varias métricas (`InStock`, `Committed`, `Ordered`) | Una sola: `MatlWrhsStkQtyInMatlBaseUnit`; el tipo de stock es un código (`InventoryStockType`) |

Lotes y vencimientos son **exclusivos de S/4** en este conector: el lote vive en `A_MatlStkInAcctMod` (campo `Batch`) y su vencimiento en el maestro separado `API_BATCH_SRV/Batch`. No hay navegación OData entre ambos — se resuelven con dos lecturas y un join en memoria por `Material + Batch`. `BatchIdentifyingPlant` es `""` en todos los lotes observados, así que el join tampoco lleva centro.

### 5.6 Operadores de filtro

Desde una revisión reciente del código, B1 y S/4 soportan los mismos operadores: `eq`, `ne`, `ne_or_null`, `ge`, `in`, `startswith`, `not_startswith`. `ne` descarta filas con la columna en `null` — para campos opcionales usar `ne_or_null`. En `in`, los miembros numéricos van sin comillas en B1 (compara `Edm.Int32`) y siempre como string en S/4.

## 6. Gotchas confirmados en producción

1. **Mapeos duplicados al mismo `targetField` se pisan, no hacen fallback.** Gana el último por `_id` de inserción, incluso si resuelve a `null`. Mitigación: `Configurations.mappingFallback: true` + `mappingCollectionPriority` (opt-in por tenant, default apagado). Ver §4.1–4.2.

2. **`to_Customer.BPTaxLongNumber` no existe en S/4.** La cédula larga vive en `to_BusinessPartnerTax.BPTaxLongNumber` (colección, puede tener varias filas por BP). El query builder solo valida la raíz de la navegación en `$select`, así que una hoja inválida no rompe la URL — el fallo es silencioso al mapear, no al pedir los datos. Ver §4.2.

3. **PATCH de `DocumentLines` sin `LineNum` hace merge posicional en B1**, pegando campos de una línea a otra con respuesta 204 (sin error visible). Con `B1S-ReplaceCollectionsOnPatch: true`, una línea que no viaja en el body se **elimina**. Mitigación: siempre enviar `LineNum` explícito; alta nueva con `max(LineNum)+1`. Ver §5.3.

4. **`DocumentsOwner` (B1) no es lo mismo que `SalesPersonCode`.** Mandar el SlpCode de `OwnerMappings.sapOwnerId` en `DocumentsOwner` asigna otra persona y SAP lo acepta sin error (sin rastro en el audit). Resuelto con el campo adicional `OwnerMappings.sapOwnerId_2` + `resolveDocumentsOwnerCode`, interruptor en el propio `FieldMapping DocumentsOwner → <propiedad>`. Ver §4.3.

5. **Un Business Partner sin `EmailAddress` nunca se actualiza en HubSpot**, aunque ya exista ahí por `idsap`. La validación de email corre antes del índice en `ProcessCrmObjectBatches`. `bypassEmail` destraba la actualización pero duplica contactos sin email cargados a mano. Ver §4.5.

6. **El Service Layer de B1 pagina de a 20 filas e ignora `$top` por completo** salvo que la request lleve `Prefer: odata.maxpagesize=100`. Cualquier cruce o conteo manual (ej. `/EmployeesInfo` contra `/SalesPersons`) que no siga `@odata.nextLink` da falsos negativos. Ver §3.1.

7. **`FieldItem` de la config `taxCodes` va fuera de `value`.** Si se pone dentro por error, `fieldItem` queda `null` y `hs_tax_rate_group_id` nunca se escribe — sin ningún error. El ID de una tasa de HubSpot no se puede obtener por API; solo leyendo `hs_tax_rate_group_id` de un line item que ya la use. Ver §4.4.

8. **El precio ZPR0 con `PriceListType` vacío no se puede filtrar directamente** (`$filter=PriceListType eq ''` no devuelve nada) — hay que traer todos los candidatos por material y clasificar por `ConditionTable`. Ver §5.4.

9. **`API_SALES_ORDER_SIMULATION_SRV` (simulación de pedido S/4) está inservible** en el sistema verificado — no se usa en producción para resolver precios; se depende enteramente de la lectura directa de condiciones ZPR0. Ver §5.4.

10. **Un `FieldMapping` que SAP rechaza no se "arregla" cambiando el mapeo sin autorización del cliente.** La respuesta del conector es exponer el error (el documento falla con mensaje claro), no reescribir silenciosamente un mapeo que el cliente configuró.

## Fuentes

- Bóveda Obsidian: `06-Integracion-SAP.md`, `08-Paths-SAP.md` (al día con commit `1305b31`, 2026-10-11).
- Repo `Smart-Connect-SAP`: `src/infrastructure/sap/` (transporte, sesión, adapters), `src/domain/sap/` (mappers B1/S4, constantes de flavor y filtros). Verificado directamente: `sapSessionManager.js`, `transport/S4GatewayTransport.js`, `transport/B1ServiceLayerTransport.js`, `transport/sapTransportFactory.js`.
- Memoria persistente del usuario: `s4-tax-number-cedula.md`, `sap-patch-document-lines-semantics.md`, `sap-slpcode-vs-employeeid.md`, `bp-without-email-never-updates.md`, `multiquimica-sap-odata-apis.md`, `hubspot-tax-rate-ids.md`.
