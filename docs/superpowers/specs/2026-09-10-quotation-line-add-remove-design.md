# Alta, baja y actualización completa de líneas en `updateQuotation`

Tenant que lo motiva: `sap_integration_distelsa` (portal 50373731, CompanyDB `SBO_DISTELSA_PROD`).

## Problema

`updateQuotation` sólo sabe **actualizar** líneas que ya existen en SAP. Una línea que el asesor
agrega en HubSpot se descarta con un `logger.warn` y una que elimina se queda viva en SAP, y en
los dos casos el evento termina en `status: 'completed'` sin `lastError`.

El descarte está en [order-builder.service.js:673-683](../../../src/domain/orders/order-builder.service.js):
`resolveQuotationLinkLine` no encuentra `LineNum` para el line item y el bucle hace `continue`.

Evidencia de producción (colección `WebhookEvents` del tenant, últimos 12 `updateQuotation`):

```
2026-09-10T15:51:47  deal=64877257581  HS=5  PATCH=4   <-- perdió 1
2026-09-08T16:46:42  deal=64736679461  HS=9  PATCH=8   <-- perdió 1
```

Caso reconstruido de la 51802 (`DocEntry 55939`): el `SapDocumentLink` tenía 4 líneas, el evento
trajo 5 line items, 4 hicieron match por `hubspotProductId` y `102-2260` se descartó. GET en vivo
confirma que SAP sigue con **4 líneas** mientras HubSpot tiene **7**.

Agravante estructural: HubSpot **recrea** los line items en cada edición de la tabla de elementos
de pedido. Para el mismo negocio se observaron tres juegos de ids (`58871020071-074` →
`58871159880-884` → `58871161722-727`), así que `hubspotLineItemId` nunca hace match y el matcher
siempre cae al fallback por product id o SKU.

Y una consecuencia de segundo orden: `buildOrderFromQuotationPayload` arma las `DocumentLines` de
la orden desde `link.lines`, no desde el payload
([order-builder.service.js:534](../../../src/domain/orders/order-builder.service.js) y
[:496](../../../src/domain/orders/order-builder.service.js)). Si el PATCH agrega líneas en SAP
pero el link no las registra, la conversión a orden las omite.

## Semántica de SAP, medida

El Service Layer **no expone las líneas de documento como entidad direccionable**: no hay `DELETE`.
La única vía para eliminar es el header `B1S-ReplaceCollectionsOnPatch: true`.

Todo lo que sigue se midió contra `SBO_DISTELSA_PROD` (Service Layer `Version 1000260`, SAP B1
10.0) sobre una cotización desechable creada para la prueba (`DocEntry 55949 / DocNum 51811`).
**No está documentado por SAP en estos términos; son observaciones empíricas.**

Con el header puesto y `LineNum` **explícito** en cada entrada del body:

| Situación | Comportamiento de SAP |
|---|---|
| `LineNum` existente **presente** en el body | Actualiza esa fila por `LineNum` y **conserva los campos que el body no trae** |
| `LineNum` existente **ausente** del body | **Elimina** la fila |
| `LineNum` nuevo | **Agrega** la fila |
| Entrada **sin** `LineNum` | ⚠️ merge **posicional**: sobreescribe la fila que ocupa ese índice |

Hallazgos que condicionan el diseño:

1. **Agregar no necesita el header.** Un merge PATCH con `LineNum: 4` sobre un documento de 4
   líneas agregó la quinta, y SAP resolvió `WarehouseCode: '01'` y `TaxCode: 'IVA'` por su cuenta.
2. **Los campos no enviados se conservan.** Se sembró `FreeText: 'EDITADO A MANO EN SAP'` en una
   línea y sobrevivió a un replace PATCH que no lo mandaba. **No hace falta echo-back.**
3. **Los `LineNum` son estables.** Borrando las del medio y conservando 0 y 3, los sobrevivientes
   quedaron como `LineNum` **0 y 3**, con hueco. `VisualOrder` sí se recompacta (0 y 1). O sea:
   `LineNum` es identidad de fila, `VisualOrder` es presentación.
4. **El header sólo afecta las colecciones presentes en el body.** `DocumentSpecialLines`
   sobrevivió intacta a un replace de `DocumentLines`. Esto elimina el riesgo para tenants que
   mapean `DocumentSpecialLines` (printer).
