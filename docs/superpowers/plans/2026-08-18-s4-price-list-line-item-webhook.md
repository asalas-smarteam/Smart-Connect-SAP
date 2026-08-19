# Webhook de listas de precios de line items para SAP S/4HANA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que al agregar o cambiar líneas de un negocio en HubSpot, un webhook propio para tenants S/4 escriba en cada line item el precio de la lista de precios del cliente, cayendo a una lista default configurable y luego al precio por defecto del producto.

**Architecture:** Ruta HTTP nueva que reusa el controlador de precios existente inyectándole su propio payload adapter y su propio caso de uso. El precio se lee de los registros de condición ZPR0 de S/4 en dos pasos (vigencia filtrable → tarifa), con la regla de selección aislada en una función pura de dominio. El flujo B1 no se toca en ningún archivo.

**Tech Stack:** Node 24 ESM, Fastify, Mongoose multi-tenant, axios, Jest con `--experimental-vm-modules`. OData v2 de SAP Gateway sobre el `S4GatewayTransport` existente.

**Spec:** [docs/superpowers/specs/2026-08-18-s4-price-list-line-item-webhook-design.md](../specs/2026-08-18-s4-price-list-line-item-webhook-design.md)

## Global Constraints

- **No commitear.** En este repo los commits los define el usuario desde VSCode. El paso final de cada tarea es un punto de corte para revisión, no un `git commit`. Trabajar siempre en el checkout principal sobre `main`, sin worktrees ni ramas.
- **No tocar el flujo B1.** Prohibido modificar `SapLineItemPriceClient.js`, `SyncLineItemPrices.js`, `SyncDealLineItemPricesByPriceList.js`, `lineItemPriceWebhook.service.js`, `dealPriceListLineItemPriceWebhook.service.js`, `LineItemPriceWebhookPayloadAdapter.js`, `line-item-price-strategy.factory.js` ni `line-item-price-strategy.constants.js`. Se leen como referencia; no se editan.
- **Correr jest con path explícito**, nunca la suite completa desde la raíz. Bash: `NODE_OPTIONS=--experimental-vm-modules npx jest <path>`. PowerShell: `$env:NODE_OPTIONS='--experimental-vm-modules'; npx jest <path>`.
- **Fechas en las fixtures: ISO, no `/Date(ms)/`.** El `S4GatewayTransport` normaliza `/Date(1769126400000)/` a `2026-01-23T00:00:00.000Z` antes de devolver los datos ([odataV2Normalizer.js:18](../../../src/infrastructure/sap/transport/odataV2Normalizer.js)). Las fixtures imitan la salida del transporte, no la del sistema remoto.
- **Filtros OData: `$filter` va pre-encodeado, `$select` va crudo.** El transporte pasa los valores del query tal cual ([S4GatewayTransport.js:19](../../../src/infrastructure/sap/transport/S4GatewayTransport.js)). El patrón del repo es `$filter: encodeURIComponent(filtro)` — ver [S4StockResolver.js:80](../../../src/infrastructure/sap/products/S4StockResolver.js).
- **El audit se construye con `buildLineItemPriceAudit`**, nunca a mano: las entradas de tráfico OData llevan claves `$filter`/`$select` y ese builder las pasa por `sanitizeAuditKeys`, que las renombra a `_$filter`/`_$select`. Sin eso el `$set` del `WebhookEvent` se cae completo contra el Mongo de producción (< 5.0) y arrastra el `errorMessage` que viaja en la misma escritura.
- **Valores verificados en vivo el 2026-08-18** contra el S/4 de dev/QA de Multiquímica: condición `ZPR0`; tabla `502` = OrgVentas+Canal+PriceListType+Material; tablas `501` y `504` = OrgVentas+Canal+Material sin lista; listas `ZA`/`ZB`/`ZC`/`ZD`. Usar estos valores en las fixtures.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/domain/prices/s4-price-resolution.service.js` (crear) | Función pura: dados los candidatos y la lista efectiva, elegir tarifa y calcular precio unitario. Sin red ni Mongo. |
| `src/infrastructure/sap/S4PriceListClient.js` (crear) | Las tres lecturas OData y la normalización de filas a candidatos. |
| `src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js` (modificar) | Suma `resolveS4PriceListConfig`. |
| `src/application/use-cases/SyncS4LineItemPricesByPriceList.js` (crear) | Orquesta: cliente → área de ventas → precio por línea → escritura en HubSpot. |
| `src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js` (crear) | Clasificación del evento, dedupe, debounce, armado del payload, `markAsSent`/`markAsError`. |
| `src/composition/s4-line-item-prices.composition.js` (crear) | Wiring. |
| `src/interfaces/http/routes/lineItemPrice.routes.js` (modificar) | Registra `POST /webhooks/hubspot/line-items/prices/s4`. |
| `configuration_examples.md` (modificar) | Documenta la clave `s4PriceList`. |

---

### Task 1: Dominio — selección de la tarifa y precio unitario

**Files:**
- Create: `src/domain/prices/s4-price-resolution.service.js`
- Test: `tests/unit/domain/s4PriceResolution.test.js`

**Interfaces:**
- Consumes: `toNonEmptyString`, `normalizeNumber` de `#shared/utils/string.utils.js`.
- Produces:
  - `resolveS4PriceForMaterial({ candidates, customerPriceListType, defaultPriceListType }) => { price, currency, priceListType, conditionRecord, source } | null`
  - `S4_PRICE_SOURCES = { CUSTOMER_PRICE_LIST: 'customerPriceList', DEFAULT_PRICE_LIST: 'defaultPriceList', PRODUCT_DEFAULT: 'productDefault' }`
  - `PRICE_LIST_CONDITION_TABLES = ['502']`, `PRODUCT_DEFAULT_CONDITION_TABLES = ['501', '504']`
  - Forma del candidato de entrada: `{ conditionRecord, conditionTable, priceListType, conditionRateValue, conditionCurrency, conditionQuantity, conditionQuantityUnit, conditionIsDeleted }`

- [ ] **Step 1: Escribir el test que falla**

`tests/unit/domain/s4PriceResolution.test.js`:

```js
import {
  resolveS4PriceForMaterial,
  S4_PRICE_SOURCES,
} from '../../../src/domain/prices/s4-price-resolution.service.js';

// Candidatos con la forma que produce S4PriceListClient. Valores reales del S/4 de
// Multiquímica (material 80000017, área FQCR/01, verificados el 2026-08-18).
function candidate(overrides = {}) {
  return {
    conditionRecord: '0000418608',
    conditionTable: '502',
    priceListType: 'ZC',
    conditionRateValue: 1.28,
    conditionCurrency: 'USD',
    conditionQuantity: 1,
    conditionQuantityUnit: 'KG',
    conditionIsDeleted: false,
    ...overrides,
  };
}

describe('resolveS4PriceForMaterial', () => {
  it('elige la tabla 502 de la lista del cliente', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000418606', priceListType: 'ZA', conditionRateValue: 2.08 }),
        candidate(),
      ],
      customerPriceListType: 'ZC',
      defaultPriceListType: 'ZA',
    });

    expect(result).toEqual({
      price: 1.28,
      currency: 'USD',
      priceListType: 'ZC',
      conditionRecord: '0000418608',
      source: S4_PRICE_SOURCES.CUSTOMER_PRICE_LIST,
    });
  });

  it('cae a la lista default cuando la del cliente no tiene registro', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [candidate({ priceListType: 'ZA', conditionRateValue: 2.08 })],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZA',
    });

    expect(result.source).toBe(S4_PRICE_SOURCES.DEFAULT_PRICE_LIST);
    expect(result.price).toBe(2.08);
    expect(result.priceListType).toBe('ZA');
  });

  it('cae al default del producto (tablas 501/504, sin lista) cuando ninguna lista tiene registro', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000418745', conditionTable: '504', priceListType: '', conditionRateValue: 1.25 }),
      ],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZA',
    });

    expect(result.source).toBe(S4_PRICE_SOURCES.PRODUCT_DEFAULT);
    expect(result.price).toBe(1.25);
    expect(result.priceListType).toBeNull();
  });

  it('divide por ConditionQuantity cuando la tarifa no es por unidad', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionTable: '501', priceListType: '', conditionRateValue: 2700, conditionQuantity: 1000 }),
      ],
      customerPriceListType: null,
      defaultPriceListType: null,
    });

    expect(result.price).toBe(2.7);
  });

  it('descarta registros borrados aunque estén vigentes por fechas', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000177449', conditionTable: '501', priceListType: '', conditionRateValue: 2.1, conditionIsDeleted: true }),
      ],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZD',
    });

    expect(result).toBeNull();
  });

  it('descarta tarifas no positivas y devuelve null sin candidatos', () => {
    expect(resolveS4PriceForMaterial({
      candidates: [candidate({ conditionRateValue: 0 })],
      customerPriceListType: 'ZC',
    })).toBeNull();

    expect(resolveS4PriceForMaterial({ candidates: [] })).toBeNull();
    expect(resolveS4PriceForMaterial()).toBeNull();
  });

  it('ignora un candidato de la tabla 502 cuyo PriceListType no es el pedido', () => {
    expect(resolveS4PriceForMaterial({
      candidates: [candidate({ priceListType: 'ZB' })],
      customerPriceListType: 'ZC',
      defaultPriceListType: 'ZD',
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/s4PriceResolution.test.js`
Expected: FAIL — `Cannot find module '../../../src/domain/prices/s4-price-resolution.service.js'`

- [ ] **Step 3: Implementar**

`src/domain/prices/s4-price-resolution.service.js`:

