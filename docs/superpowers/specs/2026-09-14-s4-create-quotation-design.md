# Crear ofertas de venta en SAP S/4HANA desde HubSpot

Fecha: 2026-09-14

## Problema

El flujo de documentos de venta (oferta, pedido, solicitud de traslado, oferta de compra)
existe **solo para SAP Business One**. Los cuatro casos de uso escriben directo contra el
Service Layer: `sapServiceLayerWebhookRequest` arma la URL como
`${baseUrl}/b1s/v2${path}` ([sapServiceLayerWebhookRequest.js:20](../../../src/infrastructure/sap/sapServiceLayerWebhookRequest.js)),
y el payload se construye con nombres de campo de B1 —`CardCode`, `DocumentLines`,
`UnitPrice`, `WarehouseCode`, `SalesPersonCode`, `PaymentGroupCode`— en
[order-builder.service.js:498](../../../src/domain/orders/order-builder.service.js).

Multiquímica es un tenant `sapFlavor: "S4"`. Nada de eso le sirve: su sistema no tiene
`/b1s/v2`, ni la entidad `Quotations`, ni el campo `CardCode`. Hoy puede leer de S/4
(productos, empresas, contactos, precios, stock y lotes) pero **no puede escribir un solo
documento**.

## Objetivo

Que un tenant `sapFlavor: "S4"` cree ofertas de venta en S/4HANA por el webhook
`POST /webhooks/hubspot/createQuotation`, con el mismo comportamiento observable que un
tenant B1: mismas validaciones, misma idempotencia, mismos mapeos configurables, misma
creación de cliente, mismo `SapDocumentLink`, mismo write-back a HubSpot y mismo audit
trail.

Los cuatro tenants B1 en producción (`amc`, `distelsa`, `noelito`, `printer`) no cambian ni
un byte de payload.

## Alcance

**Entra:** `createQuotation` para `sapFlavor: "S4"`.

**No entra** (mismo diseño los admite después, sin rediseñar): `updateQuotation`,
`convertQuotationToOrder`, `createDeal` (pedido directo), `inventoryTransferRequest`,
`purchaseQuotation`.

**No entra tampoco:** crear el contacto del negocio como persona en S/4. Ver
"D6 — Recorte: contactos".

## Estado verificado (2026-09-14)

### Base de datos local, tenant `sap_integration_multiquimica`

| Colección | Hallazgo |
|---|---|
| `Configurations` | `sapFlavor: "S4"`. Existen `defaultFindHubspot: "idsap"`, `s4PriceList`, `warehouseStockStrategy: {strategy: "s4_PlantStorageLocation"}`, `fieldsWareHouseHS`. **No existe `defaultFindSAP`** (el resolver cae a `'EmailAddress'`). |
| `SapCredentials` | 1 doc: `serviceLayerBaseUrl: "https://vhmldqs4ci.hec.multidomsa.com:44300"`, usuario `smarteam`, `serviceLayerCompanyDB: null`. |
| `FieldMappings` | 18 filas, **todas SAP→HubSpot**: 10 en `company/businessPartner`, 5 en `contact/contactEmployee`, 3 en `product/product`. **Cero filas en `deal/orders-quotations` y `product/orders-quotations`.** |
| `OwnerMappings` | 5 filas, **las 5 con `sapOwnerId: null`**. |
| `ClientConfigs` | 5, todas con `integrationModeId` → `S4_ODATA`. "Obtener Negocios S4" ya apunta a `/API_SALES_ORDER_SRV/A_SalesOrder`, y "Obtener Empresas S4" filtra `BusinessPartnerGrouping in ["ZC01","ZC02"]` — ese es el grupo de clientes real del sistema. |
| `SapDocumentLinks` | vacía. |

`hubspotCredentialId` del tenant: `6a68dc4203837bce4474fd32`.

Los mapeos se leen por `hubspotCredentialId + objectType + sourceContext`, **no** por
`clientConfigId` ([mapping.service.js:15](../../../src/infrastructure/database/repositories/mapping.service.js)),
así que las filas nuevas solo necesitan el `hubspotCredentialId` correcto.

### Código: qué ya existe y qué falta

Ya existe el andamiaje de bifurcación por flavor y **ya sabe escribir**:

