# Área de ventas y lista de precios desde el negocio (S/4) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el negocio de HubSpot declare la organización de ventas y el canal de distribución, y que el webhook de precios de S/4 use esos dos campos para leer **una sola** fila de `A_CustomerSalesArea` y con ella la lista de precios del cliente — en vez de deducir el área de las que el cliente tenga y desempatar por config.

**Architecture:** El área deja de resolverse por deducción y pasa a ser un dato de entrada. El payload adapter lee tres propiedades más del deal (`sales_organization`, `distribution_channel`, `deal_currency_code`) y las pasa al caso de uso; el cliente de SAP filtra el área en el `$filter` en vez de traer todas; y la moneda del negocio entra al dominio como criterio de desempate y como guardia. El flujo B1 no se toca en ningún archivo.

**Tech Stack:** Node 24 ESM, Fastify, Mongoose multi-tenant, axios, Jest con `--experimental-vm-modules`. OData v2 de SAP Gateway sobre el `S4GatewayTransport` existente.

**Spec:** [docs/superpowers/specs/2026-08-24-s4-price-list-sales-area-from-deal-design.md](../specs/2026-08-24-s4-price-list-sales-area-from-deal-design.md)

**Spec anterior (contexto, no se re-implementa):** [docs/superpowers/specs/2026-08-18-s4-price-list-line-item-webhook-design.md](../specs/2026-08-18-s4-price-list-line-item-webhook-design.md)

## Global Constraints

- **Trabajar en el checkout principal, NUNCA en un worktree.** Un worktree nace del último commit y deja fuera los archivos sin commitear — este plan arranca sobre cambios que pueden no estar commiteados todavía (ver "Punto de partida"), así que un worktree daría un diagnóstico falso.
- **No commitear por iniciativa propia.** Los commits los decide el usuario. El paso final de cada tarea es un punto de corte para revisión.
- **No tocar el flujo B1.** Prohibido modificar `SapLineItemPriceClient.js`, `SyncLineItemPrices.js`, `SyncDealLineItemPricesByPriceList.js`, `lineItemPriceWebhook.service.js`, `dealPriceListLineItemPriceWebhook.service.js`, `LineItemPriceWebhookPayloadAdapter.js`, `line-item-price-strategy.factory.js` ni `line-item-price-strategy.constants.js`. Se leen como referencia; no se editan.
- **`lineItemPriceWebhook.shared.js` es COMPARTIDO con B1.** `fetchHubspotObject` y `readLineItems` los usan los dos flujos. Los cambios de este plan no lo tocan: las propiedades nuevas se piden desde el llamador de S/4, que ya pasa `properties` por parámetro ([lineItemPriceWebhook.shared.js:63](../../../src/infrastructure/webhook/lineItemPriceWebhook.shared.js)).
- **Correr jest con path explícito**, nunca la suite completa desde la raíz. Bash: `NODE_OPTIONS=--experimental-vm-modules npx jest <path>`. PowerShell: `$env:NODE_OPTIONS='--experimental-vm-modules'; npx jest <path>`. Para correr la suite entera hace falta excluir los worktrees: `npx jest --testPathIgnorePatterns=".claude\\\\worktrees"` (el patrón va con backslashes escapados: las rutas en Windows no llevan `/` y un patrón con `/` no matchea nunca).
- **Baseline de la suite: 5 suites rojas preexistentes** (`lineItemPriceWebhook.service.test.js`, `application/sendMappedItemsToHubspot.test.js`, `serviceLayerFlow.test.js`, `serviceLayerService.test.js`, `integration/internalTenant.test.js`), 10 tests. No son de este trabajo. Verificado con `git stash` el 2026-08-24: mismos 5 con y sin los cambios.
- **Fechas en las fixtures: ISO, no `/Date(ms)/`.** El `S4GatewayTransport` normaliza `/Date(1769126400000)/` a `2026-01-23T00:00:00.000Z` antes de devolver los datos ([odataV2Normalizer.js](../../../src/infrastructure/sap/transport/odataV2Normalizer.js)). Las fixtures imitan la salida del transporte, no la del sistema remoto.
- **Filtros OData: `$filter` va pre-encodeado, `$select` va crudo.** El transporte pasa los valores del query tal cual ([S4GatewayTransport.js:19](../../../src/infrastructure/sap/transport/S4GatewayTransport.js), `buildQueryString`).
- **El audit se construye con `buildLineItemPriceAudit`**, nunca a mano. El `$set` sobre el `WebhookEvent` va contra un Mongo anterior a la 5.0 y una sola clave con `$` al inicio tira la escritura completa, arrastrando el `errorMessage` que viaja en la misma operación.
- **Verificar el cableado en `composition` por grep del nombre exacto.** En este repo ya pasó tres veces que un parámetro del constructor quedara sin cablear con la suite entera en verde. `expect.any(Object)` no lo detecta.
- **Valores verificados en vivo el 2026-08-24** contra el S/4 de Multiquímica. Usar estos en las fixtures:
  - `A_CustomerSalesArea`: 8974 filas, `Division` = `SC` en todas, cero clientes con dos filas en el mismo org/canal.
  - BP `100061` (CARY INDUSTRIAL, SA): `CPDO/01→ZD`, `DPDO/01→ZC`, `GPDO/01→ZD`, `MQDO/01→ZD`, `TMDO/01→ZC`.
  - BP `111667` (ABINCO, S.A.): sólo `MQGT/01→ZA`.
  - Material `10000453` en DPDO/01: ZC = 1.95 USD/KG (registro `0000111922`), ZD = 2.05 USD/KG (registro `0000111924`), las dos vigentes.
  - Material `10000003` en MQGT/01: 7.02 USD/KG en ZA (registro `0000435840`).
  - MKDO/01 tiene 97 combinaciones material+lista con default de producto en USD **y** en DOP.

