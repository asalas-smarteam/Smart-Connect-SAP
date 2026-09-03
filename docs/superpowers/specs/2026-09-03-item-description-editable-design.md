# ItemDescription editable desde el line item de HubSpot

Fecha: 2026-09-03
Relacionado: `docs/superpowers/specs/2026-08-20-fieldmapping-only-header-fields-design.md`

## Lo que pidió el tenant

Poder editar la descripción de una línea del documento de SAP (`DocumentLines[].ItemDescription`)
desde el elemento de pedido de HubSpot. Si la propiedad viene, viaja; si no viene, no se manda.
Aplica sólo a los flujos de documento de venta sobre B1 Service Layer (`/Orders`, `/Quotations`,
PATCH `/Quotations(DocEntry)`). **No** aplica a inventory transfer.

## El mecanismo ya existía: `product` / `orders-quotations`

No hace falta un `sourceContext` nuevo. Ese contexto **ya es** "propiedad del line item de HubSpot
-> campo de `DocumentLines[]` de SAP", y `mapDocumentLines` (`order-builder.service.js`) lo derrama
en cada línea desde que existe. Un contexto `DocumentLines` aparte habría sido una segunda lista
para el mismo propósito, con precedencia ambigua frente a la que ya está en producción.

Las tres condiciones del pedido las cumple el contexto tal como está:

| Condición | Quién la garantiza |
|---|---|
| Sólo en `DocumentLines`, nunca en la cabecera | `product`/`orders-quotations` sólo lo lee `mapDocumentLines` / `buildQuotationLineUpdates`. La cabecera sale de `deal`/`orders-quotations`. |
| Si existe se manda, si no no | `mapHubspotToSapFields` no produce clave para una propiedad ausente, vacía, de puros espacios, o con el texto `"null"`/`"undefined"` |
| Inventory transfer no lo recibe | `mapStockTransferLines` lee `product`/`inventory-transfer-request`, otra lista. Y `buildInventoryTransferRequestPayload` además borra `DocumentLines` del payload por si acaso. |
| Sólo B1 | Los tres adapters (`SapWebhookOrderAdapter`, `SapWebhookQuotationAdapter`) van por `sapServiceLayerWebhookRequest`. No hay camino S/4 que cree documentos desde HubSpot. |

`ItemDescription` no está en `RESERVED_LINE_FIELDS`, así que el derrame lo deja pasar sin cambios.

## El hueco real: el PATCH de `/updateQuotation`

`buildQuotationLineUpdates` **nunca recibía `lineMappings`**. Emitía exactamente
`LineNum`, `UnitPrice`, `Quantity`, `DiscountPercent`, `WarehouseCode` y `TaxCode`, y nada más.

Consecuencia antes de este cambio: un campo de línea mapeado (`ItemDescription`, `U_TEXTO_LIBRE`,
cualquiera) viajaba **sólo al crear** el documento. Si el usuario lo corregía después en HubSpot, el
evento `updateQuotation` se procesaba con éxito y el valor nuevo no aterrizaba en SAP — sin error,
sin warning, sin nada que apuntara a la causa.

Eso es lo único que se tocó:

1. `buildQuotationLineUpdates` acepta `lineMappings = []` y derrama
   `pickMappedLineFields(mapHubspotToSapFields(lineItem, lineMappings, { logger }))` en cada línea.
2. `pickMappedLineFields` pasa a estar exportada (antes era privada del módulo).
3. `ProcessHubspotUpdateQuotation` le pasa `mappings.productOrdersQuotationsMappings`, la misma
   lista que ya usaba `mapDocumentLines` al crear.

El derrame se filtra por `RESERVED_LINE_FIELDS`, igual que en la creación: un mapeo no puede pisar
el `LineNum` que identifica la línea a actualizar, ni el `ItemCode`/`Quantity`/`UnitPrice` que el
builder resuelve con su propia coerción, ni `BaseType`/`BaseEntry`/`BaseLine`.

### Riesgo a auditar antes de prender `updateQuotation` en un tenant nuevo