```js
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// Tablas de condición de ZPR0, verificadas en vivo contra el S/4 de Multiquímica el
// 2026-08-18: la 502 lleva PriceListType en la clave (precio por lista de precios); la 501 y
// la 504 no lo llevan (precio por defecto del producto, por organización de ventas y canal).
export const PRICE_LIST_CONDITION_TABLES = Object.freeze(['502']);
export const PRODUCT_DEFAULT_CONDITION_TABLES = Object.freeze(['501', '504']);

export const S4_PRICE_SOURCES = Object.freeze({
  CUSTOMER_PRICE_LIST: 'customerPriceList',
  DEFAULT_PRICE_LIST: 'defaultPriceList',
  PRODUCT_DEFAULT: 'productDefault',
});

// Un registro borrado puede seguir vigente por fechas: el 0000177449 de material 80000017 lo
// está. Y una tarifa en cero es "sin precio", igual que la trata la reconciliación del flujo
// B1, no un producto gratis.
function isUsable(candidate) {
  return candidate?.conditionIsDeleted !== true
    && normalizeNumber(candidate?.conditionRateValue, 0) > 0;
}

function inTables(candidate, tables) {
  return tables.includes(String(candidate?.conditionTable ?? '').trim());
}

function pickByPriceList(candidates, priceListType) {
  const wanted = toNonEmptyString(priceListType);

  if (!wanted) {
    return null;
  }

  return candidates.find(
    (candidate) => inTables(candidate, PRICE_LIST_CONDITION_TABLES)
      && toNonEmptyString(candidate.priceListType) === wanted
  ) ?? null;
}

function pickProductDefault(candidates) {
  return candidates.find(
    (candidate) => inTables(candidate, PRODUCT_DEFAULT_CONDITION_TABLES)
      && !toNonEmptyString(candidate.priceListType)
  ) ?? null;
}

// La tarifa viene "por N unidades" (hay registros de 2700 USD por 1000 KG), así que el precio
// unitario es siempre rate/quantity. Un ConditionQuantity ausente o no positivo se toma como 1
// para no dividir por cero.
function toUnitPrice(candidate) {
  const quantity = normalizeNumber(candidate.conditionQuantity, 1);
  const divisor = quantity > 0 ? quantity : 1;

  return normalizeNumber(candidate.conditionRateValue, 0) / divisor;
}

// Devuelve el precio unitario SIN redondear: quien escribe en HubSpot redondea a 2 decimales.
export function resolveS4PriceForMaterial({
  candidates = [],
  customerPriceListType = null,
  defaultPriceListType = null,
} = {}) {
  const usable = (Array.isArray(candidates) ? candidates : []).filter(isUsable);
  const attempts = [
    [pickByPriceList(usable, customerPriceListType), S4_PRICE_SOURCES.CUSTOMER_PRICE_LIST],
    [pickByPriceList(usable, defaultPriceListType), S4_PRICE_SOURCES.DEFAULT_PRICE_LIST],
    [pickProductDefault(usable), S4_PRICE_SOURCES.PRODUCT_DEFAULT],
  ];

  for (const [candidate, source] of attempts) {
    if (candidate) {
      return {
        price: toUnitPrice(candidate),
        currency: toNonEmptyString(candidate.conditionCurrency),
        priceListType: toNonEmptyString(candidate.priceListType),
        conditionRecord: toNonEmptyString(candidate.conditionRecord),
        source,
      };
    }
  }

  return null;
}

export default resolveS4PriceForMaterial;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/s4PriceResolution.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Punto de corte** — mostrar los dos archivos al usuario para revisión. No commitear.

---

### Task 2: Cliente OData `S4PriceListClient`

**Files:**
- Create: `src/infrastructure/sap/S4PriceListClient.js`
- Test: `tests/unit/infrastructure/s4PriceListClient.test.js`

**Interfaces:**
- Consumes: `toODataV2DateTime` de `#infrastructure/sap/s4ODataQueryBuilder.js`; `escapeODataString`, `toNonEmptyString`, `normalizeNumber` de `#shared/utils/string.utils.js`. Un `transport` con `fetchAll({ path, query })` (el `S4GatewayTransport`, que auto-pagina y devuelve el array de filas).
- Produces:
  - `class S4PriceListClient { constructor({ transport }) }`
  - `fetchCustomerSalesAreas(customer) => Promise<row[]>` con las filas crudas de `A_CustomerSalesArea`
  - `fetchConditionCandidates({ conditionType, material, salesArea, date }) => Promise<candidate[]>` con la forma que consume `resolveS4PriceForMaterial`
  - Constantes exportadas: `CUSTOMER_SALES_AREA_PATH`, `CONDITION_VALIDITY_PATH`, `CONDITION_RECORD_PATH`, `CUSTOMER_SALES_AREA_SELECT`, `CONDITION_VALIDITY_SELECT`, `CONDITION_RECORD_SELECT`

- [ ] **Step 1: Escribir el test que falla**

`tests/unit/infrastructure/s4PriceListClient.test.js`:

```js
import { jest } from '@jest/globals';
import {
  S4PriceListClient,
  CUSTOMER_SALES_AREA_PATH,
  CONDITION_VALIDITY_PATH,
  CONDITION_RECORD_PATH,
} from '../../../src/infrastructure/sap/S4PriceListClient.js';

// Filas tal como salen del transporte: las fechas ya vienen en ISO porque
// normalizeODataV2Response convierte /Date(ms)/ antes de devolverlas.
const VALIDITY_ROWS = [
  {
    ConditionRecord: '0000418608',
    ConditionType: 'ZPR0',
    PriceListType: 'ZC',
    Material: '80000017',
    SalesOrganization: 'FQCR',
    DistributionChannel: '01',
    ConditionValidityStartDate: '2026-01-23T00:00:00.000Z',
    ConditionValidityEndDate: '2026-12-31T00:00:00.000Z',
  },
  {
    ConditionRecord: '0000418745',
    ConditionType: 'ZPR0',
    PriceListType: '',
    Material: '80000017',
    SalesOrganization: 'FQCR',
    DistributionChannel: '01',
    ConditionValidityStartDate: '2026-01-27T00:00:00.000Z',
    ConditionValidityEndDate: '2026-12-31T00:00:00.000Z',
  },
];

const RECORD_ROWS = [
  {
    ConditionRecord: '0000418608',
    ConditionTable: '502',
    ConditionType: 'ZPR0',
    ConditionRateValue: '1.2800',
    ConditionCurrency: 'USD',
    ConditionQuantity: '1',
    ConditionQuantityUnit: 'KG',
    ConditionIsDeleted: false,
  },
  {
    ConditionRecord: '0000418745',
    ConditionTable: '504',
    ConditionType: 'ZPR0',
    ConditionRateValue: '1.2500',
    ConditionCurrency: 'USD',
    ConditionQuantity: '1',
    ConditionQuantityUnit: 'KG',
    ConditionIsDeleted: false,
  },
];

function buildTransport({ validity = VALIDITY_ROWS, records = RECORD_ROWS, salesAreas = [] } = {}) {
  return {
    fetchAll: jest.fn(async ({ path }) => {
      if (path === CUSTOMER_SALES_AREA_PATH) return salesAreas;
      if (path === CONDITION_VALIDITY_PATH) return validity;
      if (path === CONDITION_RECORD_PATH) return records;
      throw new Error(`unexpected path ${path}`);
    }),
  };
}

function filterOf(transport, path) {
  const call = transport.fetchAll.mock.calls.find(([options]) => options.path === path);
  return decodeURIComponent(call[0].query.$filter);
}

describe('S4PriceListClient', () => {
  it('exige un transport', () => {
    expect(() => new S4PriceListClient({})).toThrow('transport is required');
  });

  it('filtra las áreas de venta por cliente y escapa la comilla simple', async () => {
    const transport = buildTransport({ salesAreas: [{ Customer: "O'BRIEN" }] });
    const client = new S4PriceListClient({ transport });

    const rows = await client.fetchCustomerSalesAreas("O'BRIEN");

    expect(rows).toEqual([{ Customer: "O'BRIEN" }]);
    expect(filterOf(transport, CUSTOMER_SALES_AREA_PATH)).toBe("Customer eq 'O''BRIEN'");
  });

  it('no llama al transporte cuando no hay cliente', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    expect(await client.fetchCustomerSalesAreas('  ')).toEqual([]);
    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  it('filtra la vigencia por condición, material, área de ventas y fecha', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T15:04:05.000Z'),
    });

    expect(filterOf(transport, CONDITION_VALIDITY_PATH)).toBe(
      "ConditionType eq 'ZPR0' and Material eq '80000017'"
      + " and SalesOrganization eq 'FQCR' and DistributionChannel eq '01'"
      + " and ConditionValidityStartDate le datetime'2026-08-18T15:04:05'"
      + " and ConditionValidityEndDate ge datetime'2026-08-18T15:04:05'"
    );
  });

  it('trae todas las tarifas en UNA llamada con or sobre ConditionRecord', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    });

    const recordCalls = transport.fetchAll.mock.calls.filter(
      ([options]) => options.path === CONDITION_RECORD_PATH
    );
    expect(recordCalls).toHaveLength(1);
    expect(filterOf(transport, CONDITION_RECORD_PATH)).toBe(
      "ConditionRecord eq '0000418608' or ConditionRecord eq '0000418745'"
    );
  });

  it('junta el PriceListType de la vigencia con la tarifa del registro y numeriza', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    const candidates = await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    });

    expect(candidates).toEqual([
      {
        conditionRecord: '0000418608',
        conditionTable: '502',
        priceListType: 'ZC',
        material: '80000017',
        conditionRateValue: 1.28,
        conditionCurrency: 'USD',
        conditionQuantity: 1,
        conditionQuantityUnit: 'KG',
        conditionIsDeleted: false,
      },
      {
        conditionRecord: '0000418745',
        conditionTable: '504',
        priceListType: null,
        material: '80000017',
        conditionRateValue: 1.25,
        conditionCurrency: 'USD',
        conditionQuantity: 1,
        conditionQuantityUnit: 'KG',
        conditionIsDeleted: false,
      },
    ]);
  });

  it('no pide tarifas cuando la vigencia no devolvió nada', async () => {
    const transport = buildTransport({ validity: [] });
    const client = new S4PriceListClient({ transport });

    expect(await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '99999999',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    })).toEqual([]);

    const recordCalls = transport.fetchAll.mock.calls.filter(
      ([options]) => options.path === CONDITION_RECORD_PATH
    );
    expect(recordCalls).toHaveLength(0);
  });

  it('descarta filas de vigencia sin tarifa correspondiente', async () => {
    const transport = buildTransport({ records: [RECORD_ROWS[0]] });
    const client = new S4PriceListClient({ transport });

    const candidates = await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].conditionRecord).toBe('0000418608');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/s4PriceListClient.test.js`
Expected: FAIL — no existe `src/infrastructure/sap/S4PriceListClient.js`

- [ ] **Step 3: Implementar**

`src/infrastructure/sap/S4PriceListClient.js`:

