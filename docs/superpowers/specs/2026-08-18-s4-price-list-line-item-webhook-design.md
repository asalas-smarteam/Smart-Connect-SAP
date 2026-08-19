# Webhook de listas de precios de line items para SAP S/4HANA

Fecha: 2026-08-18

## Problema

El flujo de precios de line items existe solo para SAP Business One. Un tenant S/4 —
Multiquímica— sincroniza productos sin precio (sus tres mapeos de `product` son
`Product→hs_sku`, `to_Description.ProductDescription→name` y `BaseUnit→unidad_de_medida`:
ninguno trae precio), así que el producto nace en HubSpot en cero y nada lo valoriza cuando
se agrega a un negocio.

En B1 eso lo resuelve el webhook de precios, con dos strategies que conviven según la config
`lineItemPriceStrategy` ([line-item-price-strategy.constants.js:3](../../../src/domain/prices/line-item-price-strategy.constants.js)):

- **businessPartner** ([SyncLineItemPrices.js:187](../../../src/application/use-cases/SyncLineItemPrices.js)):
  `POST /b1s/v2/CompanyService_GetItemPrice` con `{ItemCode, CardCode, Date}` y SAP resuelve
  todo. Sin `cardCode` cae a `GET /b1s/v2/Items('X')?$select=ItemPrices` y elige la fila cuyo
  `PriceList` coincide con el default de la config.
- **dealPriceList** ([SyncDealLineItemPricesByPriceList.js:139](../../../src/application/use-cases/SyncDealLineItemPricesByPriceList.js)):
  lista efectiva = line item → deal → default, y si la lista pedida no tiene precio en la
  moneda del negocio reintenta con la default.

Ninguna de las dos sirve tal cual en S/4: el cliente HTTP es B1 puro
([SapLineItemPriceClient.js:11](../../../src/infrastructure/external-services/SapLineItemPriceClient.js),
rutas `/b1s/v2/...`), y en S/4 no existe ni `CompanyService_GetItemPrice` ni la colección
`ItemPrices` de un material.

## Objetivo

Un webhook propio para S/4 que, al agregarse o cambiar líneas en un negocio, escriba en cada
line item el precio que corresponde a **la lista de precios del cliente**, con caída a un
default configurable y luego al precio por defecto del producto. El flujo B1 no se toca.

## Evidencia verificada en vivo (2026-08-18)

Consultado con curl/axios contra el S/4 de dev/QA de Multiquímica
(`https://vhmldqs4ci.hec.multidomsa.com:44300`, credenciales del tenant en `SapCredentials`).

**Servicios activos y con datos:**

| Servicio | Entidad | Rol |
|---|---|---|
| `API_BUSINESS_PARTNER` | `A_CustomerSalesArea` | lista de precios del cliente (`PriceListType`) |
| `API_SLSPRICINGCONDITIONRECORD_SRV` | `A_SlsPrcgCndnRecdValidity` | filtrado por tipo/material/área/vigencia |
| " | `A_SlsPrcgConditionRecord` | tarifa (`ConditionRateValue`, moneda, UoM, tabla) |
| " | `to_SlsPrcgCndnRecordScale` | escalas por cantidad (vacío en los datos revisados) |
| `API_PRODUCT_SRV` | `A_Product` | `BaseUnit` |

**El modelo de datos calza con la regla del negocio.** La condición de precio en uso es
**ZPR0** (745 de 1.000 registros muestreados; el resto es `MWST` de impuesto y `ZFE1`), y sus
registros viven en tablas de condición distintas:

- **tabla 502** = OrgVentas + CanalDistribución + `PriceListType` + Material → precio por lista.
- **tablas 501 y 504** = OrgVentas + CanalDistribución + Material, sin lista → precio por
  defecto del producto.

**Las listas son ZA / ZB / ZC / ZD**, todas vivas por igual: 3.531 / 3.222 / 3.218 / 3.173
registros vigentes hoy. `ZV` aparece en registros de condición (350 vigentes) pero **en
ningún cliente**, así que no es una lista general utilizable como default implícito.

Sobre 5.000 áreas de venta de clientes: ZD 2.564, ZC 1.587, ZB 416, ZA 393 y **40 sin lista**
— el caso "usa el default" existe de verdad en los datos.

**Cuatro hallazgos que condicionan el diseño:**