- `normalizeSapFlavor` / `SAP_FLAVORS` ([sap-flavor.constants.js:4](../../../src/domain/sap/sap-flavor.constants.js)).
- `createSapTransport({ sapFlavor, config })` → `S4GatewayTransport` | `B1ServiceLayerTransport`,
  validado con `assertPort` ([sapTransportFactory.js:13](../../../src/infrastructure/sap/transport/sapTransportFactory.js)).
- `S4GatewayTransport.request()` hace CSRF fetch + cookie + **un reintento** cuando el
  gateway rechaza el token, para todo método no seguro
  ([S4GatewayTransport.js:127](../../../src/infrastructure/sap/transport/S4GatewayTransport.js)).
- `createSapCustomerAdapter` como patrón de factory por flavor a copiar
  ([sapCustomerAdapterFactory.js:14](../../../src/infrastructure/sap/customers/sapCustomerAdapterFactory.js)).
- `parseS4WarehouseCode("MQGT/0008")` → `{plant, storageLocation}`
  ([s4-plant-storage-location.strategy.js:20](../../../src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js)).

Falta todo lo de escritura de documentos. Y hay dos guardas que hoy **apagan** config en S/4
y que este diseño respeta:

- `getBusinessPartnerCreationConfig` devuelve los defaults y loguea
  `'businessPartnerCreation ignorada: solo aplica a SAP B1'` cuando el flavor no es B1
  ([BusinessPartnerCreationConfigRepository.js:112](../../../src/infrastructure/config/BusinessPartnerCreationConfigRepository.js)).
- `getPropertiesFlagsConfig` hace lo mismo con `propertiesFlags`
  ([BusinessPartnerCreationConfigRepository.js:169](../../../src/infrastructure/config/BusinessPartnerCreationConfigRepository.js)).

Las dos se dejan **como están**: `businessPartnerCreation` y `propertiesFlags` son forma de
B1 (colecciones anidadas, `Properties1..64`). S/4 usa llaves de configuración propias.

### Red: bloqueada al momento de escribir este spec

La ruta VPN existe (`172.23.0.0/22` vía `192.168.250.6`, interfaz `Ethernet 3`), pero
`172.23.2.28:44300` y `:8000` dan **TCP timeout**. No es un problema de usuario/clave: no hay
ni handshake. Todo lo marcado como "por verificar" abajo se escribió contra la documentación
de las APIs de SAP, no contra el sistema.

## Decisiones de diseño

### D1 — Bifurcación por puerto + factory, no por casos de uso paralelos

`ProcessHubspotCreateQuotation` ([ProcessHubspotCreateQuotation.js:65](../../../src/application/use-cases/ProcessHubspotCreateQuotation.js))
conserva **sin cambios** la idempotencia por `dealId` (línea 92), el `SapDocumentLink`
(línea 201), el audit trail y el write-back. Solo se le inyectan tres colaboradores
resueltos por flavor.

*Alternativas descartadas:*
- **Casos de uso paralelos (`ProcessS4CreateQuotation`).** Riesgo cero para B1 y más rápido
  hoy, pero duplica ~280 líneas de idempotencia, auditoría y write-back por flujo. Con los
  otros tres flujos pendientes son ~1.100 líneas duplicadas que se desincronizan.
- **Modelo de documento neutro + traductor por flavor.** El diseño más limpio a largo plazo,
  pero obliga a reescribir el builder que hoy corre en cuatro tenants de producción.

### D2 — El adapter de S/4 devuelve una respuesta con forma de B1

`updateAfterSap` lee **literalmente** `orderResponse.DocEntry` y `orderResponse.DocNum`
([HubspotWebhookAdapter.js:98](../../../src/infrastructure/hubspot/HubspotWebhookAdapter.js)),
y `buildSapDocumentLinkLines` lee `responseLines[i].LineNum`
([webhookQuotationSupport.js:448](../../../src/application/use-cases/webhookQuotationSupport.js)).

El `S4SalesDocumentAdapter` normaliza antes de devolver:

