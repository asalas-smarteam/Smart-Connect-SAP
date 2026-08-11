# Configuraciones a crear manualmente — S/4 productos + stock (Multiquímica)

Fecha: 2026-08-10. Complementa
[2026-08-10-s4-product-stock-sync-design.md](2026-08-10-s4-product-stock-sync-design.md).

**Nada de esto se escribió en Mongo desde este trabajo.** Es la lista completa de documentos
a insertar/reemplazar a mano en la base del tenant de Multiquímica. La contraseña SAP no se
incluye en texto en este archivo (queda en el historial de git) — la tienes ya en Postman
(`smarteam` / `Multiquimica.600` contra `vhmldqs4ci.hec.multidomsa.com:44300`, client `600`).

## 0. Prerrequisito: el tenant todavía no existe

Al 2026-08-09, Multiquímica no tiene entrada en `SmartConnect.SaaSClients` ni base
`sap_integration_multiquimica` en el Mongo compartido. Antes de insertar nada de lo de abajo:

1. `provisionTenant({ companyName: 'Multiquimica', planId, billingEmail, hubspot, sapFlavor: 'S4' })`
   — crea la base del tenant, siembra los 5 `IntegrationMode` (incluye `S4_ODATA`), pone
   `Configuration.sapFlavor = 'S4'`, y replica los `SapFilter` default de S/4.
2. Completar el flujo OAuth de HubSpot para ese tenant → dispara
   `replicateMasterClientConfigs`, que crea el `ClientConfig` **"Obtener Productos S4"**
   (`serviceLayerPath: '/API_PRODUCT_SRV/A_Product'`, `integrationModeId: S4_ODATA`,
   `active: false`). Déjalo así hasta terminar de insertar lo de abajo.
3. Anota el `_id` de ese `ClientConfig` y el `_id` del `HubspotCredentials` del tenant — los
   necesitas para las filas de `FieldMapping` de la sección 2.

## 1. Colección `Configurations`

Documentos con `{ key, value, userUpdated: 'admin' }`. `sapFlavor` ya lo deja el paso 0; el
resto se inserta ahora.

```json
{ "key": "mappingFallback", "value": true, "userUpdated": "admin" }
```

```json
{
  "key": "mappingCollectionPriority",
  "value": {
    "to_Description": { "field": "Language", "order": ["ES", "EN"] }
  },
  "userUpdated": "admin"
}
```
**No es opcional.** Sin esto, `to_Description` (que trae 2 filas, ES y EN, sin orden
garantizado del Gateway) se resuelve tomando la primera fila a ciegas — hoy sale español por
casualidad, no por diseño.

```json
{
  "key": "productSyncStrategy",
  "value": {
    "strategy": "oneToOne_Product",
    "requirePrice": { "value": false, "field": "" },
    "requireCost": { "flag": false, "field": "" }
  },
  "createAt": {
    "$date": "2026-08-10T12:11:28.661Z"
  },
  "updateAt": {
    "$date": "2026-08-10T12:11:28.661Z"
  },
  "userUpdated": "admin"
}
```
`requirePrice.value: false` es lo que activa los precios en 0 (ver sección de riesgos del
spec de diseño). Cámbialo a `true` únicamente si Multiquímica decide traer precio real de SAP.

```json
{ "key": "fieldsPricesHS", "value": ["hs_price_usd"], "userUpdated": "admin" }
```
Ajusta la lista a los nombres reales de propiedad de precio que uses en el portal de
Multiquímica (por ejemplo `hs_price_usd` si manejan varias monedas).

```json
{
  "key": "warehouseStockStrategy",
  "value": { "strategy": "s4_PlantStorageLocation" },
  "createAt": {
    "$date": "2026-08-10T12:11:28.661Z"
  },
  "updateAt": {
    "$date": "2026-08-10T12:11:28.661Z"
  },
  "userUpdated": "admin"
}
```
Esta es la clave nueva de este trabajo. Sin este documento, el sistema usa el default
`b1_ItemWarehouse` (que para un tenant S/4 simplemente no encuentra nada y deja `_warehouseStock: {}`).

