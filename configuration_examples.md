
Detalle: 
Cuando un cliente quiere que sus errores se muestren en hubspot y si requiere que se retorne a otra etapa 
{ key: 'requireMessageHS', value: { requireMessageHS: false, requiereReturnStage: false, stageToReturned: null } }

Detalle: bypassSapErrors
Qué errores de SAP se indultan en vez de tumbar el documento. Por default NINGUNO: si SAP rechaza un ContactEmployee (p.ej. `Value too long in property 'Title'` porque el jobtitle de HubSpot pasa el largo de `OCPR.Title`), el webhook falla como permanente ANTES de crear la orden/oferta/traslado, el evento queda en `errored` y el negocio no se sincroniza — para que la data se corrija en HubSpot y se reenvíe. Los ContactEmployees que sí entraron quedan en SAP (el Service Layer no tiene rollback entre llamadas), pero el reenvío los reencuentra por email/nombre/InternalCode en vez de duplicarlos.
Con `contactEmployee: true` se vuelve a la conducta anterior: el documento se crea igual, el evento queda `completed`, y el fallo solo se registra (log, `sapAudit.responseSap.contactEmployeeErrors` y — si `requireMessageHS` está activo — una nota en el deal, sin revertir la etapa).
La forma es namespaced a propósito: agregar otra área indultable en el futuro es sumar una llave más a este mismo value.
{ key: 'bypassSapErrors', value: { contactEmployee: false } }

Detalle:
Cuando un cliente quiere que, al procesar un webhook de deal (order/quotation/inventoryTransfer) y el BusinessPartner/ContactEmployee ya exista en SAP, se actualice con la data actual de HubSpot en vez de solo tomar el CardCode. fieldsUpdated_BP/fieldsUpdated_CE son nombres de campo SAP (no de HubSpot); cada uno puede ir null/[] para dejar esa entidad sin actualizar. Solo se envía el PATCH si algún campo difiere entre HubSpot y SAP.
{ key: 'upsertDataSAP', value: { required: true, fieldsUpdated_BP: ['EmailAddress', 'CardName'], fieldsUpdated_CE: ['Name', 'E_Mail'] } }

Detalle: businessPartnerCreation
Controla cómo se arma el payload de creación del BusinessPartner en SAP B1 desde un webhook de deal. `payloadStrategy: 'legacyWhitelist'` (el default) manda los nueve campos históricos; `'fullMapped'` manda todo lo que esté mapeado más los defaults, las direcciones y los contactos. `contactEmployeeSource: 'dealContact'` (default) toma el contact del deal como ContactEmployee; `'payloadArray'` toma `payload.contactEmployees` que envía el workflow de HubSpot e ignora el contact del deal. En `addresses`, las llaves de `byName` se comparan contra el `AddressName` de cada entrada de `payload.bpAddress` normalizado a minúsculas sin espacios, y aportan los valores fijos (`AddressType`, `Country`); el valor que venga del payload siempre gana sobre la config. `required` lista los `AddressName` obligatorios: si falta alguno, el webhook falla antes de escribir en SAP (vacío o ausente = no valida). `defaults.BPAddress` aplica a todas las direcciones. Solo aplica a SAP B1.
{ 
  "key": "businessPartnerCreation", 
  "value": { 
    "payloadStrategy": "fullMapped", 
    "contactEmployeeSource": "payloadArray", 
    "defaults": { 
      "BusinessPartner": { 
        "CardType": "cCustomer", 
        "PayTermsGrpCode": "13", 
        "Series": "59", 
        "PriceListNum": "1" 
      }, 
      "ContactEmployee": {
        "Active": "tYES" 
      }, 
      "BPAddress": { 
        "TaxCode": "IVA"
      } 
    }, 
    "addresses": { 
      "strategy": "payloadArray", 
      "byName": { 
        "factura": { 
          "AddressType": "bo_BillTo", 
          "Country": "GT" 
          
        }, 
        "entrega": { 
          "AddressType": "bo_ShipTo", 
          "Country": "GT" 
        } 
      }, 
      "required": ["factura", "entrega"] 
    } 
  }  
}

Detalle: propertiesFlags
SAP B1 expone 64 campos booleanos `Properties1` .. `Properties64`. Esta clave los conecta con UNA propiedad multi-select de HubSpot cuyos valores internos son los números 1..64: si el cliente tiene seleccionados 1, 2 y 55, se envían `Properties1`, `Properties2` y `Properties55` en `tYES` y las demás se omiten. En sentido inverso (SAP → HubSpot) se seleccionan en la lista las que estén en `tYES`. No puede expresarse como FieldMapping porque es una propiedad de HubSpot hacia N campos de SAP. `strategy: 'none'` (o la clave ausente) lo deja apagado, que es lo que necesitan los tenants que no usan estos campos. Los valores no numéricos o fuera de `[min, max]` se ignoran con un warning y nunca tumban el webhook.

