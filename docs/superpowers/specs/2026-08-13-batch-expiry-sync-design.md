# Sincronización de lotes y fechas de caducidad SAP → HubSpot

Fecha: 2026-08-13
Estado: diseño aprobado, pendiente de plan de implementación

## Problema

Multiquímica vende materias primas químicas con fecha de caducidad por lote. Hoy el vendedor
no tiene forma de saber, desde HubSpot, si un producto tiene lotes próximos a vencer — tiene
que entrar a SAP y navegar la jerarquía Centro → Almacén → Lote a mano.

El objetivo de negocio que planteó el cliente es concreto: **si un lote está por vencer, que el
equipo comercial lo sepa y lo empuje antes de perder el producto.**

El sync de productos S/4 ya carga nombre, unidad de medida, precios en 0 y stock por bodega
(ver [2026-08-10-s4-product-stock-sync-design.md](2026-08-10-s4-product-stock-sync-design.md)).
Falta la capa de lotes.

## Restricción que define el diseño

**Multiquímica no tiene custom objects en su licencia de HubSpot.** Los custom objects son
exclusivos de los tiers Enterprise; no es un tema de permisos ni de configuración.

Se evaluó reciclar un objeto estándar (Tickets, que tiene pipelines, propiedades y workflows)
y se descartó: la API de HubSpot describe el objeto Products como *"used to capture product
catalog items, not to track inventory"* — es un catálogo, no un objeto relacional. No acepta
asociaciones a contactos, empresas, deals ni tickets. Cuando un producto se agrega a una
cotización, HubSpot **copia** sus valores a un Line Item; no lo asocia. Sin ese vínculo, un
objeto de lotes queda huérfano del producto, que es justamente lo que se necesita.

## Datos verificados en vivo

Todo lo siguiente se midió por curl/OData contra el S/4 de QA de Multiquímica el 2026-08-13
(`vhmldqs4ci.hec.multidomsa.com:44300`, client `600`).

### Jerarquía

El `$metadata` de `API_MATERIAL_STOCK_SRV` etiqueta los campos igual que la GUI:
`Plant` = **Centro**, `StorageLocation` = **Almacén**, `Batch` = **SID de lote**.

| Nivel | Cantidad |
|---|---|
| Centros (`Plant`) | **10** — CPDO, DPDO, FQCR, GPDO, HFDO, MKDO, MPDO, MQDO, MQGT, TMDO |
| Códigos distintos de almacén | 71 |
| **Combinaciones Centro/Almacén reales** | **158** |

71 códigos contra 158 combinaciones confirma que **el código de almacén se repite entre
centros** (`0001` existe en DPDO, MQDO, FQCR, MPDO y MQGT y son bodegas físicas distintas).
La llave siempre es `Plant + StorageLocation`.

**La Sociedad no está en este servicio.** El `$metadata` completo no expone ningún campo de
sociedad ni empresa. El vínculo Centro → Sociedad requiere otro servicio y queda fuera de
alcance porque el caso de uso no lo necesita.

Centro/Almacén **es el modelo estándar de S/4**, no una particularidad de Multiquímica: son
entidades núcleo de MM presentes en toda instalación de S/4 y de ECC. Lo que varía entre
clientes es cuántos configuran y si usan EWM en vez de gestión de inventario clásica.

### Volumen

| Métrica | Valor |
|---|---|
| Filas de stock > 0 | 10,125 |
| Materiales con stock | 3,165 (de 8,080 en catálogo) |
| Filas con lote / sin lote | 9,686 / 439 |
| Pares material+lote en libre utilización (`01`, sin stock especial) | 7,261 |
| **Con `ShelfLifeExpirationDate`** | **6,818 → 93.9%** |
| Materiales que recibirían propiedades de caducidad | 2,619 |
| Materiales con `IsBatchManagementRequired` | 7,196 de 8,080 |
| Lotes por material | p50 **1** · p90 **5** · p99 18 · max **57** |
| Lotes en el maestro completo | 74,277 |

