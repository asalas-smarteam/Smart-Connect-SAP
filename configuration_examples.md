
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
Qué bodegas de SAP se llevan a propiedades numéricas del producto en HubSpot, y qué número va en cada una. **Cada entrada de la lista es UNA propiedad**: `value` es el nombre interno de la propiedad en HubSpot y `valueSAP` es el código de bodega en SAP (si falta `valueSAP`, se deduce del nombre de la propiedad, pero sólo si termina en `_stock`: `a01_stock` → `A01`; cualquier otro nombre se descarta). `metric` decide el número, y **sólo aplica a SAP Business One**: `'available'` (el default, y lo que aplica a toda config que no declare `metric`) es la fórmula de `warehouseAvailableFormula` (por defecto `InStock - Committed + Ordered`, o sea que cuenta lo pedido a proveedor como disponible); `'inStock'`, `'committed'` y `'ordered'` son el campo crudo de `ItemWarehouseInfoCollection` sin aritmética. Se compara sin distinguir mayúsculas, así que `'InStock'` e `'instock'` son lo mismo. Para tener tres columnas de la misma bodega se ponen tres entradas con el mismo `valueSAP` y `value` distintos. Una `metric` que no existe (un typo como `'inStok'`) **descarta esa entrada y escribe un documento en la colección `SyncWarnings`** con `code: 'warehouse_metric_invalid'`, atado al `syncLogId` de la corrida: la propiedad queda sin escribir en vez de recibir un número equivocado, que en una columna de inventario nadie detecta mirando. Una bodega listada en `excludedWarehouses` sale en `0` en cualquier métrica, aunque SAP reporte existencias. Una bodega configurada que no aparece en el producto también sale en `0`. Las propiedades tienen que existir en el portal **antes** del primer sync, y tienen que crearse en **producto y en line item**: la misma config alimenta también el sync de precios de line items (`SyncLineItemPrices.js` → `TenantLineItemPriceConfigRepository.getHubspotWarehouseStockPropertiesForTenant` → `HubspotLineItemPriceClient`, que derrama el resultado dentro de `properties` de cada line item y también del producto). Si falta en producto, una propiedad inexistente hace fallar el lote de 100 completo en `batchCreateProducts`; si falta en line item, el siguiente webhook de precios manda esas propiedades dentro de cada line item y HubSpot responde 400, con lo que el lote entero de actualización de precios falla y el negocio queda con el precio viejo. En SAP S/4HANA `metric` no se lee; el eje equivalente es `stockType`.
{
  "key": "fieldsWareHouseHS",
  "value": [
    { "label": "A01 En stock",     "value": "a01_instock",   "valueSAP": "A01", "metric": "inStock" },
    { "label": "A01 Comprometido", "value": "a01_committed", "valueSAP": "A01", "metric": "committed" },
    { "label": "A01 Solicitado",   "value": "a01_ordered",   "valueSAP": "A01", "metric": "ordered" },
    { "label": "Bodega B09",       "value": "b09_stock",     "valueSAP": "B09" }
  ]
}

Detalle: warehouseAvailableFormula
Qué significa la métrica `available` de `fieldsWareHouseHS` en SAP Business One: la suma de los campos de `add` menos la suma de los campos de `subtract`, leídos de la bodega tal como vienen en `ItemWarehouseInfoCollection`. Los únicos campos válidos son `InStock`, `Committed` y `Ordered` (se comparan sin distinguir mayúsculas y se guardan en esa forma); cualquier otro nombre invalida la config. **Ausente = `InStock - Committed + Ordered`**, que es el cálculo histórico y con el que nace todo tenant nuevo (`ensureTenantConfigurations` la siembra). Sólo define `available`: las métricas crudas `inStock`, `committed` y `ordered` no la leen. Es **por tenant**, no por bodega. Una fórmula inválida (un campo desconocido, el mismo campo en `add` y en `subtract`, las dos listas vacías, o un `value` que no es objeto) hace que en esa corrida las entradas `available` **no se escriban** —HubSpot conserva el último valor— y que quede un documento en `SyncWarnings` con `code: 'warehouse_available_formula_invalid'` y el motivo en `details.reason`; nunca cae al default, porque escribiría un número plausible pero distinto del que el tenant pidió. Una bodega en `excludedWarehouses` sigue saliendo en `0` con cualquier fórmula. Sólo aplica a SAP Business One; en S/4HANA el eje equivalente es `stockType`. El camino de precios de line items la lee con `getValue`, así que si el documento no existe lo crea con el default en el primer webhook: un tenant puede "tener" la clave sin que nadie la haya insertado.
{ key: 'warehouseAvailableFormula', value: { add: ['InStock', 'Ordered'], subtract: ['Committed'] } }
{ key: 'warehouseAvailableFormula', value: { add: ['InStock'], subtract: ['Committed'] } }

Detalle: s4PriceList
Precios de line items para tenants S/4 (`sapFlavor: "S4"`). Solo la usa el webhook `POST /webhooks/hubspot/line-items/prices/s4`; el flujo de B1 no la lee.