```js
{
  DocEntry: Number(SalesQuotation),     // ambos son el mismo número en S/4
  DocNum:   Number(SalesQuotation),
  DocumentLines: to_Item.map((item) => ({ LineNum: Number(item.SalesQuotationItem) })),
  raw: <respuesta cruda del gateway>,
}
```

Así el caso de uso, el repositorio de `SapDocumentLink` y el write-back a HubSpot no se
enteran del flavor. `raw` es lo que se guarda en el audit trail, para no perder evidencia.

*Alternativa descartada:* hacer `updateAfterSap` consciente del flavor. Empuja la diferencia
hacia la capa de HubSpot, que no tiene nada que ver con SAP, y obliga a tocar el write-back
que hoy usan los cuatro tenants B1.

### D3 — Área de ventas y clase de documento: mapeo del negocio, con default de configuración

S/4 exige en toda oferta `SalesQuotationType`, `SalesOrganization`, `DistributionChannel` y
`OrganizationDivision`. Se resuelven en ese orden:

1. Mapeo `deal/orders-quotations` (el asesor lo fija por negocio).
2. Default de la llave de configuración nueva `s4SalesDocument`.
3. Si sigue vacío → `PermanentWebhookError` con el nombre del campo que falta.

*Alternativa descartada:* una sola combinación fija por tenant. Multiquímica tiene 10
organizaciones de ventas y 16 combinaciones org/canal vivas en su `s4PriceList`.

*Alternativa descartada:* reusar `s4PriceList.defaultPriceListBySalesArea`. Mezcla precios
con documentos en una sola llave; un cambio de lista de precios tocaría la creación de
ofertas.

### D4 — Precio: por defecto no se manda

S/4 valoriza la oferta con sus propios registros de condición (ZPR0). Ese es exactamente el
precio que el webhook de precios de líneas ya empuja a HubSpot, así que reenviarlo sería
redundante y además **pisaría** una revaloración legítima de SAP con un número viejo de
HubSpot.

Configurable: `s4SalesDocument.priceConditionType`. Si trae un tipo de condición, cada línea
lleva `to_PricingElement: [{ ConditionType, ConditionRateValue, ConditionCurrency }]`.
Ausente (el default) = no viaja ningún precio.

### D5 — Vendedor por función de interlocutor

En S/4 el vendedor no es un campo de cabecera sino una fila de `to_Partner`. Se manda
`{ PartnerFunction: <config>, Personnel: <sapOwnerId del OwnerMapping> }`.

Misma regla de omisión que `DocumentsOwner` en B1 ([order-builder.service.js:498](../../../src/domain/orders/order-builder.service.js)):
si no se resuelve, la clave **no viaja**, nunca viaja en `null`. Con los 5 `OwnerMappings`
de Multiquímica en `sapOwnerId: null`, hoy el bloque se omitiría entero y la oferta se crea
igual, con un `warn` que es lo que hace que alguien complete el mapeo.

### D6 — Recorte: contactos

En B1 el contacto del negocio se convierte en un `ContactEmployee`, una colección **anidada**
dentro del BusinessPartner. En S/4 un contacto es otro `A_BusinessPartner` de categoría `1`
más una relación `BUR001`: un segundo deep create con su propio rango de numeración.

Esta entrega **no crea contactos en S/4**. El caso de uso recibe un `contactEmployeeResult`
vacío y `dealContactIsContactEmployee: false`, con lo cual `updateAfterSap` recibe
`syncContact: false` y no escribe `internalcode` en el contacto. Los 5 mapeos
`contact/contactEmployee` del tenant siguen sirviendo para el sync SAP→HubSpot, que no se
toca.

## Arquitectura

### Tres puertos nuevos

| Puerto | Métodos | B1 | S4 |
|---|---|---|---|
| `SapDocumentBusinessPartnerPort` | `findOrCreateForDocument({...}) → { cardCode, businessPartnerResult, contactEmployeeResult, contactEmployeeFailures, hubspotToken, dealContactIsContactEmployee }` | `B1DocumentBusinessPartnerResolver`: clase fina que **delega en el `resolveBusinessPartnerForDocument` actual sin tocar su cuerpo** ([webhookQuotationSupport.js:213](../../../src/application/use-cases/webhookQuotationSupport.js)) | `S4DocumentBusinessPartnerResolver` (nuevo) |
| `SalesDocumentBuilderPort` | `buildQuotationPayload({...}) → payload` | `buildQuotationPayload` actual ([order-builder.service.js:498](../../../src/domain/orders/order-builder.service.js)) | `buildS4QuotationPayload` (nuevo) |
| `SapSalesDocumentPort` | `createQuotation({ sapConfig, quotationPayload }) → respuesta normalizada (D2)` | `SapWebhookQuotationAdapter` actual ([SapWebhookQuotationAdapter.js:8](../../../src/infrastructure/sap/SapWebhookQuotationAdapter.js)) | `S4SalesDocumentAdapter` (nuevo) |