`InventoryStockType` observados: `01` (8,923 filas), `07` (567), `02` (390), `04` (242), `05` (3).
`InventorySpecialStockType`: vacío en 9,590 filas, `W` en 522, `O` en 12, `B` en 1.

### `BatchIdentifyingPlant` es `""` en los 74,277 lotes

El lote es **único a nivel material** en este sistema. La llave del join es `Material + Batch`,
sin centro. Esto elimina la ambigüedad que existiría si los lotes fueran por centro (mismo
código con fechas distintas en cada uno).

### El 39% de los lotes con stock están vencidos

**2,668 de 6,818.** La distribución completa:

| Rango | Lotes |
|---|---|
| Vencidos | **2,668** |
| 0–30 días | 106 |
| 31–90 días | 268 |
| 91–365 días | 1,339 |
| Más de un año | 2,437 |

Y no por poco — hay stock en libre utilización de lotes vencidos hace años:

```
70000132 | AMB-18062  -> 2021-12-22  (1,695 días)
80001686 | 2017174    -> 2022-03-17  (1,610 días)
10000471 | 31082022   -> 2024-08-31  (  712 días)
```

Esto tiene dos consecuencias. La de diseño: si `lote_proximo_vencer` mirara la lista completa,
devolvería siempre un lote vencido en 2021 y el campo quedaría inservible para el único caso de
uso que lo motiva. La de negocio: **Multiquímica tiene inventario vencido sin depurar en SAP**,
y publicarlo en HubSpot lo va a poner a la vista de todo el equipo comercial. Vale la pena
avisarles antes del primer run productivo.

### Costo de la lectura

| Consulta | Filas | Tiempo |
|---|---|---|
| `A_MatlStkInAcctMod` con `qty > 0` | 10,125 | 1.8 s |
| `Batch` (maestro completo) | 74,277 | **319 s** |
| `Batch` con `ShelfLifeExpirationDate ge <hoy>` | 21,397 | ~1.5 min (estimado) |

**No hay atajo por `$expand`.** El `$metadata` de `A_MatlStkInAcctMod` solo declara
`to_MaterialSerialNumber` y `to_MaterialStock`. No existe `to_Batch`: son dos llamadas
independientes y un join en memoria, igual que ya se resolvió el stock por bodega.

## Decisiones tomadas

| # | Decisión | Razón | Alternativa descartada |
|---|---|---|---|
| D1 | Los lotes viven como **propiedades del producto**, no como objeto propio | El tenant no tiene custom objects y Products no acepta asociaciones | Un registro de producto por lote: con 7,261 pares habría significado ~6,800 productos extra sobre 8,080, y el vendedor que busca un material vería N resultados |
| D2 | **Dos ejes de variación independientes**: fuente (de dónde salen los lotes en SAP) y proyección (cómo se representan en HubSpot) | Son ortogonales. Fundirlos daría `s4_ProductProperties`, `s4_CustomObject`, `b1_ProductProperties`, `b1_CustomObject` — cuatro clases duplicando media lógica | Una sola strategy combinada |
| D3 | **Puerto + factory para ambos ejes** desde el inicio | El criterio no es cuántas implementaciones existen hoy sino si se eligen en runtime; ambas salen de la config del tenant, igual que `warehouseStockStrategy` | Puerto sin factory para la proyección por tener una sola implementación |
| D4 | Forma normalizada intermedia entre fuente y proyección | Es el contrato que permite agregar la proyección a custom object sin tocar nada del lado SAP | Que la fuente devuelva ya las propiedades de HubSpot |
| D5 | `fecha_vencimiento_proxima` **siempre mira al futuro**, sin importar `includeExpired` | Un lote vencido en 2021 no es "lo próximo a vencer" en ningún sentido accionable | Que el campo refleje el mínimo absoluto |
| D6 | `cantidad_vencida` se calcula **siempre**, aunque `includeExpired` sea `false` | Es la señal de que hay inventario para depurar. Obliga a traer el maestro completo (319 s) en vez de filtrar por fecha en el servidor (~90 s), a cambio de un solo camino de código | Filtrar en SAP cuando `includeExpired: false` y perder el conteo |
| D7 | Un lote presente en varios almacenes se consolida en **una línea** con las bodegas listadas | El lote es único a nivel material, así que la fecha es la misma; repetirla sería ruido. Caso real: `17131` está en DPDO/0001 y DPDO/0108 | Una línea por combinación lote+bodega |
| D8 | El alcance de bodegas es **propio** de la config de lotes, no heredado de `fieldsWareHouseHS` | Un tenant puede querer fechas de vencimiento sin propiedades de stock por bodega; heredarlo lo obligaría a configurar la segunda solo para acotar la primera | Reutilizar los targets de la config de stock |
| D9 | Default global `source: 'none'` | Cero impacto en los tenants B1 existentes (amc, distelsa, noelito, printer): el enricher retorna antes de tocar red | Default activo con detección por flavor |
| D10 | Los productos sin gestión de lotes quedan con las propiedades **vacías**, no en cero | Un cero se lee como "no hay stock por vencer"; vacío se lee como "no aplica". Es la misma trampa que R1 del spec de stock | Escribir 0 uniformemente |