5. **`ItemDescription` propia se respeta**, no la sobreescribe la del artículo maestro. Sin
   `WarehouseCode`, SAP resuelve el almacén por defecto.

### Las dos trampas

**Una entrada sin `LineNum` pisa la fila 0.** Un merge PATCH con
`[{ItemCode:'102-2758', Quantity:1}]` reemplazó el `ItemCode` de la línea 0 (era `103-9999`). Hoy
`buildQuotationLineUpdates` siempre emite `LineNum`, así que el código actual está a salvo; el
código nuevo **nunca** puede emitir una entrada sin él.

**Con merge posicional los campos se cruzan entre artículos.** Enviando las mismas 3 líneas
reordenadas y sin `LineNum`, el `FreeText` de `103-1153` terminó pegado a `103-9999`: se quedó en
la posición 1 mientras el `ItemCode` cambiaba. Es corrupción silenciosa, sin error de SAP. Por eso
`LineNum` explícito es obligatorio, no una optimización.

## Objetivo

Que `updateQuotation` sincronice las líneas de la oferta de SAP con las de HubSpot: **agregar** las
nuevas, **eliminar** las que el asesor quitó, y **actualizar** todos los campos mapeados de las que
quedan. Sin cambiar ningún otro comportamiento de `createQuotation`, `updateQuotation` ni
`convertQuotationToOrder`.

## Decisiones tomadas

1. **`B1S-ReplaceCollectionsOnPatch: true` con `LineNum` explícito en todas las entradas.** Es la
   única semántica que permite eliminar y que, a la vez, deja el comportamiento de las líneas
   existentes idéntico al de hoy (merge por `LineNum`, campos no enviados preservados).
2. **Sin flag por tenant.** Se descartó el `quotationLineSyncMode` que se había planteado: al ser
   merge por `LineNum` y no afectar otras colecciones (hallazgos 2 y 4), no hay cambio de
   comportamiento que aislar. Un flag agregaría un camino sin probar y una configuración más que
   auditar por tenant.
3. **Sin echo-back.** Se descartó por el hallazgo 2. Reenviar ~200 campos por línea era el riesgo
   principal del diseño anterior y resultó innecesario.
4. **Altas con `LineNum = max(LineNum existente) + 1`**, no `length`: por el hallazgo 3 los huecos
   existen, y `length` colisionaría con una fila viva.
5. **`link.lines` se reescribe releyendo la cotización** después del PATCH, en vez de mutarse con
   `applyLineUpdatesToLink`. Es lo que mantiene sana la conversión a orden.
6. **Fallar visible.** Una línea del payload que no se puede sincronizar deja de ser un `warn` y
   pasa a ser error del evento.
7. **Vaciar un campo mapeado en HubSpot lo vacía en SAP** (ver la sección siguiente).
8. **No se reordenan las líneas existentes.** Ver *Fuera de alcance*.

## Actualización de todos los campos mapeados

Lo que ya funciona hoy en el PATCH, por línea que hace match
([order-builder.service.js:697-724](../../../src/domain/orders/order-builder.service.js)):

- todos los mapeos de contexto `product/orders-quotations`, vía
  `pickMappedLineFields(mapHubspotToSapFields(lineItem, lineMappings))`
- `Quantity`, `UnitPrice`, `DiscountPercent`, `WarehouseCode`, `TaxCode`, con su coerción propia

`RESERVED_LINE_FIELDS` ([:166](../../../src/domain/orders/order-builder.service.js)) excluye del
derrame genérico `ItemCode`, `Quantity`, `UnitPrice`, `WarehouseCode`, `DiscountPercent`, `TaxCode`,
`LineNum`, `BaseType`, `BaseEntry` y `BaseLine`, pero esos seis primeros el builder los resuelve él
mismo desde los campos canónicos del payload, así que **igual viajan**. Para distelsa eso cubre su
único mapeo de línea (`ItemDescription → item_description`) y cubrirá cualquiera que agregue después.

Los numéricos **sí** se limpian hoy: `normalizeNumber(null, null)` devuelve `0`, porque
`Number(null)` es `0` y `Number.isFinite(0)` es `true`
([string.utils.js:6](../../../src/shared/utils/string.utils.js)). Un `hs_discount_percentage: null`
manda `DiscountPercent: 0`.