{ "key": "propertiesFlags", 
    "value": { 
        "strategy": "numberedMultiSelect", 
        "hubspotProperty": "groupname", 
        "min": 1, 
        "max": 64, 
        "trueValue": "tYES" 
    } 
}

Detalle: requireAddress
Compuerta de la sincronización de direcciones de SAP hacia HubSpot. Hoy siempre debe quedar en `false`: un BusinessPartner de SAP tiene N direcciones (`BPAddresses`) y una company de HubSpot un solo juego de propiedades de dirección, así que el destino correcto es un objeto personalizado de HubSpot para direcciones y eso todavía no está implementado. Si se pone en `true`, la corrida registra un warning `ADDRESS_SYNC_NOT_IMPLEMENTED` y continúa normalmente, sin sincronizar ninguna dirección. La dirección HubSpot -> SAP no usa esta clave: esa va por el array `bpAddress` del payload del webhook y se configura en `businessPartnerCreation`.

{ 
    "key": "requireAddress", 
    "value": { 
        "required": false 
    } 
}

Detalle: batchExpiryStrategy
Lleva los lotes y sus fechas de caducidad de SAP a propiedades del producto en HubSpot. `source` decide de dónde salen los lotes: `'none'` (el default, y lo que aplica a todos los tenants B1 actuales) apaga el feature sin hacer ni una llamada a SAP; `'s4_BatchMaster'` lee el maestro `API_BATCH_SRV/Batch` y lo une con el stock por `Material + Batch`. `projection` decide cómo se representan: hoy solo existe `'hs_ProductProperties'`, que escribe las siete propiedades sobre el propio producto (`lotes_detalle`, `lote_proximo_vencer`, `fecha_vencimiento_proxima`, `dias_para_vencer`, `cantidad_por_vencer`, `cantidad_vencida`, `lotes_vigentes`) — hay que crearlas en el portal antes del primer run o `batchCreateProducts` falla el lote de 100 entero. `warehouses` acota el alcance con la misma sintaxis de `valueSAP` que `fieldsWareHouseHS` (`'DPDO/*'` centro completo, `'MQGT/0008'` bodega puntual) y **vacío o ausente significa TODAS las bodegas**, no ninguna; es independiente de `fieldsWareHouseHS` a propósito, para poder tener fechas de vencimiento sin propiedades de stock por bodega. `stockTypes` (default `['01']`, libre utilización) son los tipos de stock que cuentan; el stock especial —consignación, subcontratación, stock de cliente— se descarta siempre sin config. `includeExpired` (default `false`) solo controla si los vencidos salen en `lotes_detalle`: `cantidad_vencida` los cuenta igual, y `lote_proximo_vencer`/`fecha_vencimiento_proxima` nunca apuntan a un lote vencido aunque esté en `true`. `horizonDays` (default 90) es la ventana de "por vencer", con borde inclusivo. Un producto sin gestión de lotes queda con las siete propiedades vacías, no en cero. Solo aplica a SAP S/4HANA.
{ key: 'batchExpiryStrategy', value: { source: 's4_BatchMaster', projection: 'hs_ProductProperties', warehouses: [], stockTypes: ['01'], includeExpired: false, horizonDays: 90 } }