## Punto de partida

Antes de la Tarea 1, confirmar el estado del árbol:

```bash
git status --short
```

Este plan asume que ya están aplicados los dos cambios del 2026-08-24 que preceden al spec (commiteados o no):

1. **Notas en el deal** — `src/domain/prices/lineItemPriceNote.service.js`, `src/infrastructure/hubspot/lineItemPriceNoteNotifier.service.js`, cableado en `s4-line-item-prices.composition.js`, y `notifyLineItemPriceOutcome` obligatorio en el constructor del caso de uso. **Se conserva y se extiende.**
2. **Fallback al área de config cuando el cliente no tiene ninguna** — `SALES_AREA_SOURCES` y la rama `rows.length === 0` de `chooseSalesAreaRow`. **Este plan lo RETIRA** (Tarea 5).

Si no están, detenerse y avisar: el plan no aplica sobre el árbol anterior.

## Estructura de archivos

| Archivo | Responsabilidad | Tarea |
|---|---|---|
| `src/domain/prices/s4-price-resolution.service.js` (modificar) | Suma `dealCurrency`: desempate entre candidatos y guardia de moneda. | 1 |
| `src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js` (modificar) | `resolveS4PriceListConfig` gana `defaultPriceListBySalesArea` y pierde `salesArea`. | 2 |
| `src/infrastructure/sap/S4PriceListClient.js` (modificar) | `fetchCustomerSalesAreas` acepta org y canal y los filtra en SAP. | 3 |
| `src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js` (modificar) | Lee las tres propiedades del deal y las pasa en el payload. | 4 |
| `src/application/use-cases/SyncS4LineItemPricesByPriceList.js` (modificar) | Área desde el payload, los tres casos, escritura de ceros, retiro del fallback de config. | 5 |
| `src/domain/prices/lineItemPriceNote.service.js` (modificar) | Dos motivos nuevos de nota: área inexistente y campos faltantes. | 6 |
| `configuration_examples.md` (modificar) | Documenta `defaultPriceListBySalesArea` y retira `salesArea`. | 7 |
| `.superpowers/sdd/2026-08-24-sales-area-from-deal/verificar-en-vivo.mjs` (crear, git-ignored) | Verificación read-only contra el S/4 real. | 8 |

---

### Task 1: Dominio — `dealCurrency` como desempate y como guardia

**Files:**
- Modify: `src/domain/prices/s4-price-resolution.service.js`
- Test: `tests/unit/domain/s4PriceResolution.test.js` (existe, se le agregan casos)

**Interfaces:**