1. **La simulación de pedido está bloqueada por customizing.**
   `POST API_SALES_ORDER_SIMULATION_SRV/A_SalesOrderSimulation` es el equivalente exacto de
   `CompanyService_GetItemPrice` y funciona: devolvió `201` y resolvió solo
   `"PriceListType":"ZC"` para el cliente `104479` sin que se lo mandáramos. Pero de las 10
   clases de pedido del sistema, ZPLD/ZPLP/ZPQD exigen documento de referencia ("Debe usar un
   documento de referencia"), ZPVD/ZPSD responden "Documento incompleto", y la única que pasó
   (ZCTD) valoriza en `NetAmount: 0.00` porque su categoría de posición no lleva precio. En la
   organización FQCR ni ZCTD está permitida. Tampoco acepta `$expand` en el POST.
2. **Moneda:** la tarifa viene en la moneda de la condición (USD en 2.752 de 3.000 registros
   muestreados, DOP en 248) y los clientes facturan en DOP (2.982), USD (1.540), CRC (241),
   GTQ (235) y EUR (2). **No hay ninguna API de tipos de cambio activada** en el catálogo.
3. **Unidad:** `ConditionQuantityUnit` coincidió con el `BaseUnit` del producto en 12 de 12
   registros vigentes revisados, así que no hace falta convertir unidades. Pero
   `ConditionQuantity` **no siempre es 1**: hay tarifas de `2700.0000 USD / 1000 KG`.
4. **`$filter=PriceListType eq ''` no funciona.** El registro `0000418745` (sin lista, vigente
   hoy, tabla 504) aparece filtrando por material y desaparece filtrando por lista vacía. El
   default de producto se detecta leyendo la tabla del registro, no filtrando por vacío.

Además: **no existe ningún ZPR0 con `SoldToParty`** (filtro `SoldToParty ne ''` devolvió
vacío), o sea que no hay precios negociados por cliente que debamos considerar.

## Decisiones tomadas

| Decisión | Elección | Motivo | Alternativa descartada |
|---|---|---|---|
| Fuente del precio | Leer registros de condición ZPR0 | Implementable hoy sin depender de SAP | La simulación de pedido: bloqueada por customizing (hallazgo 1). Pedir una clase de pedido nueva bloquea el desarrollo contra el equipo funcional del cliente |
| Área de ventas | Derivar del cliente; si tiene varias, la configurada | El mismo cliente tiene lista distinta por organización (100053 = ZD en CPDO, ZB en DPDO), y hay 10 organizaciones de ventas y varios canales de distribución | Fijarla siempre en config (ignora al cliente); propiedad nueva en HubSpot (hoy no existe ninguna de organización de ventas y obliga a mapeos y propiedades nuevas) |
| Moneda | Escribir precio y moneda tal cual, sin convertir | No hay API de tipos de cambio; un tipo de cambio propio se desincroniza del de SAP y genera diferencias contra la factura | Saltar la línea si la moneda no coincide (deja líneas sin precio); tabla de tipos de cambio en config |
| Cadena de fallback | cliente → default de config → default de producto | Cubre a los 40 clientes sin lista y a los materiales que solo tienen tarifa como default de producto | Solo cliente → default de producto (pierde la palanca de config); solo cliente → default de config (deja sin precio materiales de tablas 501/504) |
| Superficie | Ruta nueva con adapter y caso de uso propios | B1 está funcional y no se toca | Reusar la ruta actual y decidir por `sapFlavor` dentro del adapter existente |

## Arquitectura

Ruta nueva registrada junto a la actual en
[lineItemPrice.routes.js:5](../../../src/interfaces/http/routes/lineItemPrice.routes.js):

```
POST /webhooks/hubspot/line-items/prices/s4
   → tenantResolver (middleware existente)
   → createLineItemPriceController({ webhookPayload: s4Adapter, syncLineItemPrices: useCaseS4 })
   → S4PriceListLineItemPriceWebhookService.preparePayload   (dedupe + debounce + audit)
   → SyncS4LineItemPricesByPriceList.execute                 (resolución + escritura)
```

El controlador **se reusa**: `createLineItemPriceController` ya es factory
([lineItemPrice.controller.js:11](../../../src/interfaces/http/controllers/lineItemPrice.controller.js))
y recibe sus dependencias por parámetro
([line-item-prices.composition.js:39](../../../src/composition/line-item-prices.composition.js)),
así que el manejo de duplicados, el registro en `LineItemPriceWebhookEvents` y la auditoría
se heredan sin duplicar código.

La ruta nueva **no pasa por el factory de strategies**
([line-item-price-strategy.factory.js:9](../../../src/domain/prices/line-item-price-strategy.factory.js)):
lleva su propio payload adapter y su propio caso de uso, así que ni el factory, ni
`LINE_ITEM_PRICE_STRATEGIES`, ni el `LineItemPriceWebhookPayloadAdapter`
([LineItemPriceWebhookPayloadAdapter.js:20](../../../src/infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js))
se modifican. El factory existe para elegir entre las dos strategies B1 **sobre la misma ruta**,
según la config `lineItemPriceStrategy`; acá la ruta ya identifica el flujo y meter una tercera
entrada solo agregaría una config que el tenant S/4 tendría que mantener sin que decida nada.
Consecuencia buscada: el tenant S/4 no necesita documento `lineItemPriceStrategy`.

Disparadores: los mismos que la strategy `dealPriceList`
([dealPriceListLineItemPriceWebhook.service.js:22](../../../src/infrastructure/webhook/dealPriceListLineItemPriceWebhook.service.js)) —
`deal.associationChange` con `associationType: DEAL_TO_LINE_ITEM` y `changeSource: USER`, más
property-change con `changeSource: CRM_UI` y el debounce
`requireSkippedInWebhooksInPropertyChange`.

Transporte: `S4GatewayTransport`
([S4GatewayTransport.js:52](../../../src/infrastructure/sap/transport/S4GatewayTransport.js)) vía
`createSapTransport`
([sapTransportFactory.js:13](../../../src/infrastructure/sap/transport/sapTransportFactory.js)),
que ya hace basic auth, `$format=json` implícito y normalización OData v2.

> **Cuidado con las fechas.** El transporte normaliza `/Date(1769126400000)/` a ISO antes de
> devolver los datos ([odataV2Normalizer.js:18](../../../src/infrastructure/sap/transport/odataV2Normalizer.js)).
> Todo lo que consuma `ConditionValidityStartDate`/`EndDate` recibe **ISO**, no `/Date(...)/`, y
> las fixtures deben imitar la salida del transporte, no la del sistema remoto. Para construir
> el literal del filtro se reusa `toODataV2DateTime`
> ([s4ODataQueryBuilder.js:38](../../../src/infrastructure/sap/s4ODataQueryBuilder.js)).

## Resolución del precio

```
1. deal → asociaciones companies/contacts/line_items
2. customer = idsap de la company asociada (fallback: contacto),
   mismo mecanismo que resolveCardCode de B1 (lineItemPriceWebhook.service.js:464)
3. área de ventas: GET A_CustomerSalesArea?$filter=Customer eq '<customer>'
      1 resultado  → esa
      N resultados → la del tenant configurada; si no está entre las del cliente → error fatal
4. lista = PriceListType del área elegida; si viene vacío → defaultPriceListType de config
5. por cada line item (hs_sku = Material), con caché por material:
      a. tabla 502 con PriceListType = lista del cliente
      b. tabla 502 con PriceListType = defaultPriceListType
      c. tabla 501 o 504, sin PriceListType (default del producto)
      d. nada → línea sin precio, a skippedLineItems con el motivo
6. precio unitario = ConditionRateValue / ConditionQuantity, en ConditionCurrency
7. HubSpot: precio del line item, moneda usada, lista usada, y amount del deal
```

El orden a→b→c se evalúa **sobre los candidatos ya traídos**, no con una llamada por nivel: la
consulta de vigencia devuelve en una sola respuesta las cuatro listas y los registros sin
lista del material (por el hallazgo 4, filtrar por lista vacía no es posible, así que de todas
formas hay que traerlos todos y clasificar por tabla).

## Esquema de llamadas: 1 por deal + 2 por material

```
GET /API_BUSINESS_PARTNER/A_CustomerSalesArea
    ?$filter=Customer eq '105049'
    &$select=Customer,SalesOrganization,DistributionChannel,Division,PriceListType,Currency
→ {"PriceListType":"ZC","Currency":"CRC","SalesOrganization":"FQCR","DistributionChannel":"01"}
```

```
GET /API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity
    ?$filter=ConditionType eq 'ZPR0' and Material eq '80000017'
             and SalesOrganization eq 'FQCR' and DistributionChannel eq '01'
             and ConditionValidityStartDate le datetime'2026-08-18T00:00:00'
             and ConditionValidityEndDate   ge datetime'2026-08-18T00:00:00'
    &$select=ConditionRecord,PriceListType,SalesOrganization,DistributionChannel
→ 0000418606 ZA | 0000418607 ZB | 0000418608 ZC
```

El filtro por `SalesOrganization`/`DistributionChannel` está verificado: excluye correctamente
el registro `0000418745`, que es de FQCR/**02**.

```
GET /API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord
    ?$filter=ConditionRecord eq '0000418608' or ConditionRecord eq '0000418745'
    &$select=ConditionRecord,ConditionTable,ConditionRateValue,ConditionCurrency,
             ConditionQuantity,ConditionQuantityUnit,ConditionIsDeleted
→ 0000418608: tabla 502, 1.2800 USD / 1 KG, ConditionIsDeleted=false
→ 0000418745: tabla 504, 1.2500 USD / 1 KG, ConditionIsDeleted=false
```

Los `ConditionIsDeleted: true` se descartan: el registro `0000177449` está vigente por fechas
y borrado, y sin ese filtro ganaría el nivel de default de producto con 2.10 USD.

La caché es por `Material` dentro de la invocación, igual que la de `resolveSapPricing`
([SyncLineItemPrices.js:200](../../../src/application/use-cases/SyncLineItemPrices.js)), y por el
mismo motivo: cliente y fecha son fijos durante la invocación, así que dos líneas del mismo
producto comparten resultado.

## Componentes nuevos

### 1. `S4PriceListLineItemPriceWebhookService` — infraestructura de webhook

`src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js`. Sigue la estructura de
la strategy `dealPriceList`: `classifyEvent`, dedupe por
`buildDuplicateFilter` ([lineItemPriceWebhook.shared.js:27](../../../src/infrastructure/webhook/lineItemPriceWebhook.shared.js)),
debounce, `markAsSent` / `markAsError`. Construye el payload con el lector tolerante
`readLineItems` ([lineItemPriceWebhook.shared.js:84](../../../src/infrastructure/webhook/lineItemPriceWebhook.shared.js)),
que ya devuelve `{ lineItems, failures }` sin que una línea ilegible tumbe al resto.

**Una divergencia deliberada:** cuando descarta un evento por duplicado o por debounce, el
flujo B1 inserta un documento marca con el mismo `payload`. El esquema tiene un índice **único**
sobre `(payload.eventId, payload.subscriptionId, payload.portalId, payload.appId,
payload.occurredAt, payload.fromObjectId)` con un `partialFilterExpression` que exige las seis
claves ([LineItemPriceWebhookEvent.js:41](../../../src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js)),
y los eventos de asociación las traen todas: ese insert choca con E11000 y la excepción
reemplaza al skip. El flujo S/4 loguea y saltea sin insertar. No cambia nada funcional — la
ventana de debounce solo cuenta documentos con `errorMessage: null` — y evita el error.

El documento del evento se crea **antes** de leer HubSpot, no después, para que un fallo de
lectura (deal sin cliente SAP, líneas ilegibles) quede asentado en el evento con su mensaje y no
solo en el `SyncLog` de la corrida.

### 2. `S4PriceListClient` — cliente OData

`src/infrastructure/sap/S4PriceListClient.js`, sobre `createSapTransport`. Tres métodos:

- `fetchCustomerSalesAreas({ sapConfig, customer })`
- `fetchConditionRecordCandidates({ sapConfig, conditionType, material, salesArea, date })`
- `fetchConditionRecords({ sapConfig, conditionRecords })` — una llamada con `or`

No se toca `SapLineItemPriceClient`: es B1 y sigue sirviendo a las dos strategies actuales.

### 3. `resolveS4PriceForMaterial` — dominio, función pura

`src/domain/prices/s4-price-resolution.service.js`. Recibe los candidatos ya normalizados y la
lista efectiva; devuelve `{ price, currency, priceListType, source, conditionRecord }` o `null`.
Acá viven las reglas verificadas: descartar borrados, clasificar por `ConditionTable`, el orden
a→b→c y la división por `ConditionQuantity`. Pura y testeable sin red.

### 4. `SyncS4LineItemPricesByPriceList` — caso de uso

`src/application/use-cases/SyncS4LineItemPricesByPriceList.js`. Orquesta el flujo de arriba y
escribe en HubSpot con el cliente existente `HubspotLineItemPriceClient`: `updateLineItems` y
`updateDealAmount`, tal como los usa
[SyncDealLineItemPricesByPriceList.js:224](../../../src/application/use-cases/SyncDealLineItemPricesByPriceList.js).

**No** llama a `updateProducts`: ese método solo escribe las propiedades de stock por bodega
(su `buildHubspotProductBatchPayload` arma `properties` únicamente con
`warehouseStockProperties`), que en este tenant ya las mantiene el sync de productos con la
strategy `s4_PlantStorageLocation`. El precio del producto en HubSpot no se toca; el que se
carga es el de la línea, que es lo que valoriza el negocio.

El audit se construye con `buildLineItemPriceAudit`
([syncLog.service.js:289](../../../src/infrastructure/sync/syncLog.service.js)) y no a mano:
las entradas de tráfico OData llevan claves `$filter`/`$select`, y ese builder es el que las
pasa por `sanitizeAuditKeys`, que las renombra a `_$filter`/`_$select`. Sin eso el `$set` del
`WebhookEvent` se cae completo contra el Mongo de producción (< 5.0), arrastrando también el
`errorMessage` que viaja en la misma escritura.

### 5. Config del tenant

`resolveS4PriceListConfig` en
[TenantLineItemPriceConfigRepository.js:80](../../../src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js),
al lado de `resolveTenantPriceList`. Documento nuevo en `Configurations` — hoy el tenant
`sap_integration_multiquimica` no tiene ninguna config de precios:

```json
{ "key": "s4PriceList", "value": {
    "conditionType": "ZPR0",
    "defaultPriceListType": "ZC",
    "salesArea": { "salesOrganization": "FQCR", "distributionChannel": "01", "division": "SC" },
    "priceListProperty": "lista_de_precios_sap",
    "currencyProperty": "moneda_precio_sap"
}}
```

`conditionType` es configurable a propósito: ZPR0 es de Multiquímica, no del estándar.

### 6. Wiring

`src/composition/s4-line-item-prices.composition.js`, más el registro de la ruta en
[routes/index.js:23](../../../src/interfaces/http/routes/index.js). El `createSapCallRecorder`
existente ([line-item-prices.composition.js:5](../../../src/composition/line-item-prices.composition.js))
se pasa igual que en B1 para que todo el tráfico S/4 quede en el audit del evento.

## Errores

Una línea sin tarifa **no tumba el deal**: se acumula en `skippedLineItems` con material, lista
intentada, área de ventas y motivo, igual que hoy
([SyncDealLineItemPricesByPriceList.js:185](../../../src/application/use-cases/SyncDealLineItemPricesByPriceList.js)),
y el deal se actualiza con las líneas que sí se resolvieron. Son fatales solo tres casos:

- el deal no tiene company ni contacto con `idsap` (no hay cliente que valorizar),
- el cliente no tiene áreas de venta en S/4,
- el área configurada no pertenece al cliente (config equivocada, no dato faltante).

Cuando **ninguna** línea se resuelve, el evento falla, para que HubSpot reintente en vez de
marcarlo como bueno sin haber escrito nada.

## Pruebas

Fixtures **capturadas de las respuestas reales de hoy y pasadas por el normalizador del
transporte** (fechas en ISO), no escritas a mano.

Unitarias de `resolveS4PriceForMaterial`:

- lista del cliente encontrada en tabla 502 (caso ZC/80000017 → 1.28 USD/KG),
- lista del cliente sin registro → cae al `defaultPriceListType`,
- ninguna lista con registro → cae a tabla 501/504,
- `ConditionQuantity: 1000` → 2700 USD/1000 KG da 2.70 por KG,
- `ConditionIsDeleted: true` descartado aunque esté vigente por fechas,
- sin candidatos → `null`.

Unitarias del caso de uso: cliente con `PriceListType` vacío; cliente con una sola área;
cliente con varias áreas y config válida; cliente con varias áreas y config que no le
pertenece (fatal); moneda de condición distinta a la del negocio (se escribe tal cual);
una línea sin precio y otra con precio en el mismo deal.

Unitarias del cliente OData: que el filtro se arme con `toODataV2DateTime` y con el área de
ventas incluida, y que `fetchConditionRecords` agrupe los `ConditionRecord` en una sola
llamada.

Test de composición que verifique el wiring real de la ruta nueva — no `expect.any(Object)`,
sino que la dependencia esperada esté efectivamente pasada.

## Fuera de alcance

- Escalas por cantidad (`to_SlsPrcgCndnRecordScale`): vacío en todos los registros revisados.
- Descuentos y condiciones distintas de la de precio (`ZFE1`, `MWST`).
- Conversión de moneda y de unidad de medida.
- Precios negociados por cliente: no existen registros ZPR0 con `SoldToParty`.
- El flujo B1, que queda intacto.