**El agujero está en los campos de texto.** `mapHubspotToSapFields` no produce clave cuando el
valor es `null`, `undefined`, string en blanco o el texto `"null"`/`"undefined"`
([:33-67](../../../src/domain/orders/order-builder.service.js)). Con merge por `LineNum`, la clave
ausente hace que SAP **conserve el valor anterior**: si el asesor escribe una descripción y después
la borra, SAP se queda con la vieja para siempre.

**Decisión (7):** distinguir *propiedad ausente del payload* de *propiedad presente y vacía*.

- clave **ausente** en el line item → se omite del PATCH (comportamiento actual)
- clave **presente con valor vacío** → viaja como `''` para limpiar el campo en SAP

Los workflows de distelsa serializan cada propiedad con `?? null`, así que en la práctica todas
están presentes y HubSpot queda como fuente de verdad de los campos de línea mapeados. Eso es lo
pedido, pero **es un cambio de comportamiento**: un campo de línea corregido a mano en SAP que
esté vacío en HubSpot pasa a limpiarse en el siguiente update.

El cambio se acota deliberadamente a: **campos de línea**, **sólo en el flujo de update**. No toca
la cabecera (donde el comentario de
[ProcessHubspotUpdateQuotation.js:110-116](../../../src/application/use-cases/ProcessHubspotUpdateQuotation.js)
documenta que la omisión protege correcciones manuales) ni la creación.

## Componentes

### 1. `sapServiceLayerWebhookRequest` — sin cambios

Ya acepta y propaga `headers`
([sapServiceLayerWebhookRequest.js:13](../../../src/infrastructure/sap/sapServiceLayerWebhookRequest.js) y
[:29](../../../src/infrastructure/sap/sapServiceLayerWebhookRequest.js)). No hay que tocar el
transporte.

### 2. `SapWebhookQuotationAdapter.updateQuotation` — nueva opción

[SapWebhookQuotationAdapter.js:23](../../../src/infrastructure/sap/SapWebhookQuotationAdapter.js)

Acepta `replaceCollections` y, cuando es `true`, agrega `B1S-ReplaceCollectionsOnPatch: 'true'`.
El default es `false` para que ningún otro llamador cambie de comportamiento.

### 3. `buildQuotationLineUpdates` — emite altas y limpia texto

[order-builder.service.js:665](../../../src/domain/orders/order-builder.service.js)

- El `continue` del no-match se reemplaza por la construcción de una línea nueva: `ItemCode`
  resuelto igual que en `mapDocumentLines` ([:365](../../../src/domain/orders/order-builder.service.js)),
  `Quantity` validada `> 0`, y `LineNum = nextLineNum++` arrancando en
  `max(sapLineNum de link.lines) + 1`.
- La línea nueva necesita `ItemCode`; si no se resuelve, `PermanentWebhookError` en vez de `warn`.
- Toda entrada lleva `LineNum`, sin excepción (trampa 1).
- El `PermanentWebhookError('No matching quotation lines found to update')` de
  [:721](../../../src/domain/orders/order-builder.service.js) sigue vigente, pero ahora sólo salta
  si el payload viene sin líneas: con altas ya no es alcanzable por falta de match.

### 4. `resolveQuotationLinkLine` — sin cambios

[order-builder.service.js:607](../../../src/domain/orders/order-builder.service.js). Sigue
resolviendo el `LineNum` de las líneas que ya existen, y la sigue usando `resolveBaseLineOverrides`
para la conversión a orden. **No borrar.**

### 5. `ProcessHubspotUpdateQuotation` — validar, patchear con el header, releer

[ProcessHubspotUpdateQuotation.js](../../../src/application/use-cases/ProcessHubspotUpdateQuotation.js)

- **Usar la respuesta del GET que hoy se descarta** ([:88](../../../src/application/use-cases/ProcessHubspotUpdateQuotation.js)):
  hoy se llama a `getQuotation` sin asignar el resultado, sólo para validar que existe. Ahora se
  lee `DocumentStatus` y el `LineStatus` de cada línea, y se aborta con `PermanentWebhookError`
  descriptivo si la oferta no está abierta o alguna línea ya tiene documento derivado. Sin esto,
  SAP rechaza el PATCH y el síntoma no apunta al estado del documento.