- `resolveS4PriceForMaterial({ candidates, customerPriceListType, defaultPriceListType, dealCurrency = null })`
- Devuelve lo mismo que hoy, más un campo: `{ price, currency, priceListType, conditionRecord, conditionQuantityUnit, source, currencyMismatch }`
- `currencyMismatch: boolean` — `true` cuando el candidato elegido tiene una moneda distinta a `dealCurrency`. Con `dealCurrency` en `null` es siempre `false`.
- El texto del motivo NO se arma acá: lo arma el caso de uso, que es quien conoce el contexto de la línea.

**Reglas exactas:**

1. `isUsable` y las tablas no cambian.
2. `pickByPriceList` y `pickProductDefault` dejan de usar `find` sobre el arreglo crudo. Antes de elegir, los candidatos elegibles de ese paso se ordenan con este comparador estable:
   - primero los que tienen `conditionCurrency === dealCurrency` (sólo si `dealCurrency` no es null);
   - a igualdad, por `conditionRecord` ascendente como string.
   Ese orden es lo que hace el resultado reproducible: hoy gana el que Gateway devuelva primero.
3. `pickProductDefault` mantiene la prioridad de tablas (501 antes que 504) **por encima** del desempate por moneda: el orden de las tablas es una decisión tomada, la moneda desempata dentro de una tabla.
4. `currencyMismatch` se calcula al final, sobre el candidato ganador: `Boolean(dealCurrency) && candidateCurrency !== dealCurrency`. La comparación es sobre el valor ya normalizado con `toNonEmptyString`, sin `toUpperCase` — SAP devuelve los códigos ISO en mayúsculas y el adapter ya normaliza el de HubSpot.
5. **No** se descarta ningún candidato por moneda. El dominio informa; quien decide saltear la línea es el caso de uso. Descartar acá haría que un material con su única tarifa en otra moneda cayera al default del producto y se escribiera un precio de otra lista, que es peor.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/unit/domain/s4PriceResolution.test.js`:

```js
describe('resolveS4PriceForMaterial con dealCurrency', () => {
  // Los 97 casos de MKDO/01: mismo material, default de producto en dos monedas.
  const dosMonedas = [
    candidate({ conditionRecord: '0000200002', conditionTable: '501', priceListType: null, conditionRateValue: 120, conditionCurrency: 'DOP' }),
    candidate({ conditionRecord: '0000200001', conditionTable: '501', priceListType: null, conditionRateValue: 2, conditionCurrency: 'USD' }),
  ];

  it('elige el candidato en la moneda del negocio', () => {
    const result = resolveS4PriceForMaterial({
      candidates: dosMonedas, customerPriceListType: null, defaultPriceListType: 'ZC', dealCurrency: 'DOP',
    });

    expect(result).toMatchObject({ price: 120, currency: 'DOP', conditionRecord: '0000200002', currencyMismatch: false });
  });

  it('es reproducible cuando ninguna moneda coincide: gana el conditionRecord menor', () => {
    const enOrden = resolveS4PriceForMaterial({ candidates: dosMonedas, defaultPriceListType: 'ZC', dealCurrency: 'GTQ' });
    const alReves = resolveS4PriceForMaterial({ candidates: [...dosMonedas].reverse(), defaultPriceListType: 'ZC', dealCurrency: 'GTQ' });

    expect(enOrden.conditionRecord).toBe('0000200001');
    expect(alReves.conditionRecord).toBe('0000200001');
    expect(enOrden.currencyMismatch).toBe(true);
  });

  it('sin dealCurrency el resultado es reproducible igual, y currencyMismatch es false', () => {
    const a = resolveS4PriceForMaterial({ candidates: dosMonedas, defaultPriceListType: 'ZC' });
    const b = resolveS4PriceForMaterial({ candidates: [...dosMonedas].reverse(), defaultPriceListType: 'ZC' });

    expect(a.conditionRecord).toBe('0000200001');
    expect(b.conditionRecord).toBe('0000200001');
    expect(a.currencyMismatch).toBe(false);
  });

  it('la prioridad de tablas manda sobre la moneda: 501 gana aunque la 504 tenga la moneda del negocio', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000300001', conditionTable: '504', priceListType: null, conditionRateValue: 9, conditionCurrency: 'DOP' }),
        candidate({ conditionRecord: '0000300002', conditionTable: '501', priceListType: null, conditionRateValue: 3, conditionCurrency: 'USD' }),
      ],
      defaultPriceListType: 'ZC',
      dealCurrency: 'DOP',
    });

    expect(result).toMatchObject({ conditionRecord: '0000300002', currency: 'USD', currencyMismatch: true });
  });

  it('NO descarta el candidato por moneda: la lista del cliente gana aunque no coincida', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000111922', conditionTable: '502', priceListType: 'ZC', conditionRateValue: 1.95, conditionCurrency: 'USD' }),
        candidate({ conditionRecord: '0000400001', conditionTable: '501', priceListType: null, conditionRateValue: 88, conditionCurrency: 'DOP' }),
      ],
      customerPriceListType: 'ZC',
      defaultPriceListType: 'ZD',
      dealCurrency: 'DOP',
    });

    expect(result).toMatchObject({ conditionRecord: '0000111922', source: 'customerPriceList', currencyMismatch: true });
  });
});
```

- [ ] **Step 2: Implementar**

- [ ] **Step 3: Verificar que los tests que ya existían siguen verdes** — `resolveS4PriceForMaterial` se llama hoy sin `dealCurrency`, así que todos los casos previos tienen que pasar sin tocarlos. Si alguno cambió de resultado, el orden por `conditionRecord` alteró un caso que dependía del orden del arreglo: revisar ese test, no el código.

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/s4PriceResolution.test.js
```

