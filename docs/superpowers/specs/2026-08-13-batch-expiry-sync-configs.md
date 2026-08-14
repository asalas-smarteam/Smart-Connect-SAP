# Configuraciones a crear manualmente — lotes y caducidad S/4 (Multiquímica)

Fecha: 2026-08-13. Complementa
[2026-08-13-batch-expiry-sync-design.md](2026-08-13-batch-expiry-sync-design.md) y se apoya en
[2026-08-10-s4-product-stock-sync-configs.md](2026-08-10-s4-product-stock-sync-configs.md), que
sigue siendo el documento base del tenant (credenciales SAP, mappings de producto,
`warehouseStockStrategy`, `fieldsWareHouseHS`).

**Nada de esto se escribió en Mongo desde este trabajo.** Es la lista de documentos a insertar a
mano en la base del tenant de Multiquímica más la verificación end-to-end que hay que correr
después.

**Los tenants B1 existentes no se tocan.** El default global de la fuente de lotes es
`source: 'none'` (`DEFAULT_BATCH_SOURCE` en `src/domain/batches/batch-expiry.constants.js`), y
`BatchExpiryConfigRepository` lee con `findOne` directo — sin upsert — así que un tenant que no
tiene el documento `batchExpiryStrategy` no gana ninguna configuración por el solo hecho de
correr el sync. Con `source: 'none'` el enricher retorna antes de tocar red: amc, distelsa,
noelito y printer no pagan ni una llamada extra ni reciben ninguna propiedad nueva.

---

## 0. Prerrequisito: el tenant todavía no existe

Al 2026-08-13, Multiquímica sigue sin entrada en `SmartConnect.SaaSClients` ni base
`sap_integration_multiquimica` en el Mongo compartido. **Antes de poder insertar nada de este
documento:**

1. `provisionTenant({ companyName: 'Multiquimica', planId, billingEmail, hubspot, sapFlavor: 'S4' })`
   — crea la base del tenant, siembra los 5 `IntegrationMode` (incluye `S4_ODATA`), pone
   `Configuration.sapFlavor = 'S4'` y replica los `SapFilter` default de S/4.
2. Completar el flujo OAuth de HubSpot para ese tenant. Esto dispara
   `replicateMasterClientConfigs` (crea el `ClientConfig` **"Obtener Productos S4"** en
   `active: false`) y `seedCreateFieldsHubspot`, que para `sapFlavor === 'S4'` **ya crea las
   siete propiedades de lote** de la sección 1 (ver
   `src/infrastructure/hubspot/tenantHubspotSeed.service.js`, donde se importan directamente de
   `BATCH_PRODUCT_PROPERTIES`).
3. Ejecutar todo lo del documento de 2026-08-10 (secciones 1 a 5): credenciales SAP, mappings de
   producto, `warehouseStockStrategy`, `fieldsWareHouseHS`, `fieldsPricesHS`.

Recién después de eso aplica lo de abajo.

---

## 1. Las 7 propiedades de HubSpot que deben existir antes del primer run

Copiadas literalmente de `BATCH_PRODUCT_PROPERTIES` en
[`src/domain/batches/projections/product-properties.projection.js`](../../../src/domain/batches/projections/product-properties.projection.js).
Todas van sobre el objeto **Products**.

| Nombre interno | Label | `type` | `fieldType` |
|---|---|---|---|
| `lotes_detalle` | Lotes (detalle) | `string` | `textarea` |
| `lote_proximo_vencer` | Lote próximo a vencer | `string` | `text` |
| `fecha_vencimiento_proxima` | Fecha de vencimiento más próxima | `date` | `date` |
| `dias_para_vencer` | Días para vencer | `number` | `number` |
| `cantidad_por_vencer` | Cantidad por vencer | `number` | `number` |
| `cantidad_vencida` | Cantidad vencida | `number` | `number` |
| `lotes_vigentes` | Lotes vigentes | `number` | `number` |

> **Advertencia — si falta una sola, se cae el lote entero.** `batchCreateProducts` de HubSpot
> rechaza el batch de 100 completo cuando una propiedad del payload no existe en el portal, y el
> flujo degrada a llamadas secuenciales. Con 8,080 productos eso son ~8,000 requests fallidos en
> una sola corrida, no un error puntual.