## Arquitectura

```
SyncSapConfigToHubspot
  └─ mapRecords()
  └─ s4ContactEnricher            (ya existe)
  └─ warehouseStockEnricher       (ya existe)
  └─ batchExpiryEnricher          ← NUEVO
       ├─ BatchExpiryConfigRepository        lee la config del tenant, nunca lanza
       ├─ BatchSourceStrategyFactory  → S4BatchMasterStrategy
       │     └─ S4BatchResolver              /API_BATCH_SRV/Batch
       │     └─ S4StockResolver              (existente, + campo Batch)
       ├─ batch-expiry.service.js            PURO: clasifica, ordena, agrupa
       └─ ProductBatchProjectionFactory → ProductPropertiesProjection
             └─ escribe rawSapData._batchExpiry
  └─ sendMappedRecords()
       └─ product.handler.js                 copia _batchExpiry a las propiedades
```

El enricher orquesta; **el servicio de dominio no sabe de HTTP y el resolver no sabe de fechas.**
Cada pieza se prueba sola.

### Forma normalizada (D4)

El contrato entre fuente y proyección. Si esto está bien, una proyección a custom object se
escribe después sin tocar nada del lado de SAP:

```js
[
  {
    batch: '17141',
    expirationDate: Date,          // null si el lote no la tiene
    manufactureDate: Date | null,
    quantity: 9654,                // suma de todas las bodegas en alcance
    // Sin unidad: el producto ya tiene `unidad_medida` como propiedad propia,
    // asi que repetirla en cada linea seria redundante y obligaria a pedir
    // MaterialBaseUnit de mas en el $select del stock.
    locations: [
      { plant: 'DPDO', storageLocation: '0001', quantity: 8600 },
      { plant: 'DPDO', storageLocation: '0201', quantity: 1054 },
    ],
    status: 'vigente' | 'porVencer' | 'vencido' | 'sinFecha',
    daysToExpiry: 80,              // null si no hay fecha
  },
]
```

## Componentes

### Dominio — `src/domain/batches/`

| Archivo | Responsabilidad |
|---|---|
| `batch-expiry.constants.js` | `BATCH_EXPIRY_CONFIG_KEY = 'batchExpiryStrategy'`, `BATCH_SOURCE_STRATEGIES`, `BATCH_PROJECTION_STRATEGIES`, `DEFAULT_BATCH_SOURCE = 'none'`, `BATCH_EXPIRY_KEY = '_batchExpiry'`, `BATCH_STATUS` |
| `batch-source-strategy.factory.js` | Copia estructural de `warehouse-stock-strategy.factory.js`: `Object.hasOwn`, `logger.error?.()` con `validStrategies`, `throw` si no existe |
| `batch-projection-strategy.factory.js` | Idéntica en estructura, sobre `BATCH_PROJECTION_STRATEGIES` |
| `sources/none.strategy.js` | Null object: `requiresRemoteFetch() → false`, `resolveBatches() → []`. Existe para que la factory tenga entrada para el valor por default y nunca lance. **El enricher retorna antes de invocarla** (ver abajo), así que en la práctica no produce datos |
| `sources/s4-batch-master.strategy.js` | Parseo de `"DPDO/*"` / `"MQGT/0008"`, filtrado por `stockTypes` y `InventorySpecialStockType` vacío, join `Material+Batch`, consolidación por lote (D7), clasificación de estado |
| `projections/product-properties.projection.js` | Forma normalizada → objeto de propiedades de HubSpot, incluyendo el render del texto |
| `batch-expiry.service.js` | Puro: cálculo de días, clasificación vigente/porVencer/vencido, orden por fecha ascendente |