Los tres se validan con `assertPort` ([port-validator.js:25](../../../src/application/ports/port-validator.js)),
igual que los puertos existentes.

**El contrato de `B1DocumentBusinessPartnerResolver` es delegación pura.** No se reescribe la
lógica de B1: se envuelve. El riesgo del camino B1 es "se movió la llamada", no "se reescribió
el cuerpo".

### Archivos

Nuevos:

```
src/application/ports/sap/sap-sales-document.port.js
src/application/ports/sap/sap-document-business-partner.port.js
src/application/ports/sap/sales-document-builder.port.js
src/domain/sap/s4-odata-payload.service.js          # expansión de claves punteadas
src/domain/orders/s4-sales-document-builder.service.js
src/domain/business-partners/s4-business-partner-payload.service.js
src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js
src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js
src/infrastructure/sap/salesDocuments/sapSalesDocumentAdapterFactory.js
src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js
src/application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js
src/infrastructure/config/S4SalesDocumentConfigRepository.js
src/infrastructure/config/S4BusinessPartnerCreationConfigRepository.js
```

Modificados:

```
src/application/use-cases/ProcessHubspotCreateQuotation.js   # inyección de los 3 puertos
src/composition/webhook-processing.composition.js            # cableado por flavor
src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js  # sapFlavor + 2 configs
```

### Dónde se resuelve el flavor

El flavor sale de `Configurations.sapFlavor` vía `resolveSapFlavor`
([SapFlavorConfigRepository.js](../../../src/infrastructure/config/SapFlavorConfigRepository.js)),
dentro de `resolveRuntimeContext`
([TenantWebhookRuntimeRepository.js:27](../../../src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js)),
que ya es el único lugar que lee la configuración del tenant al arrancar el webhook. Queda
en `context.sapFlavor`, y la composición usa ese valor para pedirle a las factories el trío
correcto.

Ausente o inválido ⇒ `DEFAULT_SAP_FLAVOR` = `B1`. Los tenants actuales no tienen la llave y
siguen igual.

## Expansión de claves punteadas

`mapHubspotToSapFields` escribe **`mapped[sourceField] = value`** con el `sourceField`
literal ([order-builder.service.js:44](../../../src/domain/orders/order-builder.service.js)).
Un mapeo `to_BusinessPartnerTax.BPTaxLongNumber → cedula` produce entonces la clave **plana**
`{'to_BusinessPartnerTax.BPTaxLongNumber': '3101...'}`, que el gateway rechaza: OData espera
`{to_BusinessPartnerTax: [{BPTaxLongNumber: '3101...'}]}`.

`s4-odata-payload.service.js` expande esas claves antes del POST, con una tabla explícita de
cardinalidad — no se adivina por el nombre:

| Navegación | Cardinalidad | Forma |
|---|---|---|
| `to_BusinessPartnerAddress` | colección | `[{...}]` |
| `to_BusinessPartnerAddress.to_EmailAddress` | colección | `[{...}]` |
| `to_BusinessPartnerAddress.to_PhoneNumber` | colección | `[{...}]` |
| `to_BusinessPartnerRole` | colección | `[{...}]` |
| `to_Customer` | 1:1 | `{...}` |
| `to_Customer.to_CustomerCompany` | colección | `[{...}]` |
| `to_Customer.to_CustomerSalesArea` | colección | `[{...}]` |
| `to_Item` | colección | `[{...}]` |
| `to_Partner` | colección | `[{...}]` |
| `to_PricingElement` | colección | `[{...}]` |