- El GET además aporta los `LineNum` reales, que es la fuente correcta de `max + 1` — más confiable
  que `link.lines`, que puede haber quedado desincronizado por los descuadres ya ocurridos.
- `updateQuotation` se invoca con `replaceCollections: true`.
- **`applyLineUpdatesToLink` se elimina** ([:13](../../../src/application/use-cases/ProcessHubspotUpdateQuotation.js)):
  sólo sabe mutar entradas existentes. Se reemplaza por un segundo GET después del PATCH que
  reconstruye `link.lines` desde el estado real de SAP (`sapLineNum`, `sku`), cruzado con el
  payload para recuperar `hubspotLineItemId` y `hubspotProductId` por SKU.
- El ancla de `DocumentSpecialLines` usa `link.lines.length`
  ([:130](../../../src/application/use-cases/ProcessHubspotUpdateQuotation.js)); pasa a usar la
  cantidad de líneas del GET, que es la real cuando el link está desincronizado.

### 6. `MongooseSapDocumentLinkRepository.updateLines` — sin cambios

[MongooseSapDocumentLinkRepository.js:46](../../../src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js).
Ya reemplaza el array completo.

### 7. `mapDocumentLines` — sin cambios

[order-builder.service.js:365](../../../src/domain/orders/order-builder.service.js). La creación no
se toca.

## Lo que no cambia

- `createQuotation` y `convertQuotationToOrder`, en ningún aspecto.
- El comportamiento del PATCH sobre las líneas que ya existían: mismos campos, misma coerción,
  mismos campos preservados (salvo la decisión 7 sobre texto vacío).
- `IMMUTABLE_ON_PATCH_FIELDS` y `RESERVED_HEADER_FIELDS`
  ([:161](../../../src/domain/orders/order-builder.service.js) y
  [:70](../../../src/domain/orders/order-builder.service.js)).
- El dedup: `updateQuotation` sigue fuera de la lista de eventos deduplicados
  ([webhookEvent.service.js:12](../../../src/infrastructure/webhook/webhookEvent.service.js)).
- Los otros tres tenants (amc, noelito, printer). Ninguno usa `updateQuotation` hoy, y el hallazgo
  4 descarta el riesgo de `DocumentSpecialLines` de printer.

## Manejo de errores

| Caso | Comportamiento |
|---|---|
| Oferta no `bost_Open` | `PermanentWebhookError` nombrando el `DocumentStatus` |
| Línea con documento derivado | `PermanentWebhookError` nombrando el `LineNum` y su `LineStatus` |
| Line item nuevo sin `ItemCode`/`hs_sku` resoluble | `PermanentWebhookError` (hoy: `warn` silencioso) |
| Payload sin líneas | `PermanentWebhookError` (ya existe) |
| PATCH rechazado por SAP | Sube tal cual; queda en `sapAudit.sapCalls` con el body enviado |

El `sapAudit` ya captura request y response de cada llamada, así que el body del PATCH con el
header queda auditado sin trabajo extra.

## Testing