### Puertos — `src/application/ports/`

`sap/batch-source-strategy.port.js`:

```js
export const BatchSourceStrategyPort = createPort({
  name: 'BatchSourceStrategyPort',
  methods: [
    'normalizeWarehouses',   // config.warehouses -> targets internos
    'requiresRemoteFetch',   // false en 'none'
    'buildQueryTargets',     // qué pedirle a SAP
    'buildIndex',            // filas crudas -> Map<material, batches[]>
    'resolveBatches',        // { record, index, config } -> forma normalizada
  ],
});
```

`hubspot/product-batch-projection.port.js`:

```js
export const ProductBatchProjectionPort = createPort({
  name: 'ProductBatchProjectionPort',
  methods: [
    'requiredProperties',  // (config) -> propiedades a asegurar en el portal
    'project',             // ({ record, batches, config }) -> { properties }
  ],
});
```

`requiredProperties` no es decorativo: alimenta a `tenantHubspotSeed.service.js`, de modo que
el portal se prepara según la proyección configurada. Una proyección a custom object declararía
ahí su propio esquema en vez de una lista de propiedades.

### Infraestructura

| Archivo | Responsabilidad |
|---|---|
| `src/infrastructure/sap/products/S4BatchResolver.js` | `fetchAll` sobre `/API_BATCH_SRV/Batch`. **Una sola conversación paginada**, no una por centro: el maestro no tiene centro (`BatchIdentifyingPlant` vacío). `$select=Material,Batch,ShelfLifeExpirationDate,ManufactureDate,BatchIsMarkedForDeletion` |
| `src/infrastructure/sap/products/S4StockResolver.js` | Agregar `Batch` a `MATERIAL_STOCK_SELECT`. Una línea |
| `src/infrastructure/sap/products/BatchExpiryEnrichmentAdapter.js` | Implementa `SapRecordEnricherPort` (ya existe). Orquesta config → fuente → servicio → proyección. **Falla en silencio** con `logger.error`. Retorna sin escribir `_batchExpiry` cuando `objectType !== 'product'`, cuando `source === 'none'`, o cuando la fuente falla — de modo que el handler deja las propiedades intactas en vez de pisarlas |
| `src/infrastructure/config/BatchExpiryConfigRepository.js` | Espejo de `WarehouseStockConfigRepository`: nunca lanza, `Configuration.findOne({key}).lean()` directo — **no** `tenantConfigurationService.getValue`, para no crear documentos vacíos por upsert |

### Puntos de enganche

| Archivo | Cambio |
|---|---|
| [SyncSapConfigToHubspot.js](../../../src/application/use-cases/SyncSapConfigToHubspot.js) | Nueva dep `batchExpiryEnricher = null`, invocada después de `warehouseStockEnricher` y antes de `sendMappedRecords` |
| [sap-sync.composition.js](../../../src/composition/sap-sync.composition.js) | Instanciar ambas factories y `assertPort(new BatchExpiryEnrichmentAdapter({...}), SapRecordEnricherPort)` |
| [product.handler.js](../../../src/infrastructure/hubspot/handlers/product.handler.js) | Ramificar con `Object.hasOwn(rawSapData, BATCH_EXPIRY_KEY)`, **nunca** con truthiness ni `??` |
| [tenantHubspotSeed.service.js](../../../src/infrastructure/hubspot/tenantHubspotSeed.service.js) | Las propiedades salen de `projection.requiredProperties(config)`, no de una lista fija |

## Configuración

