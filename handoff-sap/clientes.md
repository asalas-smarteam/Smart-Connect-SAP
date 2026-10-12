# Clientes — configuración, personalizaciones y estado

> Ninguna credencial, token ni contraseña real aparece en este documento. Portal IDs, nombres de
> base de datos y códigos SAP **sí** se documentan: son identificadores de configuración, no
> secretos, y son el contenido que necesita quien reciba el proyecto.

## Nota general: cómo identificar un tenant

- **Nunca** uses el `portalId` del body de un webhook para resolver el tenant: en el Mongo local
  llegaron a convivir **tres `SaaSClient` con el mismo portalId `50564010`** (smarteamtest,
  distelsa, multiquimica) y `findOne` devuelve el primero que encuentra — credenciales y config del
  tenant equivocado, sin ningún error. Usa el header `x-tenant-id` (o el bearer) para pruebas
  manuales/Postman.
- Toda operación de datos (migración, auditoría, backfill) es **por tenant**: hay una base Mongo por
  cliente (`sap_integration_<tenantKey>`), más la base maestra `SmartConnect` (`SaaSClients`,
  `Subscriptions`, `Plans`, `ClientConfigs` compartidos). Un script de migración se corre en dry-run
  contra los cuatro tenants de producción antes de aplicar en ninguno.
- Para auditar el portal HubSpot de un cliente **no sirve el MCP de HubSpot conectado a esta
  sesión** (ese apunta al portal de Smarteam, `6553628`). Hay que leer el token del propio conector
  desde el Mongo del tenant (`HubspotCredentials` + `hubspotAuthService.getAccessToken`, que renueva
  y persiste el token si venció — no es "solo lectura" estricto).

## Tenants en producción (al 2026-10-11)

Cuatro bases en el Mongo de producción: `sap_integration_amc`, `sap_integration_distelsa`,
`sap_integration_noelito`, `sap_integration_printer`. Multiquímica (S/4) todavía no está
provisionada ahí — ver su sección.

---

## Distelsa

- **SAP**: Business One (Service Layer), base `SBO_DISTELSA_PROD`.
- **Cotizaciones y órdenes**: es uno de los dos tenants (junto a Printer) con el flujo completo de
  cotización B1 (`ItemDescription` editable por línea, alta/baja de líneas en `updateQuotation`,
  `DocumentsOwner`/`SalesPersonCode` resueltos por FieldMapping).
- **Trampa resuelta — `SalesPersonCode` ≠ `DocumentsOwner`**: son dos tablas SAP distintas
  (`/SalesPersons` vs `/EmployeesInfo`), con numeraciones que **no coinciden**. Mandar el
  `sapOwnerId` de `OwnerMappings` (pensado para `SalesPersonCode`) directo a `DocumentsOwner` asigna
  a **otra persona real** y SAP lo acepta sin error — medido: 5 de 7 casos en Distelsa resolvían a un
  empleado equivocado, sin dejar rastro en `sapAudit`.
  - Arreglo: segundo campo `OwnerMappings.sapOwnerId_2` con el `EmployeeID` correcto, que solo se lee
    en la dirección HubSpot → SAP (`resolveDocumentsOwnerCode` en
    `src/application/use-cases/webhookQuotationSupport.js`).
  - El interruptor por tenant es el propio FieldMapping `DocumentsOwner → <propiedad>` (contexto
    `deal/orders-quotations`), con `userField: true` para que el resolver traduzca el
    `hubspotOwnerId` vía `sapOwnerId_2` (en Distelsa, la propiedad es `digitador`). Sin ese
    FieldMapping, el valor no cambia (resuelve `null`).
  - Cableado solo en `ProcessHubspotCreateQuotation` y `ProcessHubspotConvertQuotationToOrder` — **NO**
    en `updateQuotation` (PATCH), `InventoryTransferRequest` ni `PurchaseQuotation`.
  - Bug de datos conocido y sin resolver: los owners HubSpot `82534997` (Deiver Acuña) y `82929213`
    (Johan Dumas) comparten `sapOwnerId: 38` en `OwnerMappings` — un negocio de Deiver sale a SAP con
    el vendedor de Johan.