---

### Task 2: Config — `defaultPriceListBySalesArea`, y `salesArea` se va

**Files:**
- Modify: `src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js` (`resolveS4PriceListConfig`, línea 100)
- Test: la suite del repositorio (confirmar el nombre real del archivo antes de editar)

**Interfaces:**

`resolveS4PriceListConfig({ tenantModels })` devuelve:

```js
{
  conditionType: 'ZPR0',
  defaultPriceListType: 'ZC',
  defaultPriceListBySalesArea: { 'DPDO/01': 'ZC', 'CPDO/01': 'ZD' },  // {} si no está
  priceListProperty: null,
  currencyProperty: null,
  priceSourceProperty: null,
}
```

**Reglas exactas:**

1. `salesArea` **desaparece** del objeto devuelto y del mensaje de error de la config faltante. El ejemplo del error pasa a ser `{ "conditionType": "ZPR0", "defaultPriceListType": "ZC", "defaultPriceListBySalesArea": { "DPDO/01": "ZC" } }`.
2. `defaultPriceListType` sigue siendo obligatorio, con el mismo error. Es el último recurso cuando el mapa no tiene la combinación.
3. Normalización de las claves del mapa: `String(k).trim().toUpperCase()`. Una clave sin `/`, o con más de un `/`, o con cualquiera de las dos mitades vacía, **se descarta** y se registra un `logger.warn` con la clave cruda. No se lanza: una clave mal escrita no puede dejar sin precios a todo el tenant, y el `defaultPriceListType` cubre esa combinación.
4. Normalización de los valores: `toNonEmptyString(v)?.toUpperCase()`. Un valor vacío descarta la entrada, con el mismo warn.
5. El canal **no** se re-normaliza numéricamente: `"1"` y `"01"` son claves distintas a propósito, porque SAP devuelve `"01"` y hacerlas equivalentes esconde una config mal cargada. `"1"` simplemente nunca matchea.
6. Si `value.defaultPriceListBySalesArea` no es un objeto plano (falta, es null, es un array), el resultado es `{}`. No se lanza.

- [ ] **Step 1: Escribir los tests que fallan**

Casos mínimos: mapa completo normalizado desde minúsculas y con espacios; mapa ausente → `{}`; mapa que es un array → `{}`; clave sin `/` → descartada + warn, el resto sobrevive; valor vacío → descartada; `defaultPriceListType` faltante → lanza; config ausente → lanza con el mensaje nuevo; `salesArea` presente en el documento → **no** aparece en el resultado.

- [ ] **Step 2: Implementar**

- [ ] **Step 3: Verificar**

---

### Task 3: Cliente SAP — filtrar el área en el `$filter`