Baseline conocido: **178 suites, 5 rojas preexistentes**. Comando (el `npm test` del
`package.json` falla en Windows porque el prefijo `NODE_OPTIONS=` lo interpreta `cmd.exe`):

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/quotationBuilder.test.js tests/unit/application/processQuotationFlows.test.js
```

Unitarios en [tests/unit/domain/quotationBuilder.test.js:322](../../../tests/unit/domain/quotationBuilder.test.js)
(`describe('order-builder.service buildQuotationLineUpdates')`):

1. Un line item sin match emite una línea nueva con `LineNum = max + 1` y su `ItemCode`.
2. Con `link.lines` de `sapLineNum` `[0, 3]`, el alta sale con `LineNum: 4` — **no** `2`.
3. Toda entrada emitida tiene `LineNum` (guard contra la trampa 1).
4. Un line item nuevo sin `hs_sku` tira `PermanentWebhookError`, no un `warn`.
5. Los mapeos de línea se derraman en la línea nueva igual que en la existente.
6. Una propiedad mapeada presente y vacía viaja como `''`; ausente no viaja (decisión 7).

De flujo en [tests/unit/application/processQuotationFlows.test.js:601](../../../tests/unit/application/processQuotationFlows.test.js):

7. `updateQuotation` se llama con `replaceCollections: true`.
8. Una línea de `link.lines` que ningún line item reclama **no** aparece en el `patchPayload`.
9. `updateLines` se llama con el array reconstruido desde el GET posterior, no con el mutado.
10. Oferta `bost_Close` → `PermanentWebhookError` y `updateQuotation` no se invoca.
11. El adapter mockeado devuelve `LineNum` con hueco y `link.lines` queda con esos `LineNum`.

Los mocks del adapter deben devolver `DocumentLines` con `LineNum`, `ItemCode` y `LineStatus`: un
resolver mockeado que devuelva `{}` esconde justamente la costura que este cambio introduce.

## Verificación

1. Los 11 tests de arriba en verde, y las 178 suites sin rojas nuevas.
2. `POST /sap-sync/run` con sólo la config a probar activa, sobre una oferta de prueba:
   - agregar una línea en HubSpot → aparece en SAP al final
   - quitar una línea → desaparece de SAP
   - cambiar cantidad, precio, descuento y "Nueva Descrpción" → los cuatro llegan
   - borrar la "Nueva Descrpción" → se limpia en SAP
   - convertir a orden después → la orden trae exactamente las líneas vivas
3. `SapDocumentLinks.lines` del deal coincide con las `DocumentLines` de SAP (`sapLineNum` incluido).
4. Ningún `WebhookEvent` en `completed` con `payload.line_items.length` distinto de las líneas del
   documento en SAP.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Reemplazo total sin `LineNum`** (el diseño previo a medir SAP) | El merge es posicional: reordenar cruza campos entre artículos, en silencio. Fue el hallazgo que obligó a rehacer el diseño |
| **Echo-back del estado de SAP** para preservar ediciones manuales | Innecesario: el hallazgo 2 demuestra que el merge por `LineNum` ya las preserva. Habría metido una whitelist de ~200 campos que mantener |
| **Convergencia de `update` sobre `mapDocumentLines`** | Cambiaría el comportamiento de las líneas existentes, contra el requisito de "mantener todo tal cual" |
| **Flag `quotationLineSyncMode` por tenant** | Aísla un cambio que, medido, no existe (hallazgos 2 y 4). Sería un camino sin probar más una config por auditar |
| **Cancelar la oferta y crear una nueva** | Cambia el `DocNum`, que el asesor ya le dio al cliente final, y rompe el `SapDocumentLink` |
| **`DELETE` de líneas individuales** | El Service Layer no expone las líneas como entidad direccionable. No existe |
| **`Quantity: 0` o `LineStatus: 'bost_Close'` para "eliminar"** | Deja la línea visible en la oferta impresa; no es lo que pidió el cliente |
| **Sólo agregar, y reportar las eliminadas como error** | Es la mitad del pedido |

## Fuera de alcance

- **Reordenar líneas existentes en el update.** Exigiría reasignar `LineNum`, que es exactamente el
  escenario de la trampa 2. Las altas quedan al final del documento, no en la posición donde el
  asesor las insertó. El orden correcto en la **creación** se resuelve en el workflow de HubSpot,
  ordenando `line_items` por `hs_position_on_quote` antes de armar el payload.
- **Paginación de `/crm/v4/objects/deals/{id}/associations/line_items` en los workflows.** No leen
  `paging.next`. El máximo del endpoint es 500 por página (medido: `limit=501` responde
  `400 Limit must be between 0 and 500`) y el máximo histórico del tenant es 11 líneas por evento,
  así que no muerde hoy. Queda como deuda: con eliminación activa, una página perdida **borraría**
  líneas de SAP.
- **El trigger de los workflows.** Se comprobó que agregar line items a las 15:55:45 y 15:58:41 no
  generó ningún `WebhookEvent` (el último es de 15:51:47). Sin re-enrollment al agregar o quitar
  líneas, este cambio no se ejecuta nunca. Lo resuelve el cliente en HubSpot.
- **Oferta con orden derivada.** No se pudo medir sin crear una orden en producción. Por eso el
  componente 5 valida el estado antes de intentar el PATCH en vez de asumir.
- **`item_description` y `hs_position_on_quote` en el cuerpo de los workflows**, y
  `hs_discount_percentage` en el de `createQuotation` (hoy ausente: 0 de 74 creaciones han mandado
  un descuento a SAP). Todo del lado de HubSpot.