- **Observabilidad de facturas**: Distelsa fue el caso que motivó la auditoría del PR #113 — la
  tarea "Obtener Facturas" estuvo en verde con 0 registros desde el 08-12 sin que nada lo mostrara,
  hasta que `SyncLog.updated/skipped/skippedReasons` lo hizo visible.
- **Impuestos (taxCodes)**: IVA = `16597672`, Exento = `18065785` (`hs_tax_rate_group_id`). Las tasas
  de Configuración de HubSpot no se pueden listar por API; el ID solo sale leyendo un line item que
  ya la use.
- **Script de referencia** para duplicados de contactos: `scripts/analyze-hubspot-contact-duplicates.mjs`
  — las reglas de Distelsa (ver más abajo, no aplican igual a Noelito) asumen que el nombre
  identifica razonablemente a la persona.
- **Estado**: tenant maduro, en producción, con el flujo de cotizaciones más completo del repo.

---

## AMC

- **SAP**: Business One, Service Layer `https://172.203.124.38:50000` (certificado autofirmado,
  requiere `rejectUnauthorized: false`), CompanyDB `SBO_DEMO_DGT_AMC260828` (es una base DEMO que
  **se refresca y cambia de nombre** periódicamente — verificar el nombre vigente antes de asumirlo).
- **HubSpot**: portal `49373530`.
- **Series de BusinessPartner**: clientes = serie `75` "Cliente" (default de SAP, prefijo C);
  proveedores = `100` "Prov" y `60` "CChica". Hubo un incidente con `Configuration.defaultSeries`
  apuntando a `16` (no existe en SAP) — todo alta de BP fallaba con
  `-4002 To generate this document, first define the numbering series`. Esa config se aplica sin
  importar el `CardType`.
- **NIT / RFC**: en AMC el NIT real vive en `AdditionalID` (mapeado a `nit`); `FederalTaxID`
  (mapeado a `rfc`) es siempre el relleno `000000000000` en los clientes ya existentes. AMC no tenía
  `Configuration.businessPartnerCreation`, así que usaba por defecto la estrategia
  `legacyWhitelist`, que solo manda `FederalTaxID` (nunca `AdditionalID`) y ni siquiera mira los
  FieldMappings — con `rfc` vacío en HubSpot, SAP respondía `1250000107 - RFC is missing`. Solución:
  `payloadStrategy: fullMapped` + `defaults.BusinessPartner.FederalTaxID: "000000000000"`.
- **BusinessPartner completo desde 2026-09-30**: `businessPartnerCreation` = `fullMapped` +
  `contactEmployeeSource: payloadArray` + direcciones `payloadArray` (`entrega` → `bo_ShipTo`,
  `fiscal` → `bo_BillTo`, ambas `required`), igual patrón que Printer. El workflow
  `Codigos pruebas/AMC/WF_AMC_QUOTATIONS.js` arma las direcciones desde propiedades del **deal**
  (`direccion_/ciudad_/departamento_` + `entrega|fiscal`; `State` = código SAP).
- **País en 2 letras**: el `Country` de cabecera exige código ISO de 2 letras; `pais` en HubSpot
  guardaba el nombre completo ("Guatemala") y SAP respondía `Value too long in property 'Country'`.
- **Trampa de enumerations/dropdowns**: las propiedades `enumeration` de productos en este portal
  guardan el **label como value** (`fabricante`: `"JCB"=JCB`, `grupo_de_articulos`:
  `"REPUESTOS"=REPUESTOS`), pero B1 manda **códigos numéricos** (`Manufacturer=12`, `ShipType=1`,
  `ItemsGroupCode=113`). Un FieldMapping correcto igual deja el campo vacío hasta que el
  `dropdownOptionsSync` reescriba las opciones a `código=value`. El sync no borra opciones viejas:
  `mergePropertyOptions` las oculta (`hidden: true`) para no romper datos históricos.
- `dropdownOptionsSync` **no puede** llenar `PlanningSystem` (`bop_MRP`) ni `ProcurementMethod`
  (`bom_Buy`): son enums fijos de B1, no una colección ni un UDF — se cargan a mano.
- **UDFs conocidos sin catálogo de valores**: `U_Origen` (10 valores), `U_VS` (ligado a
  `SalesEmployee`), `U_SA`, `U_fr` (ninguna de estas dos tiene tabla en el Service Layer — no se
  pueden cargar por ahora).