Una navegación desconocida en un mapeo **no se adivina**: se descarta con un `warn` que nombra
la clave. Enviarla mal haría que el gateway rechace el POST entero, y el síntoma no apuntaría
al mapeo.

## Resolución y creación del cliente

`S4DocumentBusinessPartnerResolver.findOrCreateForDocument`:

**1. Buscar.** Campo de búsqueda = `Configurations.defaultFindSAP`, mismo mecanismo que B1
([TenantWebhookRuntimeRepository.js:280](../../../src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js);
default `'EmailAddress'`, que en S/4 no sirve — para Multiquímica hay que ponerlo en
`BusinessPartner`). El valor sale de `mapHubspotToSapFields(company, companyMappings)`.

- `defaultFindSAP: "BusinessPartner"` ⇒ `GET A_BusinessPartner('<idsap>')`, 404 ⇒ no existe.
- Cualquier otro campo ⇒ `GET A_BusinessPartner?$filter=<campo> eq '<valor>'&$top=1`.
- Fallback configurable `s4BusinessPartnerCreation.findFallbackField` (para Multiquímica:
  `to_BusinessPartnerTax.BPTaxLongNumber`, que es donde vive la cédula).

**Corrección del 2026-09-14, verificada contra el sistema:** una versión anterior de este spec
decía `to_Customer.BPTaxLongNumber`. **Ese campo no existe**: el gateway responde 404 para ese
segmento, y `A_Customer` solo ofrece `TaxNumber1..TaxNumber5`. El número largo vive en
`A_BusinessPartnerTaxNumber`, llave `BusinessPartner` + `BPTaxType`, y el camino que resuelve es
`to_BusinessPartnerTax.BPTaxLongNumber`. Es una **colección**: un socio de negocio trae una fila
por tipo de impuesto, y 72 de ellos tienen más de una, así que quedarse con la primera es una
decisión y no un detalle.

**Ojo con el tenant, aparte de esta entrega:** Multiquímica tiene hoy DOS `FieldMappings` hacia
`cedula`, y uno usa la ruta inexistente. Los mapeos con el mismo `targetField` **se pisan, no
caen en cascada**: gana el último por `_id` aunque resuelva a `null`. Conviene revisarlo con el
cliente; no es parte de este spec.

Encontrado ⇒ `cardCode = BusinessPartner`, `created: false`, `matchedBy: <campo>`.

**2. Crear** si no aparece: `POST /API_BUSINESS_PARTNER/A_BusinessPartner` con deep create.
El payload se arma como `{ ...defaults de config, ...mapeos expandidos }` — **el default
configurado gana, el mapeo llena lo que el default no cubre**, mismo orden de precedencia que
B1 ([webhookQuotationSupport.js:272](../../../src/application/use-cases/webhookQuotationSupport.js)):

```json
{
  "BusinessPartnerCategory": "2",
  "BusinessPartnerGrouping": "ZC01",
  "OrganizationBPName1": "<del mapeo BusinessPartnerFullName → name>",
  "to_BusinessPartnerRole": [{ "BusinessPartnerRole": "FLCU00" }, { "BusinessPartnerRole": "FLCU01" }],
  "to_BusinessPartnerAddress": [{
    "Country": "...", "CityName": "...",
    "to_EmailAddress": [{ "EmailAddress": "..." }],
    "to_PhoneNumber": [{ "PhoneNumber": "..." }]
  }],
  "to_Customer": {
    "CustomerAccountGroup": "ZC01",
    "to_CustomerCompany": [{ "CompanyCode": "<sociedad>", "ReconciliationAccount": "<cuenta>" }],
    "to_CustomerSalesArea": [{
      "SalesOrganization": "...", "DistributionChannel": "...", "Division": "...",
      "Currency": "...", "PriceListType": "..."
    }]
  }
}
```

`BusinessPartnerGrouping` por defecto **`ZC01`**, que es uno de los dos grupos con los que el
tenant ya filtra clientes en su ClientConfig "Obtener Empresas S4"
(`BusinessPartnerGrouping in ["ZC01","ZC02"]`). Todo lo demás sale de la config, sin valores
inventados en código.