```js
import { toODataV2DateTime } from '#infrastructure/sap/s4ODataQueryBuilder.js';
import { escapeODataString, normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// Lecturas de precio de venta en S/4. Dos pasos por material y no uno porque la entidad que
// permite filtrar (la de vigencia) no trae la tarifa, y la que trae la tarifa no permite
// filtrar por material ni por lista de precios.
export const CUSTOMER_SALES_AREA_PATH = '/API_BUSINESS_PARTNER/A_CustomerSalesArea';
export const CONDITION_VALIDITY_PATH = '/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity';
export const CONDITION_RECORD_PATH = '/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord';

export const CUSTOMER_SALES_AREA_SELECT = [
  'Customer',
  'SalesOrganization',
  'DistributionChannel',
  'Division',
  'PriceListType',
  'Currency',
].join(',');

export const CONDITION_VALIDITY_SELECT = [
  'ConditionRecord',
  'ConditionType',
  // PriceListType vive SOLO acá, no en el registro de condición: es la mitad del join.
  'PriceListType',
  'Material',
  'SalesOrganization',
  'DistributionChannel',
  'ConditionValidityStartDate',
  'ConditionValidityEndDate',
].join(',');

export const CONDITION_RECORD_SELECT = [
  'ConditionRecord',
  // ConditionTable es lo que distingue un precio por lista (502) de un precio por defecto del
  // producto (501/504); no se puede filtrar por él, así que se clasifica en memoria.
  'ConditionTable',
  'ConditionType',
  'ConditionRateValue',
  'ConditionCurrency',
  'ConditionQuantity',
  'ConditionQuantityUnit',
  'ConditionIsDeleted',
].join(',');

const enc = encodeURIComponent;

function equalsLiteral(field, value) {
  return `${field} eq '${escapeODataString(value)}'`;
}

// Nunca se filtra por `PriceListType eq ''`: Gateway no devuelve los registros sin lista con
// ese filtro (verificado el 2026-08-18 con el registro 0000418745). Se traen todos los del
// material y se clasifican por ConditionTable.
function buildValidityFilter({ conditionType, material, salesArea, date }) {
  const literal = toODataV2DateTime(date);
  const conditions = [
    equalsLiteral('ConditionType', conditionType),
    equalsLiteral('Material', material),
  ];

  if (toNonEmptyString(salesArea?.salesOrganization)) {
    conditions.push(equalsLiteral('SalesOrganization', salesArea.salesOrganization));
  }

  if (toNonEmptyString(salesArea?.distributionChannel)) {
    conditions.push(equalsLiteral('DistributionChannel', salesArea.distributionChannel));
  }

  conditions.push(`ConditionValidityStartDate le ${literal}`);
  conditions.push(`ConditionValidityEndDate ge ${literal}`);

  return conditions.join(' and ');
}

function toCandidate(validityRow, recordRow) {
  return {
    conditionRecord: toNonEmptyString(validityRow.ConditionRecord),
    conditionTable: toNonEmptyString(recordRow.ConditionTable),
    priceListType: toNonEmptyString(validityRow.PriceListType),
    material: toNonEmptyString(validityRow.Material),
    conditionRateValue: normalizeNumber(recordRow.ConditionRateValue, 0),
    conditionCurrency: toNonEmptyString(recordRow.ConditionCurrency),
    conditionQuantity: normalizeNumber(recordRow.ConditionQuantity, 1),
    conditionQuantityUnit: toNonEmptyString(recordRow.ConditionQuantityUnit),
    conditionIsDeleted: recordRow.ConditionIsDeleted === true,
  };
}

export class S4PriceListClient {
  constructor({ transport } = {}) {
    if (!transport) {
      throw new Error('transport is required for S4PriceListClient');
    }

    this.transport = transport;
  }

  async fetchCustomerSalesAreas(customer) {
    const normalized = toNonEmptyString(customer);

    if (!normalized) {
      return [];
    }

    return this.transport.fetchAll({
      path: CUSTOMER_SALES_AREA_PATH,
      query: {
        $select: CUSTOMER_SALES_AREA_SELECT,
        $filter: enc(equalsLiteral('Customer', normalized)),
      },
    });
  }

  async fetchConditionCandidates({ conditionType, material, salesArea, date }) {
    const validityRows = await this.transport.fetchAll({
      path: CONDITION_VALIDITY_PATH,
      query: {
        $select: CONDITION_VALIDITY_SELECT,
        $filter: enc(buildValidityFilter({ conditionType, material, salesArea, date })),
      },
    });

    const conditionRecords = (Array.isArray(validityRows) ? validityRows : [])
      .map((row) => toNonEmptyString(row?.ConditionRecord))
      .filter((id, index, ids) => id && ids.indexOf(id) === index);

    if (conditionRecords.length === 0) {
      return [];
    }

    // Una sola llamada para todas las tarifas del material: con el área de ventas en el filtro
    // de vigencia son a lo sumo un puñado de registros (las 4 listas más los defaults del
    // producto), así que el `or` no hace crecer la URL de forma peligrosa.
    const recordRows = await this.transport.fetchAll({
      path: CONDITION_RECORD_PATH,
      query: {
        $select: CONDITION_RECORD_SELECT,
        $filter: enc(
          conditionRecords.map((id) => equalsLiteral('ConditionRecord', id)).join(' or ')
        ),
      },
    });

    const recordsById = new Map(
      (Array.isArray(recordRows) ? recordRows : [])
        .map((row) => [toNonEmptyString(row?.ConditionRecord), row])
        .filter(([id]) => id)
    );

    return (Array.isArray(validityRows) ? validityRows : [])
      .map((validityRow) => {
        const recordRow = recordsById.get(toNonEmptyString(validityRow?.ConditionRecord));
        return recordRow ? toCandidate(validityRow, recordRow) : null;
      })
      .filter(Boolean);
  }
}

export default S4PriceListClient;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/s4PriceListClient.test.js`
Expected: PASS, 7 tests.

Si el test del filtro de fecha falla por el formato, verificar `toODataV2DateTime`: usa componentes UTC y **no** lleva sufijo de zona (`datetime'2026-08-18T15:04:05'`).

- [ ] **Step 5: Punto de corte** — revisión del usuario. No commitear.

---

### Task 3: Config del tenant `s4PriceList`

**Files:**
- Modify: `src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js` (agregar método después de `resolveTenantPriceList`, que hoy termina en la línea 95)
- Modify: `configuration_examples.md`
- Test: `tests/unit/infrastructure/s4PriceListConfigRepository.test.js`

**Interfaces:**
- Consumes: `tenantConfigurationService.getValue(tenantModels, key, defaultValue)`.
- Produces: `resolveS4PriceListConfig({ tenantModels }) => { conditionType, defaultPriceListType, salesArea, priceListProperty, currencyProperty }`, donde `salesArea` es `{ salesOrganization, distributionChannel, division } | null` y `priceListProperty`/`currencyProperty` pueden ser `null`.

- [ ] **Step 1: Escribir el test que falla**

`tests/unit/infrastructure/s4PriceListConfigRepository.test.js`:

```js
import { jest } from '@jest/globals';
import TenantLineItemPriceConfigRepository from '../../../src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js';

function buildTenantModels(value) {
  return {
    Configuration: {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(
          value === undefined ? null : { key: 's4PriceList', value }
        ),
      }),
      updateOne: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('TenantLineItemPriceConfigRepository.resolveS4PriceListConfig', () => {
  const repository = new TenantLineItemPriceConfigRepository();

  it('normaliza la config completa', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        conditionType: 'ZPR0',
        defaultPriceListType: 'zc',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
        priceListProperty: 'lista_de_precios_sap',
        currencyProperty: 'moneda_precio_sap',
      }),
    });

    expect(config).toEqual({
      conditionType: 'ZPR0',
      defaultPriceListType: 'ZC',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
      priceListProperty: 'lista_de_precios_sap',
      currencyProperty: 'moneda_precio_sap',
    });
  });

  it('usa ZPR0 como conditionType por defecto y deja opcionales en null', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({ defaultPriceListType: 'ZC' }),
    });

    expect(config.conditionType).toBe('ZPR0');
    expect(config.salesArea).toBeNull();
    expect(config.priceListProperty).toBeNull();
    expect(config.currencyProperty).toBeNull();
  });

  it('descarta un salesArea incompleto en vez de armar un filtro a medias', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        defaultPriceListType: 'ZC',
        salesArea: { salesOrganization: 'FQCR' },
      }),
    });

    expect(config.salesArea).toBeNull();
  });

  it('falla con mensaje accionable cuando no hay documento de config', async () => {
    await expect(
      repository.resolveS4PriceListConfig({ tenantModels: buildTenantModels(undefined) })
    ).rejects.toThrow('Configuration s4PriceList is required');
  });

  it('falla cuando falta defaultPriceListType', async () => {
    await expect(
      repository.resolveS4PriceListConfig({ tenantModels: buildTenantModels({ conditionType: 'ZPR0' }) })
    ).rejects.toThrow('s4PriceList.defaultPriceListType is required');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/s4PriceListConfigRepository.test.js`
Expected: FAIL — `repository.resolveS4PriceListConfig is not a function`

- [ ] **Step 3: Implementar**

En `src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js`, agregar el método justo después de `resolveTenantPriceList`:

```js
  // La lista efectiva del cliente sale de S/4 (PriceListType de su área de ventas); acá solo
  // vive lo que el tenant decide: el default cuando el cliente no tiene lista, el área de
  // ventas a usar si el cliente tiene varias, y las propiedades de HubSpot donde dejar rastro.
  async resolveS4PriceListConfig({ tenantModels }) {
    const value = await tenantConfigurationService.getValue(tenantModels, 's4PriceList', null);

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        'Configuration s4PriceList is required for the S4 line item price webhook,'
        + ' e.g. { "conditionType": "ZPR0", "defaultPriceListType": "ZC",'
        + ' "salesArea": { "salesOrganization": "FQCR", "distributionChannel": "01", "division": "SC" } }'
      );
    }

    const defaultPriceListType = toNonEmptyString(value.defaultPriceListType)?.toUpperCase() ?? null;

    if (!defaultPriceListType) {
      throw new Error('s4PriceList.defaultPriceListType is required');
    }

    const salesOrganization = toNonEmptyString(value.salesArea?.salesOrganization)?.toUpperCase() ?? null;
    const distributionChannel = toNonEmptyString(value.salesArea?.distributionChannel) ?? null;
    const division = toNonEmptyString(value.salesArea?.division)?.toUpperCase() ?? null;
    // Un área a medias filtraría mal y devolvería precios de otra organización: o está
    // completa o no está.
    const salesArea = salesOrganization && distributionChannel && division
      ? { salesOrganization, distributionChannel, division }
      : null;

    return {
      conditionType: toNonEmptyString(value.conditionType)?.toUpperCase() ?? 'ZPR0',
      defaultPriceListType,
      salesArea,
      priceListProperty: toNonEmptyString(value.priceListProperty),
      currencyProperty: toNonEmptyString(value.currencyProperty),
    };
  }
```

`toNonEmptyString` ya está definida arriba en ese archivo (línea 5) y devuelve `null` para vacíos, así que `?? null` cubre el caso.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/s4PriceListConfigRepository.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Documentar la clave en `configuration_examples.md`**

Agregar una entrada con el formato que ya usa ese archivo (descripción + ejemplo):