- `conditionType`: condición de precio de venta en SAP. En Multiquímica es `ZPR0`. Default `ZPR0`.
- `defaultPriceListType`: lista de precios a usar cuando el cliente no tiene una asignada en su área de ventas, o cuando la suya no tiene tarifa vigente para ese material. Obligatoria. Es el ÚLTIMO recurso: primero se busca la combinación del negocio en `defaultPriceListBySalesArea`.
- `defaultPriceListBySalesArea`: lista por defecto para cada área de ventas, con la clave `"ORG/CANAL"`. Opcional (sin ella todo cae a `defaultPriceListType`). Es por área y no global porque la lista mayoritaria cambia según la combinación: sobre las 16 que existen en Multiquímica, un default global acierta en 5. La clave se normaliza a mayúsculas y se le quitan los espacios, pero el canal NO se re-normaliza — SAP devuelve `"01"`, así que `"1"` no matchea nunca (equipararlos esconde una config mal cargada). Una entrada con la clave mal escrita, o con el valor vacío, se descarta con un warning en el log y esa combinación cae a `defaultPriceListType`; no se cae toda la config por un typo.

  **El área de ventas ya NO se configura acá: la declara el negocio de HubSpot.** Los tenants S/4 necesitan dos propiedades obligatorias en el objeto Negocio, `sales_organization` (→ `SalesOrganization`) y `distribution_channel` (→ `DistributionChannel`), más la nativa `deal_currency_code`. Con esas dos, `A_CustomerSalesArea` devuelve una sola fila del cliente y de ahí sale su lista. Si el negocio no las trae, el evento falla y se deja una nota pidiéndolas, sin tocar los precios. Si el cliente no está registrado en esa área, los precios de las líneas se ponen en 0 y la nota lista las áreas que el cliente sí tiene. La clave `salesArea` de versiones anteriores ya no se lee; puede quedar en el documento sin efecto.
- `priceListProperty`: propiedad del line item donde se escribe la lista efectivamente usada. Opcional. Se escribe SIEMPRE que esté configurada: cuando el precio salió del default del producto (tablas 501/504, sin lista) se escribe el literal `PRODUCT_DEFAULT`, para no dejar la etiqueta de la corrida anterior al lado de un precio de otra procedencia. Si la propiedad del portal es un desplegable, hay que agregarle la opción `PRODUCT_DEFAULT` además de las listas.
- `currencyProperty`: propiedad del line item donde se escribe la moneda de la tarifa de SAP. Opcional pero muy recomendada: la tarifa no se convierte, viene en la moneda de la condición. Si falta, cada corrida deja un warning en el log, porque sin ella la moneda no queda registrada en ninguna parte del CRM.
- `priceSourceProperty`: propiedad del line item donde se escribe el ORIGEN del precio: `customerPriceList` (la lista del área de ventas del cliente), `defaultPriceList` (`defaultPriceListType`) o `productDefault` (tablas 501/504). Opcional. Distingue los tres casos que la etiqueta de lista sola no separa, porque la lista del cliente y la de config pueden ser la misma.

Nota sobre el `amount` del negocio: si las líneas valorizadas quedan con tarifas en más de una moneda, el `amount` del deal NO se escribe (sumar USD con DOP no da un número correcto en ninguna de las dos). Las líneas sí se actualizan, queda un warning con el detalle y la respuesta trae `meta.dealUpdated: false` con el motivo.

Nota sobre la moneda de la línea: el campo `price` del line item no lleva moneda propia, hereda la del negocio. Si la condición de SAP está en otra moneda que `deal_currency_code`, la línea se **saltea** (escribir ahí una tarifa en DOP dentro de un negocio en USD es un precio silenciosamente equivocado) y el motivo queda en la nota. Cuando un material tiene condiciones en varias monedas, gana la que coincide con la del negocio; si ninguna coincide, gana el `ConditionRecord` menor, para que el resultado sea reproducible entre corridas.

```json
{ "key": "s4PriceList", "value": {
    "conditionType": "ZPR0",
    "defaultPriceListType": "ZC",
    "defaultPriceListBySalesArea": {
      "DPDO/01": "ZC", "DPDO/02": "ZD",
      "CPDO/01": "ZD", "CPDO/02": "ZD",
      "GPDO/01": "ZC", "GPDO/02": "ZA",
      "MQDO/01": "ZD", "MQDO/02": "ZD",
      "TMDO/01": "ZC", "TMDO/02": "ZB",
      "MQGT/01": "ZC", "MQGT/02": "ZA",
      "HFDO/01": "ZD", "MPDO/01": "ZA",
      "MKDO/01": "ZD", "MKDO/02": "ZD"
    },
    "priceListProperty": "lista_de_precios_sap",
    "currencyProperty": "moneda_precio_sap",
    "priceSourceProperty": "origen_precio_sap"
}}
```

El mapa de arriba son las listas **mayoritarias** de cada combinación en el S/4 de Multiquímica al 2026-08-24, calculadas de los datos y cargadas para que el desarrollo y las pruebas funcionen. Están pendientes de que el cliente las confirme; el impacto es acotado porque el default sólo aplica a los clientes cuya `PriceListType` viene vacía (391 en todo el sistema).