**3. Sin nombre no se crea:** `PermanentWebhookError('BusinessPartnerFullName es requerido
para crear el cliente en S/4')`, mismo criterio que B1
([SapWebhookOrderAdapter.js:310](../../../src/infrastructure/sap/SapWebhookOrderAdapter.js)).

**4. Write-back del id.** Se reusa `resolveBusinessPartnerSyncPlan`
([webhookQuotationSupport.js:38](../../../src/application/use-cases/webhookQuotationSupport.js))
tal cual: escribe `idsap` en la empresa cuando el BP se creó, o cuando se encontró por
búsqueda y HubSpot todavía no lo tenía. `syncContact` siempre `false` (D6).

## Payload de la oferta

`POST /sap/opu/odata/sap/API_SALES_QUOTATION_SRV/A_SalesQuotation`

### Cabecera

| Campo | Origen |
|---|---|
| `SoldToParty` | el `cardCode` resuelto arriba |
| `SalesQuotationType` | mapeo `deal/orders-quotations` → default `s4SalesDocument.quotationType` |
| `SalesOrganization` | ídem → `s4SalesDocument.salesOrganization` |
| `DistributionChannel` | ídem → `s4SalesDocument.distributionChannel` |
| `OrganizationDivision` | ídem → `s4SalesDocument.division` |
| `TransactionCurrency` | mapeo; si falta, lo determina SAP |
| resto | derrame genérico de los mapeos `deal/orders-quotations`, expandido |

El derrame usa una lista de reservados **propia de S/4** — no se reusa
`RESERVED_HEADER_FIELDS` ([order-builder.service.js:98](../../../src/domain/orders/order-builder.service.js)),
que nombra campos de B1:

```
S4_RESERVED_HEADER_FIELDS = { SoldToParty, to_Item, to_Partner, to_PricingElement, SalesQuotation }
```

**Campos de usuario:** las extensiones de S/4 (`YY1_*_SDH` en cabecera, `YY1_*_SDI` en
posición) **no necesitan código**. Viajan por el derrame genérico con solo declararlas en el
FieldMapping, igual que un campo `U_` en B1.

### Posiciones (`to_Item`)

Una entrada por line item, en orden:

| Campo | Origen |
|---|---|
| `SalesQuotationItem` | `'000010'`, `'000020'`, … (`(i+1) * 10`, a 6 dígitos) |
| `Material` | `hs_sku` vía mapeos `product/product` |
| `RequestedQuantity` | `quantity`; `<= 0` ⇒ `PermanentWebhookError` (mismo criterio que [order-builder.service.js:397](../../../src/domain/orders/order-builder.service.js)) |
| `RequestedQuantityUnit` | mapeo `product/orders-quotations`; si falta, lo determina SAP |
| `Plant` | propiedad `warehouses` → `Configurations.fieldsWareHouseHS` (`value` → `valueSAP`) → `parseS4WarehouseCode` ([s4-plant-storage-location.strategy.js:20](../../../src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js)) ⇒ `plant`. Si no resuelve, la clave se omite y SAP usa el centro por defecto del material, con `warn`. |
| `to_PricingElement` | solo si `s4SalesDocument.priceConditionType` está puesta (D4) |
| resto | derrame de `product/orders-quotations`, expandido |

Reservados de línea en S/4: `{ SalesQuotationItem, Material, RequestedQuantity, to_PricingElement }`.

Sin líneas ⇒ `PermanentWebhookError`, igual que B1.

### Interlocutor

```json
"to_Partner": [{ "PartnerFunction": "VE", "Personnel": "<sapOwnerId>" }]
```

Solo si `s4SalesDocument.salesPersonPartnerFunction` está configurada **y** el `OwnerMapping`
del dueño del negocio tiene `sapOwnerId`. Si falta cualquiera de las dos, la clave no viaja
(D5).

## Persistencia y write-back

Sin cambios en el caso de uso. Con la normalización de D2:

- `SapDocumentLink`: `sapObject: 'A_SalesQuotation'`, `sapDocEntry = sapDocNum = SalesQuotation`,
  `sapBaseType: null` (el `23` es el `BaseType` de B1, no significa nada en S/4),
  `documentType: 'quotation'`, `lines[].sapLineNum = Number(SalesQuotationItem)` → `10, 20, 30`.