**Files:**
- Modify: `src/infrastructure/sap/S4PriceListClient.js` (`fetchCustomerSalesAreas`, línea 134)
- Test: `tests/unit/infrastructure/s4PriceListClient.test.js`

**Interfaces:**

```js
async fetchCustomerSalesAreas(customer, { salesOrganization = null, distributionChannel = null } = {})
```

**Reglas exactas:**

1. Firma retrocompatible: sin el segundo argumento se comporta igual que hoy (filtra sólo por `Customer`). Eso mantiene vivo el camino que el caso de uso necesita para armar la nota del caso "0 filas", y el script de verificación en vivo.
2. Con los dos valores presentes, el `$filter` es
   `Customer eq '<c>' and SalesOrganization eq '<org>' and DistributionChannel eq '<canal>'`,
   armado con el `equalsLiteral` que ya existe en el archivo y unido con `' and '`, todo pasado por `encodeURIComponent` — igual que `buildValidityFilter`.
3. **Con sólo uno de los dos** presente: lanzar. Un filtro a medias devuelve filas de otros canales y el llamador no tiene forma de notarlo. El mensaje nombra los dos campos y lo que llegó.
4. `CUSTOMER_SALES_AREA_SELECT` no cambia: ya trae `PriceListType` y `Currency`.
5. Customer vacío sigue devolviendo `[]` sin llamar a SAP.

- [ ] **Step 1: Escribir los tests que fallan** — doble del **transporte**, no del cliente, y aserción sobre el `$filter` exacto ya decodeado. El patrón está en el test que existe (`CUSTOMER_SALES_AREA_PATH`).

- [ ] **Step 2: Implementar**