- **`OwnerMappings` depopulado** (hallazgo separado, verificar si sigue igual): en el tenant
  hermano Printer los 91 registros de `OwnerMappings` tenían `sapOwnerId` nulo (sembrados solo desde
  HubSpot, nunca completados con el código SAP) — vale la pena revisar si AMC tiene el mismo hueco
  antes de asumir que la traducción de vendedor funciona.
- **Artefactos de trabajo en la raíz del repo** (datos de una sesión de configuración, no código —
  revisar si siguen vigentes antes de reusarlos): `amc_warehouse_fields.json` (documento
  `Configuration` `fieldsWareHouseHS` de AMC, bodegas `ALM-0002` etc.); `amc_hubspot_properties.csv`
  / `.json` (export de las propiedades de HubSpot de stock por bodega, para crearlas en bulk);
  `amc_missing_fieldmappings.json` (lista de `FieldMapping` de `company/businessPartner` pendientes
  de cargar, con sus `clientConfigId`/`hubspotCredentialId`); `amc_ubicacion_options_backup.json`
  (backup de las opciones del desplegable de ubicación/bodega antes de una corrida de
  `dropdownOptionsSync`).
- **Estado**: en expansión activa (kickoff reciente, reuniones de seguimiento), con trabajo abierto
  sobre sincronización incremental cada 5 minutos (antes solo full diario) para productos/contactos,
  centralización de direcciones a nivel de compañía (no de deal/oportunidad) y RFC con
  auto-padding de ceros.

---

## Noelito

- **SAP**: Business One. Portal HubSpot `50249912`, ~49.7k contactos, mayoría leads de WhatsApp
  (el nombre **no identifica** a la persona: "Esteli" aparece 11 veces con teléfonos distintos).
- **Bug de duplicados diarios — RESUELTO** (commit `5fd5978`, 2026-10-06, incluido sin querer dentro
  del commit de OAuth): la causa era `Duplicate IDs found in batch input` en `batch/update` cuando
  dos filas SAP apuntaban al mismo contacto de HubSpot (un BP que comparte email con otro BP). Ese
  fallo de payload mandaba el chunk completo al fallback secuencial de a uno, que **buscaba solo por
  email** — así que todo BP sin email de ese chunk se creaba de nuevo (60 duplicados el 01/10, 26 el
  02/10, más los que el portal auto-fusionó por teléfono).
  - Regla aplicada: si el registro se encuentra por `idsap`, no se busca por nada más; si no existe
    por `idsap`, cae a la segunda validación (`defaultFindHubspot`, en Noelito configurado como
    `phone`). La segunda validación **nunca adopta** un registro que ya tiene otra llave SAP
    (`idsap`/`internalcode`) — ver `src/domain/sync/sap-record-ownership.js`.
- **BPs sin email nunca se actualizan** (bug de código, sigue sin arreglar de raíz): la validación de
  email en `ProcessCrmObjectBatches` corre **antes** de construir el índice, así que un BP sin
  `EmailAddress` nunca llega a `update` **aunque ya exista** en HubSpot por `idsap`. Auditoría del
  2026-09-30 sobre 691 BPs de la config de contactos:
  - 247 al día (36%).
  - 51 sin email que existen por `idsap` y **no se actualizan** (nombres y condiciones de pago
    desactualizados sin ningún error visible).
  - 376 sin email que **nunca se crean** (54%, filtrados por la validación).
  - 7 con email inválido (typos, múltiples direcciones, dominios incompletos) → `create` rechazado.
  - 9 que comparten email con otro BP → un solo contacto en HubSpot gana, y es la causa raíz del bug
    de duplicados de arriba.
  - `bypassEmail: true` destraba los 51 pero también crearía los 376+7 como contactos nuevos sin
    email — no es el arreglo correcto. El arreglo real es de código: aplicar la validación de email
    solo al camino de `create`, no al de `update`.