- Índice único `hubspotCredentialId + dealId + documentType`
  ([SapDocumentLink.js:63](../../../src/infrastructure/database/models/tenant/SapDocumentLink.js)):
  la idempotencia funciona igual.
- HubSpot: `updateAfterSap` escribe el número de oferta en las propiedades mapeadas como
  `DocEntry` / `DocNum` en `deal/orders-quotations`.

**Deuda declarada para la fase 2:** `sapLineNum` es `Number` en el modelo. La clave real de
una posición en S/4 es la cadena `'000010'`. Para crear alcanza con el número; el `PATCH` de
posiciones de `updateQuotation` va a necesitar la cadena, y ese será el momento de agregar un
campo `sapLineId: String` al esquema.

## Errores y validaciones

Mismo contrato que B1: `PermanentWebhookError` = no reintentar (el evento queda `errored` al
primer intento y `notifyWebhookFailure` deja la nota en el negocio); cualquier otro error =
reintentable.

| Situación | Resultado |
|---|---|
| Falta `SalesQuotationType` / org / canal / división tras mapeo y default | `PermanentWebhookError` nombrando el campo |
| Cliente no existe y falta el nombre de la empresa | `PermanentWebhookError` |
| Line item sin `Material`, o cantidad `<= 0` | `PermanentWebhookError` |
| Sin line items | `PermanentWebhookError` |
| `OwnerMapping` sin `sapOwnerId` | `warn`, la oferta se crea sin interlocutor |
| `warehouses` no resuelve a un centro | `warn`, la posición viaja sin `Plant` |
| Navegación desconocida en un mapeo | `warn`, la clave se descarta |
| Gateway rechaza el POST | error reintentable; el cuerpo crudo del error va al audit trail |

Todo el tráfico queda en `sapCalls` por el `sapCallRecorder` que ya envuelve los adapters
([ProcessHubspotCreateQuotation.js:74](../../../src/application/use-cases/ProcessHubspotCreateQuotation.js)):
el `S4SalesDocumentAdapter` se envuelve igual y no necesita instrumentación propia.

## Configuración nueva

Se entrega como JSON pegable en Compass (`$oid`/`$date`, sin `ISODate()`).

### `Configurations`

```jsonc
// s4SalesDocument
{
  "key": "s4SalesDocument",
  "value": {
    "quotationType": "<clase de oferta>",
    "salesOrganization": "<org por defecto>",
    "distributionChannel": "<canal por defecto>",
    "division": "<división por defecto>",
    "salesPersonPartnerFunction": "VE",
    "priceConditionType": null
  }
}

// s4BusinessPartnerCreation
{
  "key": "s4BusinessPartnerCreation",
  "value": {
    "findFallbackField": "to_BusinessPartnerTax.BPTaxLongNumber",
    "defaults": {
      "BusinessPartner": { "BusinessPartnerCategory": "2", "BusinessPartnerGrouping": "ZC01" },
      "BusinessPartnerRole": ["FLCU00", "FLCU01"],
      "Customer": { "CustomerAccountGroup": "ZC01" },
      "CustomerCompany": { "CompanyCode": "<sociedad>", "ReconciliationAccount": "<cuenta>" },
      "CustomerSalesArea": { "Currency": "<moneda>", "PriceListType": "ZC" }
    }
  }
}

// defaultFindSAP  (no existe hoy; sin esto el resolver usa 'EmailAddress', que en S/4 no sirve)
{ "key": "defaultFindSAP", "value": "BusinessPartner" }
```

Los valores entre `<>` los tiene que dar el equipo funcional de Multiquímica: sociedad,
cuenta de reconciliación, moneda, y la clase de oferta sin documento de referencia
obligatorio. **Ojo:** de las 10 clases de pedido del sistema, ZPLD/ZPLP/ZPQD exigen documento
de referencia y ZPVD/ZPSD dan "documento incompleto", según la investigación de precios del
2026-08-18. La clase de **oferta** hay que confirmarla aparte.

### `FieldMappings` (contexto `orders-quotations`, hoy inexistente)

Todas con `hubspotCredentialId: {"$oid": "6a68dc4203837bce4474fd32"}`, `isActive: true`,
`editable: true`, `includeInServiceLayerSelect: false` (esa bandera solo filtra el `$select`
del camino SAP→HubSpot; nunca toca el camino HubSpot→SAP).