- [ ] **Step 3: Verificar**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/s4PriceListClient.test.js
```

---

### Task 4: Payload adapter — leer las tres propiedades del deal

**Files:**
- Modify: `src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js` (el `fetchHubspotObject` de la línea 206, el `payload` de la línea 234 y el `meta` de la 245)
- Test: la suite del adapter de S/4 (confirmar el nombre real del archivo)

**Interfaces:**

La llamada al deal pasa a pedir propiedades explícitas:

```js
const deal = await this.fetchHubspotObject(token, 'deals', dealId, {
  properties: [DEAL_SALES_ORG_PROPERTY, DEAL_DISTRIBUTION_CHANNEL_PROPERTY, DEAL_CURRENCY_PROPERTY],
  associations: ['companies', 'contacts', 'line_items'],
});
```

Y el payload devuelto gana tres campos:

```js
payload: {
  dealId,
  customer,
  salesOrganization,      // string o null
  distributionChannel,    // string o null
  dealCurrency,           // string o null
  lineItems: [...],
  lineItemFailures: failures,
}
```

**Reglas exactas:**

1. Los nombres de las propiedades van en **constantes exportadas** del módulo (`DEAL_SALES_ORG_PROPERTY = 'sales_organization'`, `DEAL_DISTRIBUTION_CHANNEL_PROPERTY = 'distribution_channel'`, `DEAL_CURRENCY_PROPERTY = 'deal_currency_code'`), no literales embebidos, para que el test asierte sobre la misma fuente que el código.
2. Los tres se normalizan con `toNonEmptyString`. `salesOrganization` además va a mayúsculas; `distributionChannel` **no** se toca (`"01"` tiene que quedar `"01"`); `dealCurrency` va a mayúsculas.
3. Pedir `properties` explícitas **cambia** la respuesta de HubSpot: hoy la llamada va sin `properties` y devuelve el set por defecto. Antes de implementar, confirmar leyendo el archivo que nada más abajo depende de una propiedad del deal que hoy llega por default. Lo verificado el 2026-08-24: `resolveCustomer` (línea 279) usa las **asociaciones** y hace sus propios GET a company/contact con `properties: ['idsap', 'idSap']`, así que no depende de las del deal; y `extractLineItemAssociationIds` lee asociaciones. Re-confirmarlo igual: el archivo pudo cambiar.
4. **No** se valida acá que los campos estén presentes. El adapter sólo transporta; quien decide qué hacer con el vacío es el caso de uso, que es el que puede escribir la nota.
5. `meta` gana `salesOrganization` y `distributionChannel` junto a `dealId` y `customer`, para que el skip y el log los muestren.

- [ ] **Step 1: Escribir los tests que fallan** — el doble de `fetchHubspotObject` asierta que el `properties` incluye los tres nombres; y que el payload los propaga normalizados (minúsculas → mayúsculas en org y moneda, canal intacto, ausentes → null).

- [ ] **Step 2: Implementar**

- [ ] **Step 3: Verificar**

---

### Task 5: Caso de uso — el área viene del negocio

Es la tarea grande. **Leer el archivo completo antes de tocarlo.**

**Files:**
- Modify: `src/application/use-cases/SyncS4LineItemPricesByPriceList.js`
- Test: `tests/unit/application/syncS4LineItemPricesByPriceList.test.js`

**Lo que se borra:**

- `SALES_AREA_SOURCES` (línea 19) y todo su uso, incluido el campo `salesAreaSource` del audit y del resultado.
- `matchesSalesArea` (línea 65) y el warn del fallback de config.
- La rama de fallback a `config.salesArea` dentro de `chooseSalesAreaRow` (línea 91) y las dos ramas de desempate (`rows.length > 1` con y sin config).
- La lectura de `config.salesArea`.
- `describeSalesAreaRows` (línea 51) **se conserva**: sirve para listar las áreas reales del cliente en la nota del caso "0 filas".

**Lo que queda:**

`chooseSalesAreaRow` se reduce a validar el resultado de una consulta que ya viene filtrada:

| Filas | Qué hace |
|---|---|
| 1 | La usa. |
| 0 | Lanza un error tipado: `error.salesAreaNotFound = true`. |
| >1 | Lanza pidiendo la división, listando las filas con `describeSalesArea`. |

**Orden nuevo de `execute`:**

1. Validar `dealId`, `customer`, `lineItems` — igual que hoy.
2. **Validar `salesOrganization` y `distributionChannel`.** Si falta cualquiera de los dos, lanzar con `error.salesAreaMissing = true` **antes** de resolver credenciales o llamar a SAP. Sin área no hay nada que consultar.
3. Leer la config, credenciales y token — igual que hoy.
4. `fetchCustomerSalesAreas(customer, { salesOrganization, distributionChannel })`.
5. `chooseSalesAreaRow`.
6. `customerPriceListType` = `PriceListType` de la fila, o null si viene vacía.
7. `effectivePriceListType` = `customerPriceListType ?? config.defaultPriceListBySalesArea[clave] ?? config.defaultPriceListType`, donde `clave` es `` `${salesOrganization}/${distributionChannel}` ``. Lo que se le pasa al dominio como `defaultPriceListType` es `config.defaultPriceListBySalesArea[clave] ?? config.defaultPriceListType` — el dominio no conoce el mapa.
8. Por línea: `resolveS4PriceForMaterial({ ..., dealCurrency })`.
9. **Guardia de moneda:** si `resolved.currencyMismatch` es true, la línea NO se escribe. Va a `skippedLineItems` con `reason: \`condition currency ${resolved.currency} does not match the deal currency ${dealCurrency}\`` y un `logger.warn`. El resto del ciclo sigue igual.
10. Escritura y nota — igual que hoy.

**Los dos caminos de error nuevos, con sus notas:**

- **`salesAreaMissing`** — no se toca ningún precio (no se consultó nada en SAP). Se escribe la nota con `reasonCode: 'salesAreaMissing'` y se lanza. El notificador necesita token y dealId; acá el token todavía no se resolvió, así que este chequeo va **después** de obtener el token o la nota no se puede escribir. Resolverlo así: la validación de los campos ocurre en el paso 2 pero **sólo registra** la falla; el lanzamiento se hace después de tener el token, antes de la primera llamada a SAP. Documentarlo con un comentario, porque el orden parece arbitrario y no lo es.
- **`salesAreaNotFound`** — se escriben **ceros** y después se lanza:
  1. Segunda consulta `fetchCustomerSalesAreas(customer)` **sin** org/canal, para saber qué áreas tiene realmente el cliente. Va por el `callRecorder` como todas las demás. Si esta consulta falla, se sigue adelante sin la lista: la nota es peor pero los ceros importan más.
  2. `updateLineItems` con todas las líneas del payload en `Price: 0` y su `quantity` original. Ojo: `buildHubspotBatchPayload` escribe `price` **y** `quantity` ([HubspotLineItemPriceClient.js:52](../../../src/infrastructure/external-services/HubspotLineItemPriceClient.js)), así que hay que pasar la cantidad real o se sobreescribe con 1.
  3. `updateDealAmount` con `totalAmount: 0`.
  4. Nota con `reasonCode: 'salesAreaNotFound'` y la lista de áreas reales.
  5. Lanzar. El `catch` existente arma el audit y el `syncLogWebhookErrors` — las dos escrituras quedan registradas porque pasaron por el `callRecorder`.