Lo normal es que el paso 2 del prerrequisito ya las haya creado. **Verificar igual, una por una,
antes de activar el ClientConfig**: es más barato revisar siete propiedades que depurar una
corrida degradada.

Nota sobre `fecha_vencimiento_proxima`: se escribe como `YYYY-MM-DD` (`formatDate` en la
proyección). Es el único punto del diseño donde el formato se valida contra la API real de
HubSpot, y por eso está explícito en la verificación de la sección 5.

---

## 2. El documento `Configuration`

Colección `Configurations` de la base del tenant. Insertar tal cual:

```json
{
  "key": "batchExpiryStrategy",
  "userUpdated": "admin",
  "value": {
    "source": "s4_BatchMaster",
    "projection": "hs_ProductProperties",
    "warehouses": [],
    "stockTypes": ["01"],
    "includeExpired": false,
    "horizonDays": 90
  }
}
```

| Clave | Efecto | Default si falta |
|---|---|---|
| `source` | De dónde salen los lotes en SAP. `s4_BatchMaster` lee `API_BATCH_SRV/Batch` y lo une con el stock por `Material + Batch`. `none` desactiva el feature sin tocar red | `none` — el feature queda apagado |
| `projection` | Cómo se representan en HubSpot. Hoy solo existe `hs_ProductProperties` (propiedades sobre el propio producto); la proyección a custom object está fuera de alcance porque el tenant no tiene esa licencia | `hs_ProductProperties` |
| `warehouses` | Alcance de bodegas, con la misma sintaxis de `valueSAP` que `fieldsWareHouseHS`: `"DPDO/0001"` (bodega puntual) o `"DPDO/*"` (centro completo). **Vacío o ausente = TODAS las bodegas** | `[]` → todas |
| `stockTypes` | Tipos de stock que cuentan. `"01"` es libre utilización. Un lote en calidad (`"02"`) o bloqueado (`"04"`) no se puede vender, así que mostrarlo bajo "aprovechá a venderlo" sería engañoso — abrir esto solo si el cliente confirma que esos lotes también se venden | `["01"]` |
| `includeExpired` | Si los lotes vencidos aparecen en `lotes_detalle`. **No afecta a `cantidad_vencida`**, que se calcula siempre (decisión D6 del spec) | `false` |
| `horizonDays` | Ventana de "por vencer", en días. Borde inclusivo: un lote que vence exactamente dentro de `horizonDays` ya cuenta como por vencer | `90` |

Aclaraciones que evitan sorpresas al leer el resultado:

- **`warehouses: []` significa todas las bodegas**, no ninguna. Es lo que hace que esta config sea
  autónoma de `fieldsWareHouseHS`: un tenant puede querer fechas de caducidad sin haber
  configurado ni una propiedad de stock por bodega (decisión D8).
- El **stock especial** (consignación, subcontratación, stock de cliente —
  `InventorySpecialStockType` no vacío) se descarta siempre, sin config. No es inventario propio.
- `lote_proximo_vencer` y `fecha_vencimiento_proxima` **nunca** apuntan a un lote vencido, aunque
  `includeExpired` sea `true` (decisión D5).
- Un producto sin gestión de lotes queda con las siete propiedades **vacías**, no en cero
  (decisión D10). Un cero se leería como "no hay stock por vencer"; vacío se lee como "no aplica".
- Si la lectura de SAP falla, el enricher **no escribe la clave** y HubSpot conserva los valores
  de la corrida anterior. Un fallo de red no autoriza a afirmar "este producto no tiene lotes".

---

## 3. Advertencia para el cliente: hay inventario vencido sin depurar

**Medido el 2026-08-10 sobre el maestro completo de 74,277 lotes: 2,668 de los 6,818 pares
material-lote con stock en libre utilización estaban vencidos — un 39%.** Algunos hacía más de
cuatro años (`70000132 / AMB-18062 → 2021-12-22`, 1,695 días).

> **Esa cifra es una medición con fecha, no un número vigente.** El stock se mueve y los lotes
> vencen todos los días, así que a la fecha en que se lea este documento habrá derivado. Sirve
> como orden de magnitud, no como dato para reportar al cliente sin volver a medir.

Consecuencia operativa: con `includeExpired: false` esos lotes **no** salen en `lotes_detalle`,
pero `cantidad_vencida` los expone igual — a propósito, es la señal de que hay inventario para
depurar. Al publicarlo en HubSpot queda a la vista de todo el equipo comercial.