Mínimo para la primera prueba:

| `objectType` | `sourceContext` | `sourceField` | `targetField` |
|---|---|---|---|
| `deal` | `orders-quotations` | `DocEntry` | `<propiedad para el nº de oferta>` |
| `deal` | `orders-quotations` | `DocNum` | `<propiedad para el nº de oferta>` |
| `deal` | `orders-quotations` | `SalesOrganization` | `<propiedad>` |
| `deal` | `orders-quotations` | `DistributionChannel` | `<propiedad>` |
| `product` | `orders-quotations` | `RequestedQuantityUnit` | `unidad_de_medida` |

Sin la fila `DocNum` el número de la oferta **no se escribe de vuelta en HubSpot** y la única
traza queda en `SapDocumentLinks`.

## Plan de pruebas

### Tarea 0 — Verificación en vivo (bloquea todo lo demás)

Script en el scratchpad, credenciales leídas del Mongo local, que responda:

1. ¿`API_SALES_QUOTATION_SRV` está activado? (`GET .../$metadata`; si 403, buscar el nombre
   real en el catálogo `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection` — en este
   sistema las activaciones se registran con `ID` prefijado `Z` y el `Title` trae el nombre
   estándar).
2. ¿El deep create con `to_Item` pasa? POST mínimo con un cliente y un material reales.
3. ¿El deep create de `A_BusinessPartner` con `to_Customer` está permitido, o lo bloquea MDG
   o el rango de numeración?
4. ¿Cómo se llama la función de interlocutor del vendedor y qué campo lleva el id
   (`Personnel`)? Leer `to_Partner` de una oferta existente.
5. Los nombres exactos de campo de cabecera y posición contra `$metadata`.

**El spec asume las respuestas 1–5.** Cualquier desvío se corrige aquí antes de escribir
código, no después.

### Unitarias

- `s4-odata-payload.service`: expansión de claves punteadas, colección vs 1:1, navegación
  desconocida descartada con warn.
- `s4-sales-document-builder`: precedencia mapeo → default → error; reservados no pisados por
  el derrame; `SalesQuotationItem` correlativo; `Plant` desde `fieldsWareHouseHS`;
  `to_Partner` omitido sin `sapOwnerId`; `to_PricingElement` ausente por defecto.
- `S4SalesDocumentAdapter`: normalización a forma B1 (D2) con transport falso.
- `S4DocumentBusinessPartnerResolver`: encontrado por campo primario, por fallback, creado, y
  error sin nombre.
- `sapSalesDocumentAdapterFactory`: `S4` ⇒ adapter S/4; ausente/inválido/`B1` ⇒ adapter B1.
- **Regresión B1:** el payload de `buildQuotationPayload` para un tenant B1 no cambia, y
  `B1DocumentBusinessPartnerResolver` llama a `resolveBusinessPartnerForDocument` con los
  mismos argumentos que hoy.

Correr con `node --experimental-vm-modules node_modules/jest/bin/jest.js`; el baseline son
178 suites con 5 rojas preexistentes.

### Prueba manual

`POST /sap-sync/run` con solo la config a probar activa, y el webhook
`POST /webhooks/hubspot/createQuotation` con `x-tenant-id` (no el `portalId`).

## Riesgos

1. **Sin red no hay Tarea 0.** El código escrito antes de verificar está construido sobre
   documentación de SAP, no sobre este sistema. Los nombres de campo son la parte más frágil.
2. **El deep create de cliente puede estar bloqueado.** Si MDG gobierna el maestro de clientes,
   o si el rango de numeración es externo, el `POST A_BusinessPartner` va a rebotar. Plan B:
   degradar a "solo resolver, fallar si no existe" — un cambio de una línea en el resolver, no
   un rediseño.
3. **La clase de oferta puede exigir documento de referencia**, igual que ZPLD/ZPLP/ZPQD en
   pedidos. Lo resuelve el equipo funcional, no el código.
4. **Sin `OwnerMappings.sapOwnerId` no hay vendedor en la oferta.** Se crea igual, pero el
   documento queda sin asignar en SAP.