```markdown
### `s4PriceList`

Precios de line items para tenants S/4 (`sapFlavor: "S4"`). Solo la usa el webhook
`POST /webhooks/hubspot/line-items/prices/s4`; el flujo de B1 no la lee.

- `conditionType`: condición de precio de venta en SAP. En Multiquímica es `ZPR0`. Default `ZPR0`.
- `defaultPriceListType`: lista de precios a usar cuando el cliente no tiene una asignada en su
  área de ventas, o cuando la suya no tiene tarifa vigente para ese material. Obligatoria.
- `salesArea`: área de ventas a usar cuando el cliente tiene varias (un mismo cliente puede
  tener una lista distinta por organización de ventas). Si el cliente tiene una sola, se usa la
  suya y esta config se ignora. Las tres claves son obligatorias juntas.
- `priceListProperty`: propiedad del line item donde se escribe la lista efectivamente usada.
  Opcional.
- `currencyProperty`: propiedad del line item donde se escribe la moneda de la tarifa de SAP.
  Opcional pero muy recomendada: la tarifa no se convierte, viene en la moneda de la condición.

```json
{ "key": "s4PriceList", "value": {
    "conditionType": "ZPR0",
    "defaultPriceListType": "ZC",
    "salesArea": { "salesOrganization": "FQCR", "distributionChannel": "01", "division": "SC" },
    "priceListProperty": "lista_de_precios_sap",
    "currencyProperty": "moneda_precio_sap"
}}
```
```

- [ ] **Step 6: Punto de corte** — revisión del usuario. No commitear.

---

### Task 4: Caso de uso `SyncS4LineItemPricesByPriceList`

**Files:**
- Create: `src/application/use-cases/SyncS4LineItemPricesByPriceList.js`
- Test: `tests/unit/application/syncS4LineItemPricesByPriceList.test.js`

**Interfaces:**
- Consumes: `resolveS4PriceForMaterial` (Task 1); `S4PriceListClient` (Task 2) a través de una factory inyectada; `resolveS4PriceListConfig`, `resolveHubspotCredentials`, `resolveSapCredentials` del repositorio de config (Task 3 y métodos existentes); `HubspotLineItemPriceClient.getAccessToken/updateLineItems/updateDealAmount`; `buildErrorResponseSnapshot`, `buildWebhookSyncErrorEntry`, `buildLineItemPriceAudit`; `createSapCallRecorder`.
- Produces: `class SyncS4LineItemPricesByPriceList { async execute(payload, { tenantModels, tenant, tenantKey }) }` donde
  - `payload = { dealId, customer, lineItems: [{ id, itemCode, quantity }], lineItemFailures }`
  - retorna `{ data: { dealId, customer, salesArea, priceListType, totalAmount, lineItems, skippedLineItems }, meta: { requestedCount, updatedCount, skippedCount, dealUpdated }, audit }`

- [ ] **Step 1: Escribir el test que falla**

`tests/unit/application/syncS4LineItemPricesByPriceList.test.js`:

```js
import { jest } from '@jest/globals';
import SyncS4LineItemPricesByPriceList from '../../../src/application/use-cases/SyncS4LineItemPricesByPriceList.js';

const CANDIDATES_80000017 = [
  {
    conditionRecord: '0000418608',
    conditionTable: '502',
    priceListType: 'ZC',
    material: '80000017',
    conditionRateValue: 1.28,
    conditionCurrency: 'USD',
    conditionQuantity: 1,
    conditionQuantityUnit: 'KG',
    conditionIsDeleted: false,
  },
];

function buildDeps({
  salesAreas = [{ Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC', Currency: 'CRC' }],
  candidatesByMaterial = { 80000017: CANDIDATES_80000017 },
  config = {
    conditionType: 'ZPR0',
    defaultPriceListType: 'ZA',
    salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
    priceListProperty: 'lista_de_precios_sap',
    currencyProperty: 'moneda_precio_sap',
  },
} = {}) {
  const priceListClient = {
    fetchCustomerSalesAreas: jest.fn(async () => salesAreas),
    fetchConditionCandidates: jest.fn(async ({ material }) => candidatesByMaterial[material] ?? []),
  };

  const hubspotPriceClient = {
    getAccessToken: jest.fn(async () => 'token'),
    updateLineItems: jest.fn(async () => ({ payload: { inputs: [{ id: '1' }] }, response: { results: [{ id: '1' }] } })),
    updateDealAmount: jest.fn(async () => ({ payload: {}, response: {} })),
  };

  return {
    priceListClient,
    hubspotPriceClient,
    useCase: new SyncS4LineItemPricesByPriceList({
      credentialRepository: {
        resolveS4PriceListConfig: jest.fn(async () => config),
        resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
        resolveSapCredentials: jest.fn(async () => ({ serviceLayerBaseUrl: 'https://sap', serviceLayerUsername: 'u', serviceLayerPassword: 'p' })),
      },
      createPriceListClient: jest.fn(() => priceListClient),
      hubspotPriceClient,
      buildErrorResponseSnapshot: (error) => ({ message: error.message }),
      buildWebhookSyncErrorEntry: (entry) => entry,
      buildLineItemPriceAudit: (auditTrail) => auditTrail,
      dateProvider: () => new Date('2026-08-18T00:00:00.000Z'),
      logger: { warn: jest.fn(), info: jest.fn() },
    }),
  };
}

const CONTEXT = { tenantModels: {}, tenant: {}, tenantKey: 'multiquimica' };

describe('SyncS4LineItemPricesByPriceList', () => {
  it('escribe el precio de la lista del cliente y el total del deal', async () => {
    const { useCase, hubspotPriceClient } = buildDeps();

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 3 }] },
      CONTEXT
    );

    expect(result.data.lineItems).toEqual([
      expect.objectContaining({
        id: '1',
        itemCode: '80000017',
        quantity: 3,
        Price: 1.28,
        Currency: 'USD',
        lineTotal: 3.84,
        omitDiscount: true,
        additionalProperties: {
          lista_de_precios_sap: 'ZC',
          moneda_precio_sap: 'USD',
        },
      }),
    ]);
    expect(result.meta).toEqual({ requestedCount: 1, updatedCount: 1, skippedCount: 0, dealUpdated: true });
    expect(hubspotPriceClient.updateDealAmount).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: '77', totalAmount: 3.84 })
    );
  });

  it('usa la única área de ventas del cliente e ignora la configurada', async () => {
    const { useCase, priceListClient } = buildDeps({
      salesAreas: [{ Customer: '105049', SalesOrganization: 'MQGT', DistributionChannel: '02', Division: 'SC', PriceListType: 'ZB' }],
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], priceListType: 'ZB', conditionRateValue: 2 }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(priceListClient.fetchConditionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ salesArea: { salesOrganization: 'MQGT', distributionChannel: '02', division: 'SC' } })
    );
    expect(result.data.priceListType).toBe('ZB');
    expect(result.data.lineItems[0].Price).toBe(2);
  });

  it('cae a la lista default cuando el cliente no tiene PriceListType', async () => {
    const { useCase } = buildDeps({
      salesAreas: [{ Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: '' }],
      candidatesByMaterial: {
        80000017: [{ ...CANDIDATES_80000017[0], priceListType: 'ZA', conditionRateValue: 2.08 }],
      },
    });

    const result = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(result.data.priceListType).toBe('ZA');
    expect(result.data.lineItems[0].Price).toBe(2.08);
  });

  it('elige el área configurada cuando el cliente tiene varias', async () => {
    const { useCase, priceListClient } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC' },
      ],
    });

    await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    );

    expect(priceListClient.fetchConditionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' } })
    );
  });

  it('falla cuando el cliente tiene varias áreas y no hay ninguna configurada', async () => {
    const { useCase } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'FQCR', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZC' },
      ],
      config: { conditionType: 'ZPR0', defaultPriceListType: 'ZA', salesArea: null, priceListProperty: null, currencyProperty: null },
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('has 2 sales areas');
  });

  it('falla cuando el área configurada no pertenece al cliente', async () => {
    const { useCase } = buildDeps({
      salesAreas: [
        { Customer: '105049', SalesOrganization: 'CPDO', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZD' },
        { Customer: '105049', SalesOrganization: 'MQGT', DistributionChannel: '01', Division: 'SC', PriceListType: 'ZB' },
      ],
    });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('does not belong to customer');
  });

  it('falla cuando el cliente no tiene áreas de venta en SAP', async () => {
    const { useCase } = buildDeps({ salesAreas: [] });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('has no sales areas');
  });

  it('saltea la línea sin tarifa y escribe las demás', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({
      candidatesByMaterial: { 80000017: CANDIDATES_80000017, 99999999: [] },
    });

    const result = await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '99999999', quantity: 1 },
        ],
      },
      CONTEXT
    );

    expect(result.data.lineItems).toHaveLength(1);
    expect(result.data.skippedLineItems).toEqual([
      {
        id: '2',
        itemCode: '99999999',
        reason: 'no ZPR0 condition record for the customer price list, the default price list or the product default',
        priceListType: 'ZC',
        defaultPriceListType: 'ZA',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
      },
    ]);
    expect(result.meta.skippedCount).toBe(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalled();
  });

  it('falla cuando ninguna línea se pudo valorizar', async () => {
    const { useCase, hubspotPriceClient } = buildDeps({ candidatesByMaterial: {} });

    await expect(useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    )).rejects.toThrow('No line item prices could be resolved');

    expect(hubspotPriceClient.updateLineItems).not.toHaveBeenCalled();
  });

  it('pide las tarifas UNA vez por material aunque haya dos líneas del mismo producto', async () => {
    const { useCase, priceListClient } = buildDeps();

    await useCase.execute(
      {
        dealId: '77',
        customer: '105049',
        lineItems: [
          { id: '1', itemCode: '80000017', quantity: 1 },
          { id: '2', itemCode: '80000017', quantity: 2 },
        ],
      },
      CONTEXT
    );

    expect(priceListClient.fetchConditionCandidates).toHaveBeenCalledTimes(1);
  });

  it('cuelga el detalle del error en syncLogWebhookErrors', async () => {
    const { useCase } = buildDeps({ salesAreas: [] });

    const error = await useCase.execute(
      { dealId: '77', customer: '105049', lineItems: [{ id: '1', itemCode: '80000017', quantity: 1 }] },
      CONTEXT
    ).catch((caught) => caught);

    expect(error.syncLogWebhookErrors).toHaveLength(1);
    expect(error.syncLogWebhookErrors[0].payloadHubspot).toEqual({ dealId: '77', customer: '105049' });
    expect(error.lineItemPriceAudit).toBeTruthy();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncS4LineItemPricesByPriceList.test.js`
Expected: FAIL — no existe el módulo.

- [ ] **Step 3: Implementar**

`src/application/use-cases/SyncS4LineItemPricesByPriceList.js`:

```js
import { resolveS4PriceForMaterial } from '#domain/prices/s4-price-resolution.service.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

const NO_PRICE_REASON = 'no ZPR0 condition record for the customer price list,'
  + ' the default price list or the product default';

function normalizeQuantity(value) {
  const normalized = normalizeNumber(value, 0);
  return normalized > 0 ? normalized : 1;
}

function roundCurrency(value) {
  return Math.round((normalizeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function toSalesAreaKey(salesArea) {
  return [
    toNonEmptyString(salesArea?.salesOrganization)?.toUpperCase() ?? '',
    toNonEmptyString(salesArea?.distributionChannel) ?? '',
    toNonEmptyString(salesArea?.division)?.toUpperCase() ?? '',
  ].join('|');
}

function toSalesArea(row) {
  return {
    salesOrganization: toNonEmptyString(row?.SalesOrganization)?.toUpperCase() ?? null,
    distributionChannel: toNonEmptyString(row?.DistributionChannel) ?? null,
    division: toNonEmptyString(row?.Division)?.toUpperCase() ?? null,
  };
}

// Un cliente puede tener una lista de precios distinta por organización de ventas (100053 es
// ZD en CPDO y ZB en DPDO), así que con más de un área hay que elegir explícitamente. Con una
// sola se usa la del cliente y la config no interviene: es el caso simple y no queremos que
// una config vieja lo rompa.
function chooseSalesAreaRow(rows, configuredSalesArea, customer) {
  if (rows.length === 0) {
    throw new Error(`Customer ${customer} has no sales areas in SAP`);
  }

  if (rows.length === 1) {
    return rows[0];
  }

  if (!configuredSalesArea) {
    throw new Error(
      `Customer ${customer} has ${rows.length} sales areas in SAP;`
      + ' configure s4PriceList.salesArea to choose one'
    );
  }

  const wanted = toSalesAreaKey(configuredSalesArea);
  const match = rows.find((row) => toSalesAreaKey(toSalesArea(row)) === wanted);

  if (!match) {
    throw new Error(
      `Configured s4PriceList.salesArea ${wanted} does not belong to customer ${customer}`
    );
  }

  return match;
}

export class SyncS4LineItemPricesByPriceList {
  constructor({
    credentialRepository,
    createPriceListClient,
    hubspotPriceClient,
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
    buildLineItemPriceAudit = () => null,
    createSapCallRecorder = () => ({ record: (_options, run) => run(), calls: [], droppedCalls: 0 }),
    dateProvider = () => new Date(),
    logger = { warn: () => {} },
  }) {
    this.credentialRepository = credentialRepository;
    this.createPriceListClient = createPriceListClient;
    this.hubspotPriceClient = hubspotPriceClient;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildLineItemPriceAudit = buildLineItemPriceAudit;
    this.createSapCallRecorder = createSapCallRecorder;
    this.dateProvider = dateProvider;
    this.logger = logger;
  }

  async execute(payload, { tenantModels, tenant, tenantKey }) {
    const dealId = toNonEmptyString(payload?.dealId);
    const customer = toNonEmptyString(payload?.customer);
    const lineItems = Array.isArray(payload?.lineItems) ? payload.lineItems : [];
    // El grabador se crea por invocación y viaja por parámetro, nunca en `this`: el caso de
    // uso es singleton en composition y guardarlo mezclaría el tráfico de un tenant con otro.
    const callRecorder = this.createSapCallRecorder();
    const auditTrail = {
      dealId,
      cardCode: customer,
      rounds: [],
      calls: callRecorder.calls,
      unresolved: Array.isArray(payload?.lineItemFailures) ? payload.lineItemFailures : [],
      amount: null,
      fatalError: null,
    };

    try {
      if (!dealId) {
        throw new Error('dealId is required');
      }

      if (!customer) {
        throw new Error('customer is required');
      }

      if (lineItems.length === 0) {
        throw new Error('lineItems must be a non-empty array');
      }

      const config = await this.credentialRepository.resolveS4PriceListConfig({ tenantModels });
      const hubspotCredentials = await this.credentialRepository.resolveHubspotCredentials({
        tenantModels,
        tenant,
      });
      const sapCredentials = await this.credentialRepository.resolveSapCredentials({
        tenantModels,
        hubspotCredentials,
      });
      const token = await this.hubspotPriceClient.getAccessToken({
        hubspotCredentials,
        tenantModels,
      });
      const sapConfig = {
        ...(typeof sapCredentials?.toObject === 'function' ? sapCredentials.toObject() : sapCredentials),
        tenantKey,
      };
      const priceListClient = this.createPriceListClient({ sapConfig });
      const salesAreaRows = await callRecorder.record(
        { target: 'sap', method: 'GET', path: '/API_BUSINESS_PARTNER/A_CustomerSalesArea', params: { customer } },
        () => priceListClient.fetchCustomerSalesAreas(customer)
      );
      const salesAreaRow = chooseSalesAreaRow(
        Array.isArray(salesAreaRows) ? salesAreaRows : [],
        config.salesArea,
        customer
      );
      const salesArea = toSalesArea(salesAreaRow);
      // Vacío es un dato, no un error: 40 de los 5000 clientes revisados no tienen lista.
      const customerPriceListType = toNonEmptyString(salesAreaRow?.PriceListType)?.toUpperCase()
        ?? config.defaultPriceListType;
      const date = this.dateProvider();
      const candidatesByMaterial = new Map();
      const enrichedLineItems = [];
      const skippedLineItems = [];

      for (const lineItem of lineItems) {
        const itemCode = toNonEmptyString(lineItem?.itemCode);
        const id = toNonEmptyString(lineItem?.id);

        if (!itemCode || !id) {
          skippedLineItems.push({
            id: id ?? null,
            itemCode: itemCode ?? null,
            reason: 'line item has no id or hs_sku',
            priceListType: customerPriceListType,
            defaultPriceListType: config.defaultPriceListType,
            salesArea,
          });
          continue;
        }

        // Caché por material: cliente, área y fecha son fijos en la invocación, así que dos
        // líneas del mismo producto comparten el resultado y no repiten las dos llamadas.
        if (!candidatesByMaterial.has(itemCode)) {
          // eslint-disable-next-line no-await-in-loop
          const candidates = await callRecorder.record(
            {
              target: 'sap',
              method: 'GET',
              path: '/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity',
              params: { material: itemCode, conditionType: config.conditionType, salesArea },
            },
            () => priceListClient.fetchConditionCandidates({
              conditionType: config.conditionType,
              material: itemCode,
              salesArea,
              date,
            })
          );
          candidatesByMaterial.set(itemCode, candidates);
        }

        const resolved = resolveS4PriceForMaterial({
          candidates: candidatesByMaterial.get(itemCode),
          customerPriceListType,
          defaultPriceListType: config.defaultPriceListType,
        });

        if (!resolved) {
          this.logger.warn?.({
            msg: 'Line item skipped: no S4 price condition record found',
            tenantKey,
            dealId,
            lineItemId: id,
            itemCode,
            customerPriceListType,
            defaultPriceListType: config.defaultPriceListType,
            salesArea,
          });
          skippedLineItems.push({
            id,
            itemCode,
            reason: NO_PRICE_REASON,
            priceListType: customerPriceListType,
            defaultPriceListType: config.defaultPriceListType,
            salesArea,
          });
          continue;
        }

        const quantity = normalizeQuantity(lineItem?.quantity);
        const price = roundCurrency(resolved.price);

        enrichedLineItems.push({
          id,
          itemCode,
          quantity,
          Price: price,
          // La moneda es la de la condición en SAP y NO se convierte: no hay API de tipos de
          // cambio activada, y un tipo de cambio propio genera diferencias contra la factura.
          Currency: resolved.currency,
          lineTotal: roundCurrency(quantity * price),
          priceListType: resolved.priceListType,
          priceSource: resolved.source,
          conditionRecord: resolved.conditionRecord,
          // El flujo no gestiona descuentos: los maneja HubSpot nativamente.
          omitDiscount: true,
          additionalProperties: {
            ...(config.priceListProperty && resolved.priceListType
              ? { [config.priceListProperty]: resolved.priceListType }
              : {}),
            ...(config.currencyProperty && resolved.currency
              ? { [config.currencyProperty]: resolved.currency }
              : {}),
          },
        });
      }

      auditTrail.rounds = [{ salesArea, customerPriceListType, enrichedLineItems, skippedLineItems }];

      if (enrichedLineItems.length === 0) {
        throw new Error('No line item prices could be resolved from S4 condition records');
      }

      const hubspotUpdate = await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/line_items/batch/update' },
        () => this.hubspotPriceClient.updateLineItems({ token, enrichedLineItems, tenantKey })
      );
      const totalAmount = roundCurrency(
        enrichedLineItems.reduce((sum, lineItem) => sum + lineItem.lineTotal, 0)
      );
      const dealUpdate = await callRecorder.record(
        { target: 'hubspot', method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}` },
        () => this.hubspotPriceClient.updateDealAmount({ token, dealId, totalAmount, tenantKey })
      );

      auditTrail.amount = { totalAmount, response: dealUpdate?.response ?? null };

      return {
        data: {
          dealId,
          customer,
          salesArea,
          priceListType: customerPriceListType,
          totalAmount,
          lineItems: enrichedLineItems,
          skippedLineItems,
        },
        meta: {
          requestedCount: lineItems.length,
          updatedCount: Array.isArray(hubspotUpdate?.response?.results)
            ? hubspotUpdate.response.results.length
            : enrichedLineItems.length,
          skippedCount: skippedLineItems.length,
          dealUpdated: true,
        },
        // buildLineItemPriceAudit es obligatorio: pasa el árbol por sanitizeAuditKeys, que
        // renombra las claves `$filter`/`$select` del tráfico OData. Sin eso el $set del
        // WebhookEvent se cae completo contra el Mongo de producción (< 5.0).
        audit: this.buildLineItemPriceAudit({ ...auditTrail, droppedCalls: callRecorder.droppedCalls }),
      };
    } catch (error) {
      auditTrail.fatalError = {
        message: error.message,
        status: error?.response?.status ?? null,
        endpoint: error?.details?.endpoint ?? null,
      };

      error.lineItemPriceAudit = this.buildLineItemPriceAudit({
        ...auditTrail,
        droppedCalls: callRecorder.droppedCalls,
      });
      error.syncLogWebhookErrors = [
        this.buildWebhookSyncErrorEntry({
          payloadHubspot: { dealId, customer },
          payloadSap: callRecorder.calls,
          responseHubspot: null,
          responseSap: this.buildErrorResponseSnapshot(error),
        }),
      ];

      throw error;
    }
  }
}

export default SyncS4LineItemPricesByPriceList;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncS4LineItemPricesByPriceList.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Punto de corte** — revisión del usuario. No commitear.

---

### Task 5: Webhook — clasificación, dedupe, debounce y armado del payload