Es el mismo riesgo que `IMMUTABLE_ON_PATCH_FIELDS` documenta para la cabecera, ahora también en la
línea: Service Layer rechaza el **PATCH completo** si una línea trae un campo que SAP no admite
cambiar en un documento ya creado. El síntoma se ve como sincronización de líneas rota, no como
problema de mapeo. `RESERVED_LINE_FIELDS` cubre lo que el builder posee, pero **no es la lista
completa** de campos inmutables de SAP. Antes de habilitar este flujo en un tenant, revisar sus
filas `product`/`orders-quotations`.

Hoy el riesgo es acotado: el flujo `updateQuotation` no está en uso en los tenants medidos, y
`ItemDescription` sí es modificable en una línea existente.

## Los cinco eventos, uno por uno

| eventType | Documento | ¿Lleva `ItemDescription`? |
|---|---|---|
| `createDeal` | POST `/Orders` | Sí, por `mapDocumentLines`. Ya funcionaba. |
| `createQuotation` | POST `/Quotations` | Sí, por `mapDocumentLines`. Ya funcionaba. |
| `updateQuotation` | PATCH `/Quotations(DocEntry)` | Sí, **nuevo en esta rama**. |
| `convertQuotationToOrder` | POST `/Orders` desde la oferta | No, y es correcto. Ver abajo. |
| `inventoryTransferRequest` | POST `/InventoryGenExits` (OWTQ) | No, por diseño del documento. |

`convertQuotationToOrder` manda líneas de puro linaje
(`BaseType: 23` / `BaseEntry` / `BaseLine`, ver `buildOrderFromQuotationPayload`): SAP copia
`ItemDescription` — y todo lo demás de la línea — de la oferta base. Meter el campo ahí sería pisar
con el valor que HubSpot tenga en ese instante lo que la oferta ya tiene aprobado en SAP. Si el
tenant necesita corregir la descripción antes de convertir, el camino es `updateQuotation` sobre la
oferta y después convertir.

## Puesta en marcha por tenant

### 1. Propiedad en HubSpot

Crear en el objeto **line item** (elemento de pedido) una propiedad de texto:

- Nombre interno: `item_description`
- Tipo: texto de una línea (o multilínea si el tenant necesita saltos)

El workflow que arma el payload del webhook tiene que incluirla en cada entrada de `line_items`.
Los line items llegan tal como el workflow los manda — la integración no hace un fetch aparte de
propiedades de line item —, así que si el workflow no la incluye, la propiedad no existe para SAP.

### 2. Fila en `FieldMappings` del tenant

```json
{
  "sourceField": "ItemDescription",
  "targetField": "item_description",
  "objectType": "product",
  "sourceContext": "orders-quotations",
  "clientConfigId": { "$oid": "<ClientConfig de product del tenant>" },
  "hubspotCredentialId": { "$oid": "<HubspotCredentials del tenant>" },
  "isActive": true,
  "editable": true,
  "includeInServiceLayerSelect": false,
  "__v": 0
}
```

`includeInServiceLayerSelect: false` es obligatorio: `ItemDescription` no es un campo de `Items` de
SAP, así que meterlo en el `$select` del sync SAP -> HubSpot de productos rompería esa consulta.
(El contexto `orders-quotations` no alimenta ese `$select` hoy, pero la bandera lo deja explícito.)

El índice único de `FieldMapping` es
`{ hubspotCredentialId, objectType, sourceContext, sourceField }`, así que esta fila convive sin
choque con el `ItemCode`/`Quantity`/`UnitPrice` del contexto `product`.

## Cobertura

`tests/unit/domain/quotationBuilder.test.js`
- derrama los campos de `lineMappings` en la línea del PATCH
- omite el campo cuando el line item no trae valor (ausente y en blanco)
- descarta el texto `"null"` y avisa por el logger
- `lineMappings` no pisa `LineNum` ni los campos que el builder posee

`tests/unit/application/processQuotationFlows.test.js`
- create: `ItemDescription` va en `DocumentLines`, y **no** en la cabecera
- create: se omite cuando el line item no trae la propiedad
- update: `ItemDescription` va en las líneas del PATCH, y **no** en la cabecera
- update: se omite cuando el evento no trae la propiedad