```json
{
  "key": "batchExpiryStrategy",
  "userUpdated": "admin",
  "value": {
    "source": "s4_BatchMaster",
    "projection": "hs_ProductProperties",
    "warehouses": ["DPDO/*", "MQGT/0008"],
    "stockTypes": ["01"],
    "includeExpired": false,
    "horizonDays": 90
  }
}
```

| Clave | Efecto |
|---|---|
| `source` | Cómo se leen los lotes de SAP. `none` (default global) desactiva el feature |
| `projection` | Cómo se representan en HubSpot |
| `warehouses` | Alcance, con la sintaxis de `valueSAP`. **Vacío o ausente = todas** |
| `stockTypes` | Tipos de stock que cuentan. Default `["01"]` (libre utilización). Deja abierto incluir calidad (`02`) si el cliente confirma que esos lotes también se venden |
| `includeExpired` | Si los vencidos aparecen en `lotes_detalle`. No afecta a `cantidad_vencida` (D6) |
| `horizonDays` | Ventana de "por vencer" |

### Propiedades en HubSpot (proyección `hs_ProductProperties`)

| Propiedad | Tipo | Contenido |
|---|---|---|
| `lotes_detalle` | multi-line text | Una línea por lote: `17141 · vence 2026-11-01 · 9,654.000 · DPDO/0001, DPDO/0201` |
| `lote_proximo_vencer` | text | Código del lote vigente que vence primero |
| `fecha_vencimiento_proxima` | date | Su fecha (D5) |
| `dias_para_vencer` | number | Días calculados en la corrida |
| `cantidad_por_vencer` | number | Suma que vence dentro de `horizonDays` |
| `cantidad_vencida` | number | Suma ya vencida (D6) |
| `lotes_vigentes` | number | Cuántos lotes vigentes hay |

Con p90 = 5 lotes y max 57, el detalle en texto entra de sobra: HubSpot admite 65,536
caracteres en multi-line text.

## Lo que no cambia

- `s4ODataQueryBuilder`, `S4GatewayTransport`, `SapSyncDataAdapter`, `s4ODataService`
- Toda la cadena de `warehouseStockStrategy` — el stock por bodega sigue igual
- `OneToOneProductStrategy`, `SendMappedItemsToHubspot`
- Los tenants B1 actuales: con `source: 'none'` por default, ni una llamada extra

## Manejo de errores

El enricher **falla en silencio**, igual que `S4ContactEnrichmentAdapter` y
`WarehouseStockEnrichmentAdapter`: cualquier excepción se registra con `logger.error` y el sync
continúa. Un problema trayendo lotes no puede abortar la carga de 8,080 productos.

`BatchExpiryConfigRepository` nunca lanza; si la config no existe devuelve el default
(`source: 'none'`), que es el camino de cero impacto.

Cuando la fuente falla, el enricher **no** escribe la clave `_batchExpiry`, de modo que el
handler deja las propiedades intactas en vez de pisarlas con vacíos. Es la contrapartida de la
regla D10: escribir vacío es una afirmación ("este producto no maneja lotes"), y un fallo de red
no autoriza a hacerla.

## Testing