```json
{
  "key": "fieldsWareHouseHS",
  "userUpdated": "admin",
  "value": [
    { "label": "MQGT 0008 - Libre utilización", "value": "mqgt_0008_stock",     "valueSAP": "MQGT/0008" },
    { "label": "MQGT 0008 - Control calidad",   "value": "mqgt_0008_calidad",   "valueSAP": "MQGT/0008", "stockType": "02" },
    { "label": "MQGT 0008 - Bloqueado",         "value": "mqgt_0008_bloqueado", "valueSAP": "MQGT/0008", "stockType": "04" },
    { "label": "MQGT 0008 - Total",             "value": "mqgt_0008_total",     "valueSAP": "MQGT/0008", "stockType": ["01", "02", "04", "07"] },
    { "label": "MQGT 0500 - Libre utilización", "value": "mqgt_0500_stock",     "valueSAP": "MQGT/0500" },
    { "label": "HFDO 0401 - Libre utilización", "value": "hfdo_0401_stock",     "valueSAP": "HFDO/0401" },
    { "label": "CPDO 0006 - Libre utilización", "value": "cpdo_0006_stock",     "valueSAP": "CPDO/0006" },
    { "label": "MQDO 0008 - Libre utilización", "value": "mqdo_0008_stock",     "valueSAP": "MQDO/0008" },
    { "label": "DPDO - centro completo",        "value": "dpdo_stock",          "valueSAP": "DPDO/*" },
    { "label": "TMDO - centro completo",        "value": "tmdo_stock",          "valueSAP": "TMDO/*" },
    { "label": "GPDO - centro completo",        "value": "gpdo_stock",          "valueSAP": "GPDO/*" }
  ],
  "createAt": {
    "$date": "2026-08-10T12:11:28.661Z"
  },
  "updateAt": {
    "$date": "2026-08-10T12:11:28.661Z"
  },
}
```
Es un punto de partida con los 7 centros reales que verifiqué en vivo (MQGT, HFDO, CPDO, MQDO,
DPDO, TMDO, GPDO) y los almacenes con stock que aparecieron en la muestra. **Ryan/Elmon deben
confirmar cuáles almacenes de cada centro les interesan realmente** — esta lista es de
arranque, no la definitiva. Regla para editarla: **una entrada = una propiedad de HubSpot**.
Si quieren libre/calidad/bloqueado/total para una bodega, son 4 entradas con el mismo
`valueSAP` y distinto `stockType` (ausente = `"01"` libre utilización; código único; array de
códigos que se suman; o `"*"` para sumar todos los tipos presentes).

```json
{ "key": "excludedWarehouses", "value": [], "userUpdated": "admin" }
```
Vacío por defecto, para que quede visible en el admin. Formato de entrada:
`"MQGT/0006"` (una bodega puntual) o `"MQGT/*"` (centro completo).

## 2. Colección `FieldMappings`

Estas SÍ hay que crearlas a mano — el código deliberadamente **no** siembra ningún mapping de
producto por defecto para tenants S/4 (ver spec de diseño, decisión "Mappings de producto").

```json
[
  {
    "sourceField": "Product",
    "targetField": "hs_sku",
    "objectType": "product",
    "sourceContext": "product",
    "clientConfigId": {
      "$oid": "6a68dc5b03837bce4474fd3d"
    },
    "hubspotCredentialId": {
      "$oid": "6a68dc4203837bce4474fd32"
    },
    "isActive": true,
    "editable": false,
    "includeInServiceLayerSelect": true
  },
  {
    "sourceField": "to_Description.ProductDescription",
    "targetField": "name",
    "objectType": "product",
    "sourceContext": "product",
    "clientConfigId": {
      "$oid": "6a68dc5b03837bce4474fd3d"
    },
    "hubspotCredentialId": {
      "$oid": "6a68dc4203837bce4474fd32"
    },
    "isActive": true,
    "editable": false,
    "includeInServiceLayerSelect": true
  },
  {
    "sourceField": "BaseUnit",
    "targetField": "unidad_medida",
    "objectType": "product",
    "sourceContext": "product",
    "clientConfigId": {
      "$oid": "6a68dc5b03837bce4474fd3d"
    },
    "hubspotCredentialId": {
      "$oid": "6a68dc4203837bce4474fd32"
    },
    "isActive": true,
    "editable": false,
    "includeInServiceLayerSelect": true
  }
]
```
Verificado en vivo contra el Gateway de QA: `$select=Product,BaseUnit,to_Description&$expand=to_Description`
devuelve las 8080 filas de `A_Product` con la descripción correctamente. Si más adelante
agregan otro campo (por ejemplo un código de barras), sólo hace falta otra fila aquí — nunca
tocar código.