- **Duplicados estructurales — las reglas de Distelsa NO aplican igual aquí**:
  - **MIXTO (BP + su propio ContactEmployee, mismo nombre) es estructural, no un duplicado**: el sync
    crea el BP y su CE como dos contactos de HubSpot (el del CE con email `base+<internalcode>@`).
    Fusionarlos hace que las dos fases se pisen el `firstname` en cada corrida porque ambas escriben
    sobre `hubspotUpdateFields.contact`. **No fusionar** mientras el sync siga así.
  - **`idsap` duplicado en dos contactos = BP duplicado en SAP** (ejemplos: CL00578/CL00501,
    CL00577/CL00540, CL00139/CL00569, CL00183/CL00576, CL00060/CL00545) — HubSpot no lo puede
    resolver solo, hay que limpiarlo en SAP.
  - Para clasificar duplicados en un tenant retail con leads: agrupar por `idsap` además de por
    nombre, quitar el prefijo `CL00xxx - `, y cruzar teléfonos contra SAP (no asumir que "un solo
    identificado → fusionar" es seguro, como sí lo es en Distelsa).
- **Texto `'null'` literal**: Noelito tenía un workflow mal configurado que escribía el string
  `"null"` en `U_ACO_Telefono2` y `Address`. El mapeo ahora descarta (`'null'`/`'undefined'`, sin
  importar mayúsculas, con `trim`) con un warning.
- **Estado**: tenant maduro en producción, con deuda de datos activa (duplicados históricos ya
  creados que hay que fusionar aparte, y el bug de BPs-sin-email pendiente de arreglo de código).

---

## Printer

- **SAP**: Business One.
- **AddressExtension en cotizaciones** (commit `4eb6e6a`, 2026-10-08, PR #117): al crear una
  cotización se arma `AddressExtension` (calle, código postal y país de BillTo/ShipTo) desde un
  objeto de payload de webhook separado, controlado por FieldMapping; país por defecto `GT` si no
  viene. Se omite si no hay datos. **`updateQuotation` (PATCH) no se ve afectado** — mismo patrón de
  "una sola dirección cubierta, la otra no" que otros flujos de este tenant.
- **`DocumentsOwner` vía lista de HubSpot**: a diferencia de Distelsa (que traduce con
  `sapOwnerId_2` porque `userField: true`), en Printer el FieldMapping de `DocumentsOwner` **no**
  tiene `userField: true` — el valor se manda tal cual como entero, porque `ownercode` es una lista
  desplegable de HubSpot cuyo valor interno **ya es** el `EmployeeID` de SAP (ej. `'210'`). Antes de
  este ajuste (2026-09-25) Printer perdía el digitador en silencio porque se buscaba un
  `hubspotOwnerId` `'210'` inexistente.
- **`OwnerMappings` completamente vacío** (hallazgo de auditoría, no confirmado si sigue así): los 91
  registros tenían `sapOwnerId`/`sapOwnerName` nulos — sembrados solo desde HubSpot
  (`source: "hubspot_seed"`) y nunca completados con el código SAP real. Mientras siga así, la
  traducción de vendedor para `propietario_del_contacto_resma_tmk` (FieldMapping con
  `userField: true`) nunca resuelve: el campo se omite del payload hacia HubSpot en vez de fallar
  con un error — el síntoma es "el sync corre bien pero el propietario nunca llega".
- **Bodegas**: 70 bodegas configuradas en `fieldsWareHouseHS`, métrica `inStock`, una entrada por
  sucursal (ej. `AT00`/`AT01` Antigua Guatemala, `BR00` Barberena). Documento de referencia en la raíz
  del repo: `printer_warehouse_fields.json` (artefacto de trabajo, datos, no código).
- **Nombres de contacto / FieldMappings**: hay un script de verificación propio,
  `scripts/verify-printer-name-mappings.mjs`, para las filas de `FieldMappings` (nombres de
  contacto, `U_SUCURSAL`, `U_TIPOCON`) y la regla de precedencia "gana el último por `_id`".
- **Estado de integración por deal** (`sap_integration_status`): funciona en producción —
  publicación de `completed`/`error_retry`/`error_support` sobre una propiedad de HubSpot,
  configurable por tenant, con diseño fail-closed (si falta el nombre de propiedad o cualquiera de
  los tres valores, la función entera se desactiva en silencio en vez de escribir estado parcial).
  Verificado en vivo: el asesor puede sobrescribir el valor manualmente (`not_send`, `retry`) para
  forzar reproceso — comportamiento esperado, pero no documentado hacia el equipo de ventas.
- **Estado**: tenant maduro en producción, con el flujo de cotizaciones más completo del repo junto
  a Distelsa.

---

## Multiquímica

- **SAP**: S/4HANA (Gateway OData v2), **no** Business One — es el único tenant S/4 del proyecto.
  Host de dev/QA: `<host-S4-multiquimica>:44300`, `sap-client=600` (usar placeholder real al
  compartir fuera del equipo; las credenciales viven en el Mongo **local**,
  `sap_integration_multiquimica.SapCredentials`, usuario `smarteam` — **no las repitas en texto
  plano en ningún documento o spec**, ver advertencia de seguridad en `decisiones-y-problemas.md`).
- **Estado de provisión**: al 2026-10-11 Multiquímica **no tiene tenant en el Mongo de producción**
  (no está entre `amc`/`distelsa`/`noelito`/`printer`). Todo el trabajo corre contra un HubSpot dev
  separado ("Smarting") y contra el S/4 directamente. Antes de dar por "vivo" cualquier FieldMapping
  o Configuration de Multiquímica, confirmar que el tenant ya esté provisionado.
- **Cadencia de trabajo**: sesiones semanales los lunes 1–2pm CST ("Integración SAP | Multiquímica"),
  con Elmon Brown y Ryan Corominas del lado del cliente.
- **APIs S/4 confirmadas en vivo** (verificado 2026-08-10 / 2026-08-18 vía curl y catálogo del
  gateway):
  - `API_MATERIAL_STOCK_SRV` → `A_MatlStkInAcctMod`: stock por Material/Plant/StorageLocation/Batch;
    una sola columna de cantidad (`MatlWrhsStkQtyInMatlBaseUnit`), el "tipo" de stock es un código en
    `InventoryStockType`/`InventorySpecialStockType`.
  - `API_BATCH_SRV` → `Batch`: `ShelfLifeExpirationDate`, `ManufactureDate`,
    `MatlBatchAvailabilityDate` — sí hay lote y vencimiento por API, sin desarrollo custom del lado
    SAP.
  - `API_PRODUCT_SRV` (`A_Product` + sub-entidades `A_ProductPlantStorage`,
    `A_ProductStorageLocation`, `A_ProductSales`) — maestro de Centro/Almacén clásico.
  - `API_WAREHOUSE` → es **EWM** (número de almacén), **no** el "Almacén"/`StorageLocation`
    clásico — no asumir que es "la API de bodegas" sin confirmar que el cliente usa EWM (su reporte
    de stock usa Plant/StorageLocation clásico, no bins EWM).
  - `API_SLSPRICINGCONDITIONRECORD_SRV` (+ `A_SlsPrcgCndnRecordScale`, `A_SlsPrcgCndnRecdValidity`) y
    `API_SLSPRICINGCONDITIONTYPE_SRV` — condiciones de precio (ZPR0, ver abajo).
  - **ZMMB no es una API**: es una transacción Z propia del cliente embebida en Fiori vía WebGUI
    (`sap-ui-tech-hint=GUI`), no un servicio OData nativo. Los datos subyacentes son las tablas
    MARD/MCHB estándar, que sí se exponen por `API_MATERIAL_STOCK_SRV`.
  - Confirmadas **no disponibles**: `API_CNDN_PRICE_SRV`, `API_PRICING_CONDITION_SRV`,
    `API_MAT_STOCK_SRV` (nombres mal escritos / no activados).
  - Truco útil para encontrar servicios activos:
    `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection?$format=json&$select=ID,Title&$top=2000`.
- **Modelo de precios ZPR0** (resuelto 2026-08-18): se lee en dos pasos —
  `A_SlsPrcgCndnRecdValidity` (filtrable por `ConditionType`, `Material`, `SalesOrganization`,
  `DistributionChannel`, `PriceListType`, vigencia) da los `ConditionRecord`, y
  `A_SlsPrcgConditionRecord` da la tarifa. Las "listas de precios" son el `PriceListType` del área de
  ventas del cliente (`A_CustomerSalesArea`: ZA/ZB/ZC/ZD). Tres tablas de condición: **502** =
  OrgVentas+Canal+PriceListType+Material (precio por lista), **501 y 504** = OrgVentas+Canal+Material
  (precio por defecto, sin lista). No existen precios negociados por `SoldToParty`.
  - Cuatro trampas verificadas: `$filter=PriceListType eq ''` no filtra (traer todo y clasificar por
    `ConditionTable`); `ConditionQuantity` no siempre es 1 (hay tarifas `2700 USD / 1000 KG`, hay que
    dividir); `ConditionIsDeleted: true` puede existir en registros vigentes por fecha; un cliente
    tiene un `PriceListType` **distinto por organización de ventas** (10 organizaciones).
  - `API_SALES_ORDER_SIMULATION_SRV` (equivalente al `CompanyService_GetItemPrice` de B1) está
    **inservible** en este sistema: de 10 clases de pedido, varias exigen documento de referencia o
    dan "documento incompleto", y la única que pasa valoriza en 0. Hace falta que el equipo
    funcional del cliente habilite una clase sin referencia obligatoria.
  - No hay ninguna API de tipos de cambio activada; las tarifas vienen en USD/DOP mientras los
    clientes facturan en DOP/USD/CRC/GTQ — convertir moneda contra SAP no es posible hoy.
- **Contactos en S/4**: en B1 los contactos son filas de `ContactEmployees` dentro del BP; en S/4 son
  **otro Business Partner** (categoría `1`) más una relación `BUR001`, por eso se identifican con
  `internalcode` y no con `idsap`. La creación de ofertas S/4 **no** crea contactos.
- **Pendientes abiertos desde la sesión del 2026-08-03** (dueño: Alejandro salvo que se indique otra
  persona):
  1. Reporte de contactos/compañías duplicados (mismo email en varias compañías rompe el
     constraint de email único de HubSpot).
  2. Filtro de búsqueda de BP por `BP tax type` + `BP tax long number` (NIT/cédula) — el motor ya
     existe, falta provisionar el tenant y crear los `FieldMapping`.
  3. Preguntar al implementador de HubSpot si la visibilidad de bodega se puede filtrar por grupo de
     usuario.
  4. Confirmado: SAP sí puede exponer lote/vencimiento por API (`API_BATCH_SRV`).
- **Estado**: proyecto en construcción activa, sin tenant en producción, sin credenciales ni webhook
  configurados de forma permanente; cadencia semanal con el cliente.

---

## Otros clientes / SaaSClients detectados

- `smarteamtest` aparece como `SaaSClient` en el Mongo local compartiendo portalId `50564010` con
  Distelsa y Multiquímica — es un portal de pruebas internas de Smarteam, no un cliente productivo.
  Verificar en el Mongo de producción si sigue existiendo antes de asumir que es solo de desarrollo.
- Si al revisar `03-Configuraciones.md` o la colección `SaaSClients` aparece algún tenant adicional
  no cubierto aquí, agregar su sección siguiendo el mismo formato (SAP usado, HubSpot portal,
  personalizaciones, bugs conocidos, estado).

---

## Fuentes

- Bóveda Obsidian `Smart-Connect-SAP`: `Index.md`, `03-Configuraciones.md`, `06-Integracion-SAP.md`,
  `07-Historial-y-Migraciones.md`, `08-Paths-SAP.md` (al día con commit `1305b31`, 2026-10-11).
- Memoria persistente del proyecto: `production-tenant-databases.md`,
  `multiquimica-project-status.md`, `multiquimica-sap-odata-apis.md`, `amc-tenant-hubspot-ids.md`,
  `noelito-contact-duplicates.md`, `sync-find-order-idsap-then-default.md`,
  `bp-without-email-never-updates.md`, `sap-slpcode-vs-employeeid.md`,
  `local-hubspot-webhook-testing.md`, `auditing-client-hubspot-portals.md`.
- claude-mem (historial de sesiones): hallazgos de auditoría de Noelito (691 BPs, breakdown de
  email), configuración de AMC (RFC/NIT, direcciones por deal, UDFs sin catálogo), `OwnerMappings`
  vacío en Printer, estado de integración (`sap_integration_status`) verificado en producción en
  Printer, credenciales/estado de Multiquímica en el Mongo local.
- Repo: `git show --stat 4eb6e6a` (AddressExtension de Printer); artefactos de trabajo en la raíz
  (`amc_hubspot_properties.csv/.json`, `amc_missing_fieldmappings.json`,
  `amc_ubicacion_options_backup.json`, `amc_warehouse_fields.json`, `printer_warehouse_fields.json`).