| Archivo | Cobertura clave |
|---|---|
| `tests/unit/domain/s4BatchMasterStrategy.test.js` | Parseo de `"DPDO/*"` y `"MQGT/0008"`; **`0001` en DPDO y en MQDO no se mezclan**; consolidación de un lote en dos almacenes en una línea (D7); descarte de `InventorySpecialStockType` no vacío; filtrado por `stockTypes`; lote sin fecha → `status: 'sinFecha'` |
| `tests/unit/domain/batchExpiry.service.test.js` | Clasificación vigente/porVencer/vencido con fecha fija inyectada; orden ascendente; `horizonDays` de borde (exactamente 90) |
| `tests/unit/domain/productPropertiesProjection.test.js` | `fecha_vencimiento_proxima` ignora vencidos aun con `includeExpired: true` (D5); `cantidad_vencida` se llena con `includeExpired: false` (D6); sin lotes → propiedades vacías, no cero (D10); `requiredProperties` devuelve las 7 |
| `tests/unit/domain/batchSourceStrategyFactory.test.js` | Strategy desconocida lanza con `validStrategies`; no resuelve nombres del prototipo (`constructor`); la estrategia `none` cumple el puerto y no devuelve lotes |
| `tests/unit/composition/sapSyncComposition.test.js` | Verificación textual de que el enricher quedó cableado con ambas factories. Un parámetro sin cablear deja todos los tests unitarios en verde porque cada uno inyecta su propio doble — ya pasó tres veces en este repo |
| `tests/unit/infrastructure/s4BatchResolver.test.js` | Estilo `s4StockResolver.test.js`: **una sola llamada a `fetchAll`** (prueba de no-N+1); `$select` exacto |
| `tests/unit/infrastructure/batchExpiryEnrichmentAdapter.test.js` | No-op en `objectType: 'company'`; `source: 'none'` no hace fetch **ni escribe `_batchExpiry`**; error del resolver tragado con `logger.error` y sin escribir la clave; config ausente → se comporta como `none` |
| `tests/unit/product.handler.test.js` (extender) | Con `_batchExpiry` poblado se copia; sin la clave, comportamiento actual idéntico; **el stock por bodega no se pisa** |

Línea base conocida de fallos previos: 6 suites / 12 tests (`sendMappedItemsToHubspot`,
`lineItemPriceWebhook.service`, `syncLineItemPrices`, `serviceLayerService`, `serviceLayerFlow`,
`integration/internalTenant`). Cualquier otra suite en rojo es regresión.

## Verificación end-to-end

Flujo manual habitual: dejar **solo** `Obtener Productos S4` con `active: true` y
`POST /sap-sync/run` con `{"tenantID": "<tenantKey>"}`.

1. Ensayo acotado: `filters` con `Product startswith 1000` antes del full.
2. Log del enricher: **una sola** llamada al maestro de lotes, y el conteo de filas indexadas.
3. En HubSpot, producto `10000289` (ANHIDRIDO FTALICO). Su stock real hoy:
   ```
   DPDO/0001 lote 17131   200.000     DPDO/0001 lote 17141  8,600.000
   DPDO/0108 lote 17131 6,000.000     DPDO/0201 lote 17141  1,054.000
   MQDO/0108 lote 24J1 19,000.000
   ```
   Con `warehouses: ["DPDO/*"]`, `lotes_detalle` debe traer **dos líneas** — `17131` con 6,200
   consolidando sus dos almacenes, y `17141` con 9,654 — y **no** debe aparecer `24J1`, que está
   en MQDO.
4. Un producto sin gestión de lotes: las 7 propiedades **vacías**, no en cero.
5. Segundo run idempotente: `skipped ≈ total`. Si `updated` sigue alto, es el redondeo flotante.
6. Regresión B1: correr el sync de productos de un tenant B1 y confirmar que el stock por bodega
   sale idéntico y que no se agregó ninguna propiedad de lote.

## Fuera de alcance

- **Escritura HubSpot → S/4.** No existe canal: `SapWebhookOrderAdapter`,
  `SapWebhookQuotationAdapter` y `SapWebhookInventoryTransferRequestAdapter` van todos contra el
  Service Layer de B1. Vender un lote específico desde HubSpot exige construir antes
  `API_SALES_ORDER_SRV` completo, que es un proyecto aparte. El cliente dejó esto sin definir.
- **Proyección a custom object.** El puerto y la factory quedan listos; la implementación llegará
  cuando exista un tenant Enterprise que la necesite.
- **Fuente B1** (`BatchNumberDetails` con `ExpirationDate`). El puerto la contempla; no se
  implementa ni se verifica en este trabajo.
- **Sociedad (CompanyCode).** No está en `API_MATERIAL_STOCK_SRV` y el caso de uso no la pide.
- **Depuración del inventario vencido en SAP.** Es un tema del cliente, no de la integración.
- **Alertas y workflows en HubSpot** sobre `dias_para_vencer`. Las propiedades quedan listas
  para construirlos; armarlos es configuración del portal.