## 3. Colección `SapCredentials` (un solo documento)

Todos los puntos de fetch (`SapSyncDataAdapter`, `WarehouseStockEnrichmentAdapter`) hacen
`SapCredentials.find()` y toman el primero — **debe existir exactamente uno** para este tenant.

```json
{
  "clientConfigId": "<_id de 'Obtener Productos S4'>",
  "serviceLayerBaseUrl": "https://vhmldqs4ci.hec.multidomsa.com:44300",
  "serviceLayerUsername": "smarteam",
  "serviceLayerPassword": "<la contraseña que ya tienes en Postman>",
  "serviceLayerCompanyDB": null,
  "serviceLayerTopFilter": null
}
```
Nota: `serviceLayerCompanyDB`/`serviceLayerTopFilter` son campos B1 sin uso en S/4; se dejan en
`null`. El `sap-client=600` no tiene campo dedicado en el esquema — `S4GatewayTransport` no lo
inyecta por configuración; si el Gateway lo exige como query param en cada llamada y no sólo
en las pruebas manuales de Postman, es un ajuste a `S4GatewayTransport`/`s4ODataService` fuera
del alcance de este trabajo (avísame si el primer run falla por mandante).

## 4. Limpieza (sólo si el sync de este ClientConfig ya corrió antes del fix)

El fix del Paso 1 evita que se sigan sembrando mappings B1 (`ItemCode`, `ItemName`,
`QuantityOnStock`, `Price`) en un tenant S/4, pero no borra los que ya existan. Antes de activar
el ClientConfig, revisa y — si aparece algo — bórralo:

```js
db.FieldMappings.find({
  objectType: 'product',
  sourceField: { $in: ['ItemCode', 'ItemName', 'QuantityOnStock', 'Price'] },
})
// si hay resultados:
db.FieldMappings.deleteMany({
  objectType: 'product',
  sourceField: { $in: ['ItemCode', 'ItemName', 'QuantityOnStock', 'Price'] },
})
```

## 5. Propiedades a crear en HubSpot antes del primer run

Si falta una sola, `batchCreateProducts` falla el lote de 100 completo y degrada a
llamadas secuenciales (miles de requests fallidos con 8080 productos). Crear antes de activar:

- `unidad_medida` (texto) — ya la agrega `seedCreateFieldsHubspot` para tenants S/4; confirma
  que corrió, o créala a mano.
- Cada `value` de `fieldsWareHouseHS` de la sección 1 (número): `mqgt_0008_stock`,
  `mqgt_0008_calidad`, `mqgt_0008_bloqueado`, `mqgt_0008_total`, `mqgt_0500_stock`,
  `hfdo_0401_stock`, `cpdo_0006_stock`, `mqdo_0008_stock`, `dpdo_stock`, `tmdo_stock`,
  `gpdo_stock`.
- Cada nombre de `fieldsPricesHS` (número): `price` (o los que uses).
- `hs_sku` y `name` ya son propiedades estándar de HubSpot Products.

## 6. Checklist de activación

1. Confirmar los pasos 0-5 de este documento.
2. `PATCH` al ClientConfig con un filtro acotado para el primer ensayo, ej.
   `{"filters":[{"property":"Product","operator":"startswith","value":"1000"}]}`.
3. Dejar sólo `Obtener Productos S4` en `active: true`.
4. `POST /sap-sync/run` con `{"tenantID": "<tenantKey>"}`.
5. Revisar el log del `s4ODataService` (debe pedir `Product,to_Description,BaseUnit` — si
   aparece `ItemCode`, ver sección 4) y el `SyncLog` (`status: 'completed'`).
6. En HubSpot: `hs_sku`, `name` en español, `price = 0`, `unidad_medida` y las `*_stock` con
   números.
7. Correr el mismo sync una segunda vez: debe reportar `skipped ≈ total` (idempotencia). Si no,
   revisar redondeo de cantidades (spec de diseño, sección de riesgos).
8. Quitar el filtro de ensayo y correr el full (8080 productos, ~81 lotes).