Las banderas viajan a la nota por el objeto de contexto que ya existe (`noteContext`), no por parsear `error.message`.

- [ ] **Step 1: Escribir los tests que fallan**

Casos, todos con el harness `buildDeps` que ya existe (hay que agregarle `salesOrganization`/`distributionChannel`/`dealCurrency` al payload de entrada):

1. Una fila → usa su `PriceListType`, y `fetchCustomerSalesAreas` recibió org y canal.
2. `PriceListType` vacía → usa `defaultPriceListBySalesArea['DPDO/01']`.
3. Combinación ausente del mapa → usa `defaultPriceListType`.
4. Cero filas → escribe `price: '0'` en **todas** las líneas con su cantidad original, `amount: 0` en el deal, nota con las áreas reales, y lanza.
5. Cero filas y la segunda consulta falla → igual, pero la nota no lista áreas y no se pierde la escritura de ceros.
6. Más de una fila → lanza pidiendo la división, sin tocar HubSpot.
7. `salesOrganization` vacío → lanza, nota con el motivo, y **`updateLineItems` no se llamó**.
8. `distributionChannel` vacío → idem.
9. Mismatch de moneda en una línea de dos → la otra se escribe, la del mismatch va a `skippedLineItems` con el motivo, y la nota la lista.
10. Todas las líneas con mismatch → `No line item prices could be resolved...` con la nota.
11. `dealCurrency` null → no hay mismatch nunca y se escribe la condición tal cual.
12. El audit ya no trae `salesAreaSource`.

- [ ] **Step 2: Implementar**

- [ ] **Step 3: Borrar los tests que describen comportamiento eliminado** — los que ejercitan el desempate por config (`elige el área configurada cuando el cliente tiene varias`, `falla cuando el área configurada no pertenece al cliente`, `falla pidiendo la división cuando el área configurada sin division empata con dos del cliente`, `elige el área configurada aunque las filas de SAP traigan Division vacía`, `usa la única área de ventas del cliente e ignora la configurada`, `cae al área configurada y la lista default cuando el cliente no tiene áreas en SAP`, `falla cuando el cliente no tiene áreas y s4PriceList.salesArea no está configurada`). Se borran, no se adaptan. Verificar uno por uno que lo que cubrían quedó cubierto por los casos nuevos, y anotarlo en el reporte de la tarea.

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncS4LineItemPricesByPriceList.test.js tests/unit/composition/s4LineItemPricesComposition.test.js
```

---

### Task 6: Notas — los dos motivos nuevos

**Files:**
- Modify: `src/domain/prices/lineItemPriceNote.service.js` (`buildLineItemPriceNoteBody`, línea 75)
- Test: `tests/unit/infrastructure/lineItemPriceNoteNotifier.test.js` (el describe de `buildLineItemPriceNoteBody`)

**Interfaces:**

```js
buildLineItemPriceNoteBody({
  customer, salesArea, priceListType, updatedCount, skippedLineItems, fatalErrorMessage,
  reasonCode = null,            // null | 'salesAreaMissing' | 'salesAreaNotFound'
  customerSalesAreas = [],      // [{ salesOrganization, distributionChannel, priceListType }]
})
```

- `salesAreaSource` **se elimina** del parámetro, y el bloque que avisaba del fallback de config también, porque ese camino ya no existe.
- `reasonCode` decide el título y el cuerpo. `null` mantiene los dos textos de hoy (parcial y fatal genérico).
- Los textos son los del spec, literales.
- `customerSalesAreas` vacío → la nota omite la frase de las áreas en vez de decir "las áreas son: " y cortar.
- Sigue escapando el HTML de todo lo que viene de SAP y de HubSpot.

- [ ] **Step 1: Escribir los tests que fallan** — un caso por `reasonCode`, uno con `customerSalesAreas` vacío, uno de escapado con un código de área malicioso, y la verificación de que ya no existe el texto del fallback de config.

- [ ] **Step 2: Implementar**

- [ ] **Step 3: Verificar**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/lineItemPriceNoteNotifier.test.js
```