**Avisarle a Multiquímica antes del primer run productivo.** Depurar ese inventario en SAP es
tema del cliente, no de la integración, pero enterarse por la pantalla de un vendedor es la peor
forma de enterarse.

---

## 4. Nota de performance

La corrida de productos agrega **~319 s (~5.3 min)** por traer el maestro de lotes completo
(74,277 filas, medido contra el S/4 de QA). El stock aporta ~1.8 s. Las dos lecturas van en
paralelo y **una sola vez** por corrida, antes de lotear los productos de a 100, así que el costo
es fijo y no escala con la cantidad de productos.

Si ese tiempo molesta, la palanca es filtrar por `ShelfLifeExpirationDate ge <hoy>` en
`S4BatchResolver`: baja a 21,397 filas (~90 s). **El costo de esa palanca es perder
`cantidad_vencida`**, que es justamente la señal de la sección 3. Es una decisión de negocio, no
de performance.

---

## 5. Verificación end-to-end

### 5.1 Lectura contra SAP — EJECUTADO el 2026-08-13

Con la VPN del cliente arriba se confirmó que los datos que asume el diseño siguen vigentes.

**Stock del material `10000289` (ANHIDRIDO FTALICO):**

```bash
curl -s -k -u 'smarteam:Multiquimica.600' "https://vhmldqs4ci.hec.multidomsa.com:44300/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod?sap-client=600&\$format=json&\$select=Material,Plant,StorageLocation,Batch,InventoryStockType,MatlWrhsStkQtyInMatlBaseUnit&\$filter=Material%20eq%20'10000289'%20and%20MatlWrhsStkQtyInMatlBaseUnit%20gt%200"
```

Resultado — 5 filas, exactamente las que asume el spec:

```
DPDO/0001  lote 17131  tipo 01  =     200.000
DPDO/0108  lote 17131  tipo 01  =   6,000.000
DPDO/0001  lote 17141  tipo 01  =   8,600.000
DPDO/0201  lote 17141  tipo 01  =   1,054.000
MQDO/0108  lote 24J1   tipo 01  =  19,000.000
```

**Maestro de lotes del mismo material:**

```bash
curl -s -k -u 'smarteam:Multiquimica.600' "https://vhmldqs4ci.hec.multidomsa.com:44300/sap/opu/odata/sap/API_BATCH_SRV/Batch?sap-client=600&\$format=json&\$select=Material,Batch,BatchIdentifyingPlant,ShelfLifeExpirationDate,ManufactureDate&\$filter=Material%20eq%20'10000289'"
```

Resultado — 87 lotes, **`BatchIdentifyingPlant` vacío en todos**: la suposición de que el lote es
único a nivel material (y por lo tanto que el join `Material + Batch` no necesita centro) sigue
en pie. Los tres lotes que importan:

| Lote | `ShelfLifeExpirationDate` | Estado al 2026-08-13 |
|---|---|---|
| `17131` | 2026-07-16 | **vencido** hace 28 días |
| `17141` | 2026-08-02 | **vencido** hace 11 días |
| `24J1` | 2027-03-23 | vigente, +222 días (fuera del horizonte de 90) |

### 5.2 Caso de verificación en HubSpot

> **Corrección respecto del plan.** Una versión anterior de esta verificación proponía
> `warehouses: ["DPDO/*"]` y esperaba un `lotes_detalle` de dos líneas con
> `fecha_vencimiento_proxima` poblada. **Esa expectativa se escribió a partir de las fechas del
> fixture de los tests unitarios y hoy es falsa**: contra los datos reales, los dos lotes de DPDO
> ya están vencidos, así que con `includeExpired: false` esa configuración produce un
> `lotes_detalle` **vacío** y una `fecha_vencimiento_proxima` **vacía**. Es el comportamiento
> correcto, pero leído contra la expectativa vieja parece un bug. Usar el caso de abajo.

Con la config de la sección 2 tal cual (`warehouses: []`, `stockTypes: ["01"]`,
`includeExpired: false`, `horizonDays: 90`), el producto `10000289` debe quedar así:

| Propiedad | Valor esperado |
|---|---|
| `lotes_detalle` | `24J1 · vence 2027-03-23 · 19,000.000 · MQDO/0108` — **una sola línea** |
| `lote_proximo_vencer` | `24J1` |
| `fecha_vencimiento_proxima` | `2027-03-23` |
| `dias_para_vencer` | `222` |
| `lotes_vigentes` | `1` |
| `cantidad_por_vencer` | `0` |
| `cantidad_vencida` | `15854` |