Detalle: fieldsWareHouseHS
Qué bodegas de SAP se llevan a propiedades numéricas del producto en HubSpot, y qué número va en cada una. **Cada entrada de la lista es UNA propiedad**: `value` es el nombre interno de la propiedad en HubSpot y `valueSAP` es el código de bodega en SAP (si falta `valueSAP`, se deduce del nombre de la propiedad, pero sólo si termina en `_stock`: `a01_stock` → `A01`; cualquier otro nombre se descarta). `metric` decide el número, y **sólo aplica a SAP Business One**: `'available'` (el default, y lo que aplica a toda config que no declare `metric`) es `InStock - Committed + Ordered`, o sea que cuenta lo pedido a proveedor como disponible; `'inStock'`, `'committed'` y `'ordered'` son el campo crudo de `ItemWarehouseInfoCollection` sin aritmética. Se compara sin distinguir mayúsculas, así que `'InStock'` e `'instock'` son lo mismo. Para tener tres columnas de la misma bodega se ponen tres entradas con el mismo `valueSAP` y `value` distintos. Una `metric` que no existe (un typo como `'inStok'`) **descarta esa entrada y escribe un documento en la colección `SyncWarnings`** con `code: 'warehouse_metric_invalid'`, atado al `syncLogId` de la corrida: la propiedad queda sin escribir en vez de recibir un número equivocado, que en una columna de inventario nadie detecta mirando. Una bodega listada en `excludedWarehouses` sale en `0` en cualquier métrica, aunque SAP reporte existencias. Una bodega configurada que no aparece en el producto también sale en `0`. Las propiedades tienen que existir en el portal **antes** del primer sync: una propiedad inexistente hace fallar el lote de 100 completo en `batchCreateProducts`. En SAP S/4HANA `metric` no se lee; el eje equivalente es `stockType` (ver `warehouseStockStrategy`).
{
  "key": "fieldsWareHouseHS",
  "value": [
    { "label": "A01 En stock",     "value": "a01_instock",   "valueSAP": "A01", "metric": "inStock" },
    { "label": "A01 Comprometido", "value": "a01_committed", "valueSAP": "A01", "metric": "committed" },
    { "label": "A01 Solicitado",   "value": "a01_ordered",   "valueSAP": "A01", "metric": "ordered" },
    { "label": "Bodega B09",       "value": "b09_stock",     "valueSAP": "B09" }
  ]
}

Detalle: s4PriceList
Precios de line items para tenants S/4 (`sapFlavor: "S4"`). Solo la usa el webhook `POST /webhooks/hubspot/line-items/prices/s4`; el flujo de B1 no la lee.

- `conditionType`: condición de precio de venta en SAP. En Multiquímica es `ZPR0`. Default `ZPR0`.
- `defaultPriceListType`: lista de precios a usar cuando el cliente no tiene una asignada en su área de ventas, o cuando la suya no tiene tarifa vigente para ese material. Obligatoria.
- `salesArea`: área de ventas a usar cuando el cliente tiene varias (un mismo cliente puede tener una lista distinta por organización de ventas). Si el cliente tiene una sola, se usa la suya y esta config se ignora. `salesOrganization` y `distributionChannel` son obligatorias juntas (son las dos que entran al filtro de condiciones en SAP); `division` es opcional y sólo desempata cuando el cliente tiene dos áreas que difieren únicamente en ella — si las filas de S/4 del cliente traen `Division` vacía, la comparación la ignora. Si el área configurada queda empatada con más de una del cliente, el flujo falla pidiendo la división en vez de elegir una.
- `priceListProperty`: propiedad del line item donde se escribe la lista efectivamente usada. Opcional. Se escribe SIEMPRE que esté configurada: cuando el precio salió del default del producto (tablas 501/504, sin lista) se escribe el literal `PRODUCT_DEFAULT`, para no dejar la etiqueta de la corrida anterior al lado de un precio de otra procedencia. Si la propiedad del portal es un desplegable, hay que agregarle la opción `PRODUCT_DEFAULT` además de las listas.
- `currencyProperty`: propiedad del line item donde se escribe la moneda de la tarifa de SAP. Opcional pero muy recomendada: la tarifa no se convierte, viene en la moneda de la condición. Si falta, cada corrida deja un warning en el log, porque sin ella la moneda no queda registrada en ninguna parte del CRM.
- `priceSourceProperty`: propiedad del line item donde se escribe el ORIGEN del precio: `customerPriceList` (la lista del área de ventas del cliente), `defaultPriceList` (`defaultPriceListType`) o `productDefault` (tablas 501/504). Opcional. Distingue los tres casos que la etiqueta de lista sola no separa, porque la lista del cliente y la de config pueden ser la misma.

Nota sobre el `amount` del negocio: si las líneas valorizadas quedan con tarifas en más de una moneda, el `amount` del deal NO se escribe (sumar USD con DOP no da un número correcto en ninguna de las dos). Las líneas sí se actualizan, queda un warning con el detalle y la respuesta trae `meta.dealUpdated: false` con el motivo.

```json
{ "key": "s4PriceList", "value": {
    "conditionType": "ZPR0",
    "defaultPriceListType": "ZC",
    "salesArea": { "salesOrganization": "FQCR", "distributionChannel": "01", "division": "SC" },
    "priceListProperty": "lista_de_precios_sap",
    "currencyProperty": "moneda_precio_sap",
    "priceSourceProperty": "origen_precio_sap"
}}
```