---

### Task 7: Documentación de la config

**Files:**
- Modify: `configuration_examples.md`

- [ ] **Step 1:** Reemplazar el ejemplo de `s4PriceList` por el del spec, con `defaultPriceListBySalesArea` y **sin** `salesArea`. Formato del catálogo: descripción de cada clave más un ejemplo, como el resto del archivo.
- [ ] **Step 2:** Documentar que las dos propiedades del negocio (`sales_organization`, `distribution_channel`) son obligatorias para los tenants S/4, y que `PRODUCT_DEFAULT` sigue siendo el valor que puede recibir `priceListProperty`.
- [ ] **Step 3:** Anotar que la tabla de defaults son valores calculados de los datos del 2026-08-24, cargados para que el desarrollo funcione y pendientes de confirmación del cliente.

---

### Task 8: Verificación en vivo (read-only) y config del tenant

**Files:**
- Create: `.superpowers/sdd/2026-08-24-sales-area-from-deal/verificar-en-vivo.mjs` (git-ignored)

**Reglas:** sólo GET. Nunca volcar un error crudo de axios — incluye los headers, o sea el Basic auth del tenant. Envolver con handlers de `uncaughtException`/`unhandledRejection` que impriman sólo status y mensaje, como los scripts que ya existen en `.superpowers/sdd/2026-08-18-s4-price-list-line-item-webhook/`.

- [ ] **Step 1:** Cargar la Configuration `s4PriceList` en el Mongo **local** de `sap_integration_multiquimica` con el `defaultPriceListBySalesArea` del spec. **No** tocar producción.
- [ ] **Step 2:** Ejercer el camino real (config → cliente → dominio) sin escribir en HubSpot, y confirmar:
  - BP `100061` + `CPDO/01` → una fila, lista `ZD`
  - BP `100061` + `DPDO/01` → una fila, lista `ZC`
  - BP `100061` + `MQGT/01` → **cero** filas
  - BP `111667` + `MQGT/01` → una fila, lista `ZA`
  - BP `111667` + `DPDO/01` → **cero** filas
  - Material `10000003` en MQGT/01 con lista `ZA` y `dealCurrency: 'USD'` → 7.02 USD/KG, `currencyMismatch: false`
  - Un material de MKDO/01 con default de producto en dos monedas → el mismo resultado con el arreglo en cualquier orden
- [ ] **Step 3:** Correr la suite entera excluyendo worktrees y confirmar que las rojas siguen siendo las 5 del baseline.

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --testPathIgnorePatterns=".claude\\\\worktrees"
```

---

## Prueba manual de punta a punta

Después de la Tarea 8, y sólo con el `.env` apuntando al Mongo **local** (`MONGODB_URI=mongodb://localhost:27017/SmartConnect`; con el de producción activo el webhook devuelve 403 porque multiquímica no está provisionada allá):

1. Crear en el portal las propiedades del negocio `sales_organization` y `distribution_channel`.
2. Cargar la Configuration `requireMessageHS` con `{ "requireMessageHS": true }` — sin ella las notas no se escriben.
3. Negocio con cliente `111667`, `sales_organization=MQGT`, `distribution_channel=01`, moneda USD, y una línea del producto `10000003` → precio 7.02, sin nota.
4. Cambiar el negocio a `sales_organization=DPDO` y volver a guardar una línea → precios en 0, `amount` 0, y nota diciendo que el cliente sólo está en MQGT/01.
5. Borrar `sales_organization` del negocio y guardar una línea → error, nota pidiendo el campo, y los precios **sin tocar**.
6. Revisar en `sap_integration_multiquimica`: `LineItemPriceWebhookEvents` (el `audit` con las llamadas a SAP y a HubSpot, `isSend`, `errorMessage`) y `SyncLogs`.