**Por qué este caso es un buen control:** ejercita las dos reglas más fáciles de romper, y las
ejercita en direcciones opuestas.

1. Los lotes `17131` y `17141` están **ausentes** de `lotes_detalle` (porque `includeExpired` es
   `false`) y sin embargo **contados enteros** en `cantidad_vencida`: 6,200 de `17131` (200 de
   DPDO/0001 + 6,000 de DPDO/0108, consolidados según D7) más 9,654 de `17141` (8,600 de
   DPDO/0001 + 1,054 de DPDO/0201) = **15,854**. Si `cantidad_vencida` sale en 0, el filtro de
   visibilidad se está aplicando antes del agregado y D6 está roto.
2. `fecha_vencimiento_proxima` **salta por encima** de los dos vencidos y aterriza en `24J1`. Si
   saliera `2026-07-16`, el "próximo a vencer" estaría tomando el mínimo absoluto y D5 está roto
   — que es exactamente la falla que dejaría el campo inservible en un tenant donde el 39% del
   stock está vencido.
3. `cantidad_por_vencer` en **0** con `lotes_vigentes` en **1** confirma que `horizonDays` separa
   "vigente" de "por vencer": `24J1` vence en 222 días, muy fuera de la ventana de 90.

> **Todos esos valores dependen de la fecha de la corrida.** El estado de un lote se calcula
> contra el `now` del run, así que estos literales caducan solos: `24J1` entra en la ventana de
> 90 días alrededor del **2026-12-23**, y a partir del **2027-03-24** pasa a vencido y el producto
> queda con `lotes_detalle` vacío. Quien verifique después de esas fechas **debe recalcular** con
> los dos `curl` de la sección 5.1 en vez de confiar en la tabla.

Confirmar además que `fecha_vencimiento_proxima` se ve **como fecha** en la UI de HubSpot y no
como texto.

### 5.3 Checklist pendiente de ejecución humana

> **NADA DE ESTA SECCIÓN SE EJECUTÓ.** No hay tenant de Multiquímica aprovisionado en el Mongo
> productivo ni servidor corriendo, así que estos pasos son imposibles de correr hoy. Ejecutarlos
> **después** del aprovisionamiento (sección 0), en este orden.

- [ ] **A. Sync acotado.** Dejar **solo** `Obtener Productos S4` con `active: true` y ponerle un
      filtro acotado con `PATCH /client-configs/:id`:

      ```json
      {"filters":[{"property":"Product","operator":"eq","value":"10000289"}]}
      ```

      Lanzar:

      ```bash
      curl -X POST http://localhost:3000/sap-sync/run -H 'Content-Type: application/json' -d '{"tenantID":"<tenantKey>"}'
      ```

      En el log debe verse **una sola** llamada al maestro de lotes y el conteo de filas
      indexadas. Si aparece más de una, el fetch se metió dentro del loop de productos.

- [ ] **B. Revisar el resultado en HubSpot.** Contrastar el producto `10000289` contra la tabla
      de la sección 5.2, recalculando antes si la fecha de la corrida ya no es cercana al
      2026-08-13. Verificar también que `fecha_vencimiento_proxima` se muestre como fecha, no
      como texto.

- [ ] **C. Producto sin lotes.** Buscar en HubSpot un producto con
      `IsBatchManagementRequired = false` y confirmar que las siete propiedades están **vacías**,
      no en cero (D10).

- [ ] **D. Idempotencia.** Relanzar el mismo `POST /sap-sync/run` sin cambiar nada. Esperado:
      el `SyncLog` reporta `skipped ≈ total`. Si `updated` sigue alto, la causa es el formato de
      alguna propiedad — típicamente el redondeo o el separador de miles — no el contenido.

- [ ] **E. Regresión B1.** Correr el sync de productos de un tenant B1 existente (amc, distelsa,
      noelito o printer). Esperado: el stock por bodega sale idéntico a antes, **ninguna**
      propiedad de lote se creó ni se escribió, y el log no muestra ni una llamada a
      `API_BATCH_SRV`.

- [ ] **F. Corrida completa.** Quitar el filtro de ensayo y correr el full. Contar con los ~5.3
      min extra de la sección 4.