**Files:**
- Create: `src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js`
- Test: `tests/unit/infrastructure/s4PriceListLineItemPriceWebhook.test.js`

**Interfaces:**
- Consumes: helpers de `#infrastructure/webhook/lineItemPriceWebhook.shared.js` (`assertRequiredWebhookField`, `buildDuplicateFilter`, `extractAssociationIds`, `extractLineItemAssociationIds`, `fetchHubspotObject`, `resolveHubspotCredentials`, `readLineItems`, `toNonEmptyString`, `toNumberOrNull`); `hubspotAuthService`; `tenantConfigurationService`; `lineItemPriceWebhookService.markAsSent/markAsError` (solo lectura, se delega sin modificarlo).
- Produces: `s4PriceListLineItemPriceWebhookService` con
  - `preparePayload(payload, { tenantModels, tenant, tenantKey }) => { skip, payload, executionId, meta }`
  - `markAsSent(LineItemPriceWebhookEvent, executionId, audit)`
  - `markAsError(LineItemPriceWebhookEvent, executionId, error, audit)`
  - payload producido: `{ dealId, customer, lineItems: [{ id, itemCode, quantity }], lineItemFailures }`

- [ ] **Step 1: Escribir el test que falla**

`tests/unit/infrastructure/s4PriceListLineItemPriceWebhook.test.js`:

```js
import { jest } from '@jest/globals';
import { S4PriceListLineItemPriceWebhookService } from '../../../src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js';

const ASSOCIATION_EVENT = {
  eventId: 1,
  subscriptionId: 2,
  portalId: 3,
  appId: 4,
  occurredAt: 5,
  fromObjectId: '77',
  associationType: 'DEAL_TO_LINE_ITEM',
  changeSource: 'USER',
};

function buildTenantModels({ duplicate = null, recent = null } = {}) {
  const findOne = jest.fn().mockImplementation((filter) => ({
    select: () => ({
      lean: async () => (filter.dealId ? recent : duplicate),
    }),
  }));

  return {
    LineItemPriceWebhookEvent: {
      findOne,
      create: jest.fn(async (doc) => ({ _id: 'event-1', ...doc })),
      updateOne: jest.fn(async () => ({})),
    },
  };
}

function buildService({
  deal = {
    id: '77',
    associations: {
      companies: { results: [{ id: '900' }] },
      'line items': { results: [{ id: '1' }, { id: '2' }] },
    },
  },
  company = { id: '900', properties: { idsap: '105049' } },
  lineItems = {
    lineItems: [
      { id: '1', itemCode: '80000017', quantity: '3' },
      { id: '2', itemCode: '80000029', quantity: '1' },
    ],
    failures: [],
  },
} = {}) {
  const fetchHubspotObject = jest.fn(async (_token, objectType) => (
    objectType === 'deals' ? deal : company
  ));

  return {
    fetchHubspotObject,
    service: new S4PriceListLineItemPriceWebhookService({
      hubspotAuth: { getAccessToken: jest.fn(async () => 'token') },
      tenantConfiguration: { getValue: jest.fn(async (_models, _key, fallback) => fallback) },
      resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
      fetchHubspotObject,
      readLineItems: jest.fn(async () => lineItems),
      log: { info: jest.fn(), warn: jest.fn() },
    }),
  };
}

describe('S4PriceListLineItemPriceWebhookService.preparePayload', () => {
  it('arma el payload con el cliente del idsap de la company y las líneas del deal', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result.skip).toBe(false);
    expect(result.executionId).toBe('event-1');
    expect(result.payload).toEqual({
      dealId: '77',
      customer: '105049',
      lineItems: [
        { id: '1', itemCode: '80000017', quantity: '3' },
        { id: '2', itemCode: '80000029', quantity: '1' },
      ],
      lineItemFailures: [],
    });
  });

  it('ignora eventos que no son de asociación deal→line item ni property change soportado', async () => {
    const { service } = buildService();

    const result = await service.preparePayload(
      { ...ASSOCIATION_EVENT, associationType: 'DEAL_TO_CONTACT' },
      { tenantModels: buildTenantModels(), tenant: {}, tenantKey: 'multiquimica' }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'unsupported_event' },
    });
  });

  it('saltea el duplicado SIN insertar un documento (el índice único lo rechazaría)', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels({ duplicate: { _id: 'previo' } });

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'duplicate_event', duplicateOf: 'previo' },
    });
    // El esquema tiene un índice único sobre las claves del evento de asociación: insertar la
    // marca de duplicado daría E11000 en vez de un skip.
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('debouncea cuando ya hubo una ejecución reciente del mismo deal', async () => {
    const service = new S4PriceListLineItemPriceWebhookService({
      hubspotAuth: { getAccessToken: jest.fn(async () => 'token') },
      tenantConfiguration: { getValue: jest.fn(async () => ({ requireSkipped: true, secondsToSkipped: 3 })) },
      resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
      fetchHubspotObject: jest.fn(async () => ({})),
      readLineItems: jest.fn(),
      log: { info: jest.fn(), warn: jest.fn() },
    });
    const tenantModels = buildTenantModels({ recent: { _id: 'reciente' } });

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'debounced_event', dealId: '77' },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('falla cuando el deal no tiene company ni contacto con idsap, y deja el fallo en el evento', async () => {
    const { service } = buildService({
      deal: { id: '77', associations: { 'line items': { results: [{ id: '1' }] } } },
      company: { id: '900', properties: {} },
    });
    const tenantModels = buildTenantModels();

    await expect(service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    })).rejects.toThrow('Deal has no associated SAP customer');

    // El evento se creó antes de leer HubSpot, así que el fallo queda diagnosticable.
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      { $set: { isSend: false, errorMessage: expect.stringContaining('Deal has no associated SAP customer') } }
    );
  });

  it('falla cuando el deal no tiene líneas legibles y adjunta los fallos', async () => {
    const { service } = buildService({
      lineItems: { lineItems: [], failures: [{ id: '1', stage: 'hubspot_read', reason: 'boom' }] },
    });

    const error = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels: buildTenantModels(),
      tenant: {},
      tenantKey: 'multiquimica',
    }).catch((caught) => caught);

    expect(error.message).toBe('Deal has no readable line items');
    expect(error.lineItemFailures).toEqual([{ id: '1', stage: 'hubspot_read', reason: 'boom' }]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/s4PriceListLineItemPriceWebhook.test.js`
Expected: FAIL — no existe el módulo.

- [ ] **Step 3: Implementar**

`src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js`:

```js
import hubspotAuthService from '../hubspot/hubspotAuthService.js';
import tenantConfigurationService from '../config/tenantConfiguration.service.js';
import logger from '../logger/logger.js';
import lineItemPriceWebhookService from './lineItemPriceWebhook.service.js';
import {
  assertRequiredWebhookField,
  buildDuplicateFilter,
  extractAssociationIds,
  extractLineItemAssociationIds,
  fetchHubspotObject as defaultFetchHubspotObject,
  readLineItems as defaultReadLineItems,
  resolveHubspotCredentials as defaultResolveHubspotCredentials,
  toNonEmptyString,
  toNumberOrNull,
} from './lineItemPriceWebhook.shared.js';

const SUPPORTED_ASSOCIATION_TYPE = 'DEAL_TO_LINE_ITEM';
const SUPPORTED_ASSOCIATION_CHANGE_SOURCE = 'USER';
const SUPPORTED_LINE_ITEM_SUBSCRIPTION = 'line_item.propertyChange';
const SUPPORTED_LINE_ITEM_PROPERTY = 'quantity';
// CRM_UI evita bucles: las escrituras del propio integrador llegan con changeSource INTEGRATION.
const SUPPORTED_PROPERTY_CHANGE_SOURCE = 'CRM_UI';

const DEBOUNCE_CONFIG_KEY = 'requireSkippedInWebhooksInPropertyChange';
const DEBOUNCE_DEFAULT = { requireSkipped: true, secondsToSkipped: 3 };
const DUPLICATE_ERROR_MESSAGE = 'Duplicate event';
const DEBOUNCED_ERROR_MESSAGE = 'evento skipeado por envios multiples';

function skipResult(reason, extraMeta = {}) {
  return {
    skip: true,
    payload: null,
    executionId: null,
    meta: { skipped: true, reason, ...extraMeta },
  };
}

function classifyEvent(payload = {}) {
  if (
    payload?.associationType === SUPPORTED_ASSOCIATION_TYPE
    && payload?.changeSource === SUPPORTED_ASSOCIATION_CHANGE_SOURCE
  ) {
    return 'association';
  }

  if (
    payload?.subscriptionType === SUPPORTED_LINE_ITEM_SUBSCRIPTION
    && payload?.propertyName === SUPPORTED_LINE_ITEM_PROPERTY
    && payload?.changeSource === SUPPORTED_PROPERTY_CHANGE_SOURCE
  ) {
    return 'lineItemPropertyChange';
  }

  return null;
}

// El número de cliente de S/4 (`Customer` / `BusinessPartner`) viaja en HubSpot en `idsap`,
// igual que el CardCode de B1: mismo mecanismo, company primero y contacto como respaldo.
function resolveObjectIdSap(record) {
  return toNonEmptyString(record?.properties?.idsap)
    || toNonEmptyString(record?.properties?.idSap);
}

export class S4PriceListLineItemPriceWebhookService {
  constructor({
    hubspotAuth = hubspotAuthService,
    tenantConfiguration = tenantConfigurationService,
    resolveHubspotCredentials = defaultResolveHubspotCredentials,
    fetchHubspotObject = defaultFetchHubspotObject,
    readLineItems = defaultReadLineItems,
    log = logger,
  } = {}) {
    this.hubspotAuth = hubspotAuth;
    this.tenantConfiguration = tenantConfiguration;
    this.resolveHubspotCredentials = resolveHubspotCredentials;
    this.fetchHubspotObject = fetchHubspotObject;
    this.readLineItems = readLineItems;
    this.log = log;
  }

  async preparePayload(payload, { tenantModels, tenant, tenantKey }) {
    const eventKind = classifyEvent(payload);

    if (!eventKind) {
      return skipResult('unsupported_event');
    }

    assertRequiredWebhookField(payload, 'portalId');
    assertRequiredWebhookField(payload, 'eventId');
    assertRequiredWebhookField(payload, 'subscriptionId');
    assertRequiredWebhookField(payload, 'appId');
    assertRequiredWebhookField(payload, 'occurredAt');
    assertRequiredWebhookField(payload, eventKind === 'association' ? 'fromObjectId' : 'objectId');

    const { LineItemPriceWebhookEvent } = tenantModels;
    const duplicate = await this.findDuplicate(LineItemPriceWebhookEvent, payload, eventKind);

    if (duplicate) {
      // A diferencia del flujo B1, acá NO se inserta un documento marca de duplicado. El
      // esquema tiene un índice ÚNICO sobre (eventId, subscriptionId, portalId, appId,
      // occurredAt, fromObjectId) y los eventos de asociación traen las seis claves, así que
      // ese insert choca con E11000 y la excepción reemplaza al skip. El duplicado ya está
      // identificado por el documento que encontró findDuplicate.
      this.log.info?.({
        msg: 'S4 line item price webhook: duplicate event ignored',
        reason: DUPLICATE_ERROR_MESSAGE,
        duplicateOf: String(duplicate._id),
        eventKind,
      });

      return skipResult('duplicate_event', { duplicateOf: String(duplicate._id) });
    }

    const token = await this.resolveToken({ tenantModels, tenant });
    const dealId = await this.resolveDealId(payload, eventKind, token);

    if (!dealId) {
      await LineItemPriceWebhookEvent.create({
        payload,
        isSend: false,
        errorMessage: 'Line item has no associated deal',
      });

      throw new Error('Line item has no associated deal');
    }

    const debounced = await this.isDebounced(LineItemPriceWebhookEvent, dealId, tenantModels);

    if (debounced) {
      // Tampoco se inserta marca acá, por el mismo índice único: la ventana de debounce solo
      // cuenta documentos con errorMessage null, así que la marca no aportaba nada al cálculo.
      this.log.info?.({
        msg: 'S4 line item price webhook: event debounced',
        reason: DEBOUNCED_ERROR_MESSAGE,
        dealId,
        eventKind,
      });

      return skipResult('debounced_event', { dealId });
    }

    // Se crea ANTES de leer HubSpot por dos razones: los webhooks concurrentes del mismo deal
    // se debouncean contra este registro, y un fallo de lectura (deal sin cliente, líneas
    // ilegibles) queda asentado en el evento en vez de morir solo en el SyncLog. El recálculo
    // es idempotente: siempre parte de los precios de SAP.
    const createdEvent = await LineItemPriceWebhookEvent.create({
      payload,
      dealId,
      isSend: false,
      errorMessage: null,
    });

    try {
      const deal = await this.fetchHubspotObject(token, 'deals', dealId, {
        associations: ['companies', 'contacts', 'line_items'],
      });
      // El cliente se resuelve ANTES de tocar las líneas: sin cliente no hay lista de precios
      // que aplicar y el evento se rechaza sin importar el estado de las líneas.
      const customer = await this.resolveCustomer(token, deal);

      if (!customer) {
        throw new Error('Deal has no associated SAP customer (idsap on company or contact)');
      }

      const lineItemIds = extractLineItemAssociationIds(deal);

      if (lineItemIds.length === 0) {
        throw new Error('Deal has no associated line items');
      }

      const { lineItems, failures } = await this.readLineItems({ token, lineItemIds });

      if (lineItems.length === 0) {
        // Los fallos van PEGADOS al error: son los que llevan endpoint y status de cada 404.
        throw Object.assign(new Error('Deal has no readable line items'), {
          lineItemFailures: failures,
        });
      }

      return {
        skip: false,
        payload: {
          dealId,
          customer,
          lineItems: lineItems.map((lineItem) => ({
            id: lineItem.id,
            itemCode: lineItem.itemCode,
            quantity: lineItem.quantity,
          })),
          lineItemFailures: failures,
        },
        executionId: createdEvent._id,
        meta: { eventKind, dealId, customer },
      };
    } catch (error) {
      await LineItemPriceWebhookEvent.updateOne(
        { _id: createdEvent._id },
        { $set: { isSend: false, errorMessage: error.message } }
      );

      throw error;
    }
  }

  async resolveToken({ tenantModels, tenant }) {
    const hubspotCredentials = await this.resolveHubspotCredentials(tenantModels, tenant);

    return this.hubspotAuth.getAccessToken(
      hubspotCredentials.clientConfigId,
      hubspotCredentials,
      tenantModels
    );
  }

  async resolveDealId(payload, eventKind, token) {
    if (eventKind === 'association') {
      return toNonEmptyString(payload.fromObjectId);
    }

    const lineItem = await this.fetchHubspotObject(token, 'line_items', payload.objectId, {
      associations: ['deals'],
    });

    return extractAssociationIds(lineItem, 'deals')[0] ?? null;
  }

  async resolveCustomer(token, deal) {
    const companyIds = extractAssociationIds(deal, 'companies');

    if (companyIds.length > 0) {
      const company = await this.fetchHubspotObject(token, 'companies', companyIds[0], {
        properties: ['idsap', 'idSap'],
      });
      const customer = resolveObjectIdSap(company);

      if (customer) {
        return customer;
      }
    }

    const contactIds = extractAssociationIds(deal, 'contacts');

    if (contactIds.length > 0) {
      const contact = await this.fetchHubspotObject(token, 'contacts', contactIds[0], {
        properties: ['idsap', 'idSap'],
      });

      return resolveObjectIdSap(contact);
    }

    return null;
  }

  async findDuplicate(LineItemPriceWebhookEvent, payload, eventKind) {
    const filter = eventKind === 'association'
      ? buildDuplicateFilter(payload)
      : {
        'payload.objectId': payload.objectId,
        'payload.sourceId': payload.sourceId,
        'payload.propertyValue': payload.propertyValue,
        'payload.occurredAt': payload.occurredAt,
      };

    return LineItemPriceWebhookEvent.findOne({
      ...filter,
      $or: [{ isSend: true }, { errorMessage: null }],
    }).select({ _id: 1 }).lean();
  }

  async isDebounced(LineItemPriceWebhookEvent, dealId, tenantModels) {
    const debounceConfig = await this.tenantConfiguration.getValue(
      tenantModels,
      DEBOUNCE_CONFIG_KEY,
      DEBOUNCE_DEFAULT
    );

    if (debounceConfig?.requireSkipped !== true) {
      return false;
    }

    const secondsToSkipped = toNumberOrNull(debounceConfig?.secondsToSkipped)
      ?? DEBOUNCE_DEFAULT.secondsToSkipped;

    const recentExecution = await LineItemPriceWebhookEvent.findOne({
      dealId,
      createdAt: { $gte: new Date(Date.now() - secondsToSkipped * 1000) },
      errorMessage: null,
    }).select({ _id: 1 }).lean();

    return Boolean(recentExecution);
  }

  // Persistencia del cierre del evento: se delega en el servicio B1 sin modificarlo, porque
  // escribe sobre el mismo modelo LineItemPriceWebhookEvent y ya pasa el audit por persistAudit.
  markAsSent(LineItemPriceWebhookEvent, executionId, audit = null) {
    return lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, executionId, audit);
  }

  markAsError(LineItemPriceWebhookEvent, executionId, error, audit = null) {
    return lineItemPriceWebhookService.markAsError(
      LineItemPriceWebhookEvent,
      executionId,
      error,
      audit
    );
  }
}

export const s4PriceListLineItemPriceWebhookService = new S4PriceListLineItemPriceWebhookService();

export default s4PriceListLineItemPriceWebhookService;
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/s4PriceListLineItemPriceWebhook.test.js`
Expected: PASS, 6 tests.

`extractLineItemAssociationIds` acepta las variantes de nombre que devuelve HubSpot (`line items`, `line_items`); si la fixture del deal no matchea, revisar
[hubspot-associations.utils.js](../../../src/shared/utils/hubspot-associations.utils.js) y ajustar la fixture, no el código.

- [ ] **Step 5: Punto de corte** — revisión del usuario. No commitear.

---

### Task 6: Composición, ruta y test de wiring

**Files:**
- Create: `src/composition/s4-line-item-prices.composition.js`
- Modify: `src/interfaces/http/routes/lineItemPrice.routes.js`
- Test: `tests/unit/composition/s4LineItemPricesComposition.test.js`

**Interfaces:**
- Consumes: todo lo anterior, más `createLineItemPriceController` ([lineItemPrice.controller.js:11](../../../src/interfaces/http/controllers/lineItemPrice.controller.js)), `createSapTransport`, `SAP_FLAVORS`, `createSapCallRecorder`, `syncLogAdapter`, `requestTenantModelsAdapter`.
- Produces: `buildSyncS4LineItemPrices({ syncLogGateway })`, `buildS4LineItemPriceController()` y la ruta `POST /webhooks/hubspot/line-items/prices/s4`.

- [ ] **Step 1: Escribir el test que falla**

`tests/unit/composition/s4LineItemPricesComposition.test.js`:

```js
import {
  buildSyncS4LineItemPrices,
} from '../../../src/composition/s4-line-item-prices.composition.js';
import { S4PriceListClient } from '../../../src/infrastructure/sap/S4PriceListClient.js';

describe('s4-line-item-prices.composition', () => {
  it('cablea las dependencias reales del caso de uso, no objetos vacíos', () => {
    const useCase = buildSyncS4LineItemPrices();

    // El repositorio tiene que ser el que sabe leer la config s4PriceList.
    expect(typeof useCase.credentialRepository.resolveS4PriceListConfig).toBe('function');
    expect(typeof useCase.credentialRepository.resolveHubspotCredentials).toBe('function');
    expect(typeof useCase.credentialRepository.resolveSapCredentials).toBe('function');
    // El audit DEBE pasar por buildLineItemPriceAudit: es quien sanea las claves `$` del
    // tráfico OData antes del $set sobre el WebhookEvent.
    expect(typeof useCase.buildLineItemPriceAudit).toBe('function');
    expect(typeof useCase.createSapCallRecorder).toBe('function');
    expect(typeof useCase.hubspotPriceClient.updateLineItems).toBe('function');
    expect(typeof useCase.hubspotPriceClient.updateDealAmount).toBe('function');
  });

  it('la factory del cliente construye un S4PriceListClient con transporte S4', () => {
    const useCase = buildSyncS4LineItemPrices();

    const client = useCase.createPriceListClient({
      sapConfig: { serviceLayerBaseUrl: 'https://vhmldqs4ci.hec.multidomsa.com:44300' },
    });

    expect(client).toBeInstanceOf(S4PriceListClient);
    expect(typeof client.transport.fetchAll).toBe('function');
  });

  it('el audit cableado sanea las claves $ del query OData', () => {
    const useCase = buildSyncS4LineItemPrices();

    const audit = useCase.buildLineItemPriceAudit({
      dealId: '77',
      calls: [{ target: 'sap', method: 'GET', path: '/x', params: { $filter: "Material eq '1'" } }],
    });

    expect(JSON.stringify(audit)).not.toContain('"$filter"');
    expect(JSON.stringify(audit)).toContain('_$filter');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/composition/s4LineItemPricesComposition.test.js`
Expected: FAIL — no existe la composición.

- [ ] **Step 3: Implementar la composición**

`src/composition/s4-line-item-prices.composition.js`:

```js
import SyncS4LineItemPricesByPriceList from '#application/use-cases/SyncS4LineItemPricesByPriceList.js';
import HubspotLineItemPriceClient from '#infrastructure/external-services/HubspotLineItemPriceClient.js';
import S4PriceListClient from '#infrastructure/sap/S4PriceListClient.js';
import TenantLineItemPriceConfigRepository from '#infrastructure/repositories/TenantLineItemPriceConfigRepository.js';
import { createSapTransport } from '#infrastructure/sap/transport/sapTransportFactory.js';
import { createSapCallRecorder } from '#infrastructure/sap/sapCallRecorder.js';
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import logger from '#infrastructure/logger/logger.js';
import syncLogAdapter from '#infrastructure/sync/SyncLogAdapter.js';
import requestTenantModelsAdapter from '#infrastructure/tenants/RequestTenantModelsAdapter.js';
import s4PriceListLineItemPriceWebhookService from '#infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js';
import {
  buildErrorResponseSnapshot,
  buildLineItemPriceAudit,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';

// El transporte se arma por invocación porque las credenciales son del tenant que llega en el
// request, no de la composición: mismo criterio que S4ContactEnrichmentAdapter.
export function createS4PriceListClient({ sapConfig }) {
  return new S4PriceListClient({
    transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config: sapConfig }),
  });
}

export function buildSyncS4LineItemPrices({ syncLogGateway } = {}) {
  return new SyncS4LineItemPricesByPriceList({
    credentialRepository: new TenantLineItemPriceConfigRepository(),
    createPriceListClient: createS4PriceListClient,
    hubspotPriceClient: new HubspotLineItemPriceClient(),
    buildErrorResponseSnapshot: syncLogGateway
      ? (error) => syncLogGateway.buildErrorResponseSnapshot(error)
      : buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry: syncLogGateway
      ? (entry) => syncLogGateway.buildWebhookSyncErrorEntry(entry)
      : buildWebhookSyncErrorEntry,
    buildLineItemPriceAudit,
    createSapCallRecorder,
    logger,
  });
}

export function buildS4LineItemPriceControllerDependencies({
  tenantModelsResolver = requestTenantModelsAdapter,
  webhookPayload = s4PriceListLineItemPriceWebhookService,
  syncLogGateway = syncLogAdapter,
  syncLineItemPrices,
} = {}) {
  return {
    tenantModelsResolver,
    webhookPayload,
    syncLogGateway,
    syncLineItemPrices: syncLineItemPrices || buildSyncS4LineItemPrices({ syncLogGateway }),
  };
}

export default buildSyncS4LineItemPrices;
```

- [ ] **Step 4: Registrar la ruta**

En `src/interfaces/http/routes/lineItemPrice.routes.js`, agregar el segundo `app.post` sin tocar el primero:

```js
import lineItemPriceController, { createLineItemPriceController } from '../controllers/lineItemPrice.controller.js';
import { buildS4LineItemPriceControllerDependencies } from '#composition/s4-line-item-prices.composition.js';
import { tenantResolver } from '../middlewares/tenantResolver.js';

// Webhook de precios para tenants S/4. Reusa el controlador de B1 (dedupe, syncLog y audit
// idénticos) inyectándole el payload adapter y el caso de uso de S/4.
const s4LineItemPriceController = createLineItemPriceController(
  buildS4LineItemPriceControllerDependencies()
);

export default async function routes(app) {
  app.post(
    '/webhooks/hubspot/line-items/prices',
    { preHandler: tenantResolver },
    lineItemPriceController.syncPrices
  );

  app.post(
    '/webhooks/hubspot/line-items/prices/s4',
    { preHandler: tenantResolver },
    s4LineItemPriceController.syncPrices
  );
}
```

- [ ] **Step 5: Correr el test de wiring y el resto de los tests nuevos**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/composition/s4LineItemPricesComposition.test.js tests/unit/domain/s4PriceResolution.test.js tests/unit/infrastructure/s4PriceListClient.test.js tests/unit/infrastructure/s4PriceListConfigRepository.test.js tests/unit/infrastructure/s4PriceListLineItemPriceWebhook.test.js tests/unit/application/syncS4LineItemPricesByPriceList.test.js`
Expected: PASS, 6 suites.

- [ ] **Step 6: Verificar que no se rompió B1**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js tests/unit/infrastructure/lineItemPriceStrategyConfigRepository.test.js tests/unit/infrastructure/hubspotLineItemPriceClient.test.js tests/unit/infrastructure/lineItemPriceAudit.test.js`
Expected: PASS. Si algún archivo no existe con ese nombre, listar `tests/unit -name '*ineItemPrice*'` y correr los que aparezcan.

- [ ] **Step 7: Punto de corte** — revisión del usuario. No commitear.

---

### Task 7: Verificación manual contra el S/4 real

**Files:** ninguno (verificación).

**Interfaces:** consume todo lo construido.

- [ ] **Step 1: Insertar la config del tenant en el Mongo local**

El tenant `sap_integration_multiquimica` no tiene ninguna config de precios. Con Mongo local en `mongodb://localhost:27017`, insertar el documento (ajustar `salesArea` al área que el usuario quiera probar; `FQCR/01/SC` tiene registros ZPR0 vigentes verificados):

```js
db.getSiblingDB('sap_integration_multiquimica').Configurations.insertOne({
  key: 's4PriceList',
  value: {
    conditionType: 'ZPR0',
    defaultPriceListType: 'ZC',
    salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
    priceListProperty: 'lista_de_precios_sap',
    currencyProperty: 'moneda_precio_sap',
  },
  userUpdated: 'admin',
  createAt: new Date(),
  updateAt: new Date(),
});
```

Las propiedades `lista_de_precios_sap` y `moneda_precio_sap` tienen que existir en el portal de HubSpot como propiedades de line item, o HubSpot rechaza el batch. Si no están creadas todavía, dejar las dos claves en `null` en la config para esta prueba.

- [ ] **Step 2: Verificar que el S/4 responde con lo que el plan asume**

Con la VPN activa y las credenciales de `sap_integration_multiquimica.SapCredentials`, confirmar que el material que se va a probar tiene tarifa vigente en el área elegida:

```
GET https://vhmldqs4ci.hec.multidomsa.com:44300/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity
    ?$filter=ConditionType eq 'ZPR0' and Material eq '80000017' and SalesOrganization eq 'FQCR' and DistributionChannel eq '01' and ConditionValidityStartDate le datetime'<hoy>' and ConditionValidityEndDate ge datetime'<hoy>'
    &$select=ConditionRecord,PriceListType&$format=json
```

Expected: al menos una fila. Si vuelve vacío, el material no tiene precio en esa área y la prueba va a dar `skippedLineItems` — elegir otro material o otra área antes de seguir.

- [ ] **Step 3: Levantar la app y disparar el webhook**

Con un deal real del portal que tenga una company con `idsap` y al menos una línea con `hs_sku`, simular el evento de asociación de HubSpot:

```bash
curl -X POST http://localhost:3000/webhooks/hubspot/line-items/prices/s4 \
  -H 'Content-Type: application/json' \
  -H 'x-tenant-key: multiquimica' \
  -d '[{"eventId":1,"subscriptionId":2,"portalId":<PORTAL_ID>,"appId":4,"occurredAt":1755500000000,"fromObjectId":"<DEAL_ID>","associationType":"DEAL_TO_LINE_ITEM","changeSource":"USER"}]'
```

El header de tenant es el que use `tenantResolver` en este entorno — confirmarlo en
[tenantResolver.js](../../../src/interfaces/http/middlewares/tenantResolver.js) antes de correr el curl.

Expected: `200` con `ok: true`, `data.priceListType` con la lista aplicada, `data.lineItems[].Price` distinto de cero y `data.lineItems[].Currency` con la moneda de la condición.

- [ ] **Step 4: Verificar los tres efectos**

1. En HubSpot: el line item quedó con `price`, y con la lista y la moneda en sus propiedades si se configuraron; el deal quedó con `amount` igual a la suma de las líneas.
2. En Mongo: el documento en `sap_integration_multiquimica.LineItemPriceWebhookEvents` quedó con `isSend: true`, `errorMessage: null` y un `audit` **no nulo** con las llamadas OData. Que `audit` no sea nulo es la prueba de que el saneado de claves `$` funcionó contra un Mongo real.
3. En `logs/app.log`: las entradas de las llamadas a S/4 y, si hubo líneas sin tarifa, el warning con material, lista intentada y área.

- [ ] **Step 5: Probar el camino de fallback**

Repetir con un deal cuya company apunte a un cliente con `PriceListType` vacío en su área de ventas, o con un material sin registro en la lista del cliente. Expected: `data.priceListType` muestra el default configurado, o `data.lineItems[].priceSource` es `productDefault`.

- [ ] **Step 6: Punto de corte** — reportar al usuario los resultados con la evidencia (respuesta HTTP, documento de Mongo, líneas del log) para que decida el commit.

---

## Notas de revisión del plan

- **Cobertura del spec:** las seis secciones de componentes del spec están cubiertas (1→Task 5, 2→Task 2, 3→Task 1, 4→Task 4, 5→Task 3, 6→Task 6), más las pruebas de la sección "Pruebas" repartidas en cada tarea y la verificación manual en Task 7.
- **Sin cobertura deliberada:** las escalas por cantidad, los impuestos, la conversión de moneda y de unidad, y los precios negociados por cliente están declarados fuera de alcance en el spec y no tienen tarea.
- **`updateProducts` no se llama**: solo escribe propiedades de stock por bodega, que en este tenant las mantiene el sync de productos con la strategy `s4_PlantStorageLocation`.
- **Divergencia deliberada con B1 en duplicados y debounce:** el flujo B1 inserta un documento marca con el mismo `payload` cuando descarta un evento. El esquema tiene un índice **único** sobre `(payload.eventId, payload.subscriptionId, payload.portalId, payload.appId, payload.occurredAt, payload.fromObjectId)` con `partialFilterExpression` que exige las seis claves — y los eventos de asociación las traen todas. Ese insert choca con E11000 y la excepción reemplaza al skip. El flujo S/4 no inserta esas marcas: loguea y saltea. No cambia nada funcional (la ventana de debounce solo cuenta documentos con `errorMessage: null`) y evita el error. **El mismo patrón sigue en el flujo B1 y es una falla latente ahí**, pero está fuera del alcance de este plan por la restricción de no tocar B1.
- **Códigos HTTP:** los errores nuevos (`has no sales areas`, `does not belong to customer`, `Configuration s4PriceList is required`) no están en el regex de `resolveStatusCode` del controlador, así que salen como `500`. Es lo correcto: son de configuración o de datos maestros, no del payload del webhook, y un `500` hace que HubSpot reintente.
