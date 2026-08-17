# Fallo parcial, audit log y reconciliación en el webhook de precios — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el fallo de una línea no deje sin precio a las demás, que el evento guarde un audit log que explique *por qué* falló, y que al cerrar el flujo se releen las líneas del deal y se reprocese lo que quedó sin precio reutilizando lo ya traído de SAP.

**Architecture:** Se toca sólo la estrategia `businessPartner` (la que falla en producción). La lectura tolerante de líneas se implementa una vez en `lineItemPriceWebhook.shared.js` y se expone al use case por el puerto `HubspotLineItemPriceClientPort`. La reconciliación vive dentro de `SyncLineItemPrices.execute`, que gana una caché de SAP por invocación y un grabador de llamadas (el mismo `createSapCallRecorder` que ya audita las cotizaciones). El audit se persiste en un `updateOne` separado del que escribe `errorMessage`.

**Tech Stack:** Node 20 ESM, Fastify, Mongoose, Jest (`--experimental-vm-modules`), axios.

**Spec:** [`docs/superpowers/specs/2026-08-17-line-item-price-partial-failure-audit-design.md`](../specs/2026-08-17-line-item-price-partial-failure-audit-design.md)

## Global Constraints

- **Sólo la ruta `businessPartner`.** No tocar `dealPriceListLineItemPriceWebhook.service.js` ni `SyncDealLineItemPricesByPriceList.js` (fuera de alcance, deuda anotada en el spec).
- **Mongo de producción es < 5.0:** rechaza el `$set` COMPLETO si alguna clave empieza con `$`. Todo lo que entre al audit pasa por `sanitizeAuditKeys`, y el audit se escribe en un `updateOne` aparte del que escribe `isSend`/`errorMessage`.
- **`application` no puede importar `infrastructure`.** Verificado por `tests/unit/architecture/hexagonalBoundaries.test.js`. Todo acceso a HubSpot desde `SyncLineItemPrices` va por el puerto.
- **Comando de test (Git Bash):** `NODE_OPTIONS=--experimental-vm-modules npx jest <ruta> -t "<nombre>"`. En PowerShell: `$env:NODE_OPTIONS='--experimental-vm-modules'; npx jest <ruta>`.
- **Baseline de tests:** correr `npm test` ANTES de empezar y anotar los fallos preexistentes. No confundirlos con regresiones propias.
- **No commitear en `main`.** Trabajar en un worktree desechable (skill `superpowers:using-git-worktrees`). Commit por tarea dentro de esa rama.
- **Alias de imports:** `#application/*`, `#infrastructure/*`, `#ports/*`, `#shared/*`, `#domain/*`, `#composition/*`.
- **Refinamiento respecto al spec:** el lector se llama `readLineItems` (no `readDealLineItems`) porque recibe ids ya extraídos; el `GET deals/{id}` sigue siendo fatal y se queda donde está. El id del deal se resuelve con un segundo método, `readDealLineItemIds`.

## Estructura de archivos

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/infrastructure/sync/syncLog.service.js` | Serialización segura para Mongo + `buildLineItemPriceAudit` | Modificar (T1) |
| `src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js` | Campo `audit` | Modificar (T2) |
| `src/infrastructure/webhook/lineItemPriceWebhook.service.js` | Persistencia del audit, lector tolerante, guard de duplicados | Modificar (T2, T4, T8, T9) |
| `src/infrastructure/webhook/lineItemPriceWebhook.shared.js` | `readLineItems`, `readDealLineItemIds` | Modificar (T3) |
| `src/ports/line-item-price.port.js` | Contrato de los dos métodos nuevos | Modificar (T3) |
| `src/infrastructure/external-services/HubspotLineItemPriceClient.js` | Implementación del puerto | Modificar (T3) |
| `src/infrastructure/sap/sapCallRecorder.js` | Passthrough de `target` | Modificar (T5) |
| `src/application/use-cases/SyncLineItemPrices.js` | Grabador, caché, tolerancia SAP, reconciliación, audit | Modificar (T5–T8) |
| `src/composition/line-item-prices.composition.js` | Cableado del grabador | Modificar (T5) |
| `src/interfaces/http/controllers/lineItemPrice.controller.js` | Propagar el audit | Modificar (T8) |
| `src/infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js` | Reenviar el audit | Modificar (T8) |

---

### Task 0: Baseline y worktree

- [ ] **Step 1: Crear el worktree**

Usar la skill `superpowers:using-git-worktrees`. Rama sugerida: `line-item-price-partial-failure`.

- [ ] **Step 2: Anotar el baseline de tests**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest 2>&1 | tail -40
```

Guardar la lista de suites que ya fallan. Cualquier fallo nuevo a partir de acá es propio.

---

### Task 1: `buildLineItemPriceAudit` y utilidades exportadas

**Files:**
- Modify: `src/infrastructure/sync/syncLog.service.js`
- Test: `tests/unit/infrastructure/lineItemPriceAudit.test.js` (crear)

**Interfaces:**
- Produces:
  - `export function sanitizeAuditKeys(value): any` — ya existe en la línea 93, pasa a exportarse
  - `export function truncateAuditBody(value): any` — ya existe en la línea 133, pasa a exportarse
  - `export function buildLineItemPriceAudit(auditTrail): object | null`
- Consumes: `serializeLogValue`, `buildErrorResponseSnapshot`, `serializeAuditParams`, `resolveErrorMessageText` (ya presentes en el archivo)

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/infrastructure/lineItemPriceAudit.test.js`:

```javascript
import { buildLineItemPriceAudit } from '../../../src/infrastructure/sync/syncLog.service.js';

describe('buildLineItemPriceAudit', () => {
  it('prefixes $-leading keys and drops @odata keys of a failed call', () => {
    const error = Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
      details: { endpoint: '/crm/v3/objects/line_items/58061514894', status: 404 },
    });

    const audit = buildLineItemPriceAudit({
      dealId: '64058987777',
      calls: [{
        target: 'sap',
        method: 'get',
        path: "/b1s/v2/Items('A0001')",
        params: { $select: 'ItemPrices', $top: 1 },
        ok: false,
        status: 404,
        request: { '$set': 1, '@odata.context': 'x', ItemCode: 'A0001' },
        error,
      }],
    });

    expect(audit.calls[0].params).toBe('$select=ItemPrices&$top=1');
    expect(audit.calls[0].request).toEqual({ _$set: 1, ItemCode: 'A0001' });
    expect(audit.calls[0].error.status).toBe(404);
    expect(audit.calls[0].method).toBe('GET');
    expect(audit.dealId).toBe('64058987777');
  });

  it('keeps successful calls compact: no request or response body', () => {
    const audit = buildLineItemPriceAudit({
      calls: [{
        target: 'hubspot',
        method: 'POST',
        path: '/crm/v3/objects/line_items/batch/update',
        ok: true,
        durationMs: 120,
        request: { inputs: [{ id: '1' }] },
        response: { results: [{ id: '1' }] },
      }],
    });

    expect(audit.calls[0]).toEqual({
      target: 'hubspot',
      method: 'POST',
      path: '/crm/v3/objects/line_items/batch/update',
      params: null,
      ok: true,
      status: null,
      durationMs: 120,
    });
  });

  it('caps the number of recorded calls and reports how many were dropped', () => {
    const calls = Array.from({ length: 205 }, (_unused, index) => ({
      target: 'sap', method: 'GET', path: `/p/${index}`, ok: true,
    }));

    const audit = buildLineItemPriceAudit({ calls });

    expect(audit.calls).toHaveLength(200);
    expect(audit.droppedCalls).toBe(5);
  });

  it('returns null instead of throwing when the trail cannot be read', () => {
    const trail = { get rounds() { throw new Error('boom'); } };

    expect(buildLineItemPriceAudit(trail)).toBeNull();
  });

  it('defaults every section when the trail is empty', () => {
    const audit = buildLineItemPriceAudit(null);

    expect(audit.rounds).toEqual([]);
    expect(audit.calls).toEqual([]);
    expect(audit.unresolved).toEqual([]);
    expect(audit.amount).toBeNull();
    expect(audit.fatalError).toBeNull();
    expect(typeof audit.capturedAt).toBe('string');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/lineItemPriceAudit.test.js
```

Esperado: FAIL — `buildLineItemPriceAudit is not a function`.

- [ ] **Step 3: Exportar las dos utilidades privadas**

En `src/infrastructure/sync/syncLog.service.js`, cambiar dos declaraciones (líneas 93 y 133):

```javascript
export function sanitizeAuditKeys(value) {
```

```javascript
export function truncateAuditBody(value) {
```

No tocar nada más de esas funciones.

- [ ] **Step 4: Agregar `buildLineItemPriceAudit`**

Insertar después de `buildWebhookSapAudit` (que termina en la línea 251):

```javascript
// Tope de llamadas para el audit del webhook de precios. Un deal de 20 líneas hace ~85
// llamadas (1 deal + 1 company + 20 líneas + hasta 40 a SAP + 3 escrituras), así que el
// tope de 40 del grabador no alcanza. Las exitosas quedan compactas (sin cuerpos), así que
// 200 entradas no hacen crecer el documento de forma peligrosa.
const MAX_AUDIT_CALLS = 200;

// Las llamadas exitosas se guardan sin request ni response: el audit responde "por qué
// falló", y el cuerpo de una llamada que salió bien no aporta a eso pero sí multiplica el
// tamaño del documento.
function serializeAuditCall(call) {
  const base = {
    target: call?.target ?? null,
    method: String(call?.method || 'GET').toUpperCase(),
    path: call?.path ?? null,
    params: serializeAuditParams(call?.params),
    ok: call?.ok !== false,
    status: call?.status ?? null,
    durationMs: call?.durationMs ?? null,
  };

  if (call?.ok !== false) {
    return base;
  }

  return {
    ...base,
    request: truncateAuditBody(sanitizeAuditKeys(serializeLogValue(call?.request ?? null))),
    error: sanitizeAuditKeys({
      ...buildErrorResponseSnapshot(call?.error),
      message: resolveErrorMessageText(call?.error),
    }),
  };
}

// Audit del webhook de precios de line items. Nunca lanza: un audit roto no puede impedir
// que el evento registre su resultado.
export function buildLineItemPriceAudit(auditTrail) {
  try {
    const calls = Array.isArray(auditTrail?.calls) ? auditTrail.calls : [];

    return {
      capturedAt: new Date().toISOString(),
      dealId: auditTrail?.dealId ?? null,
      cardCode: auditTrail?.cardCode ?? null,
      rounds: sanitizeAuditKeys(serializeLogValue(auditTrail?.rounds ?? [])) ?? [],
      calls: calls.slice(0, MAX_AUDIT_CALLS).map(serializeAuditCall),
      droppedCalls: Math.max(calls.length - MAX_AUDIT_CALLS, 0),
      unresolved: sanitizeAuditKeys(serializeLogValue(auditTrail?.unresolved ?? [])) ?? [],
      amount: sanitizeAuditKeys(serializeLogValue(auditTrail?.amount ?? null)),
      fatalError: sanitizeAuditKeys(serializeLogValue(auditTrail?.fatalError ?? null)),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/lineItemPriceAudit.test.js
```

Esperado: PASS, 5 tests.

- [ ] **Step 6: Verificar que no se rompió el audit de cotizaciones**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest -t "sapAudit"
```

Esperado: sin fallos nuevos respecto al baseline.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/sync/syncLog.service.js tests/unit/infrastructure/lineItemPriceAudit.test.js
git commit -m "feat: add buildLineItemPriceAudit for line item price webhook auditing"
```

---

### Task 2: Campo `audit` y persistencia en `updateOne` separado

**Files:**
- Modify: `src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js`
- Modify: `src/infrastructure/webhook/lineItemPriceWebhook.service.js:630-660`
- Test: `tests/unit/lineItemPriceWebhook.service.test.js`

**Interfaces:**
- Produces:
  - `markAsSent(LineItemPriceWebhookEvent, executionId, audit = null): Promise<void>`
  - `markAsError(LineItemPriceWebhookEvent, executionId, error, audit = null): Promise<void>`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `tests/unit/lineItemPriceWebhook.service.test.js`, dentro del `describe` principal:

```javascript
  describe('audit persistence', () => {
    it('writes the audit in a separate updateOne from isSend/errorMessage', async () => {
      const LineItemPriceWebhookEvent = {
        updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      };

      await lineItemPriceWebhookService.markAsError(
        LineItemPriceWebhookEvent,
        'event-1',
        new Error('HubSpot API request failed: 404 Not Found'),
        { capturedAt: 'now', calls: [] }
      );

      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledTimes(2);
      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
        1,
        { _id: 'event-1' },
        { $set: { isSend: false, errorMessage: 'HubSpot API request failed: 404 Not Found' } }
      );
      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
        2,
        { _id: 'event-1' },
        { $set: { audit: { capturedAt: 'now', calls: [] } } }
      );
    });

    it('does not lose errorMessage when Mongo rejects the audit write', async () => {
      const LineItemPriceWebhookEvent = {
        updateOne: jest.fn()
          .mockResolvedValueOnce({ acknowledged: true })
          .mockRejectedValueOnce(new Error("The dollar ($) prefixed field '$select' is not valid for storage")),
      };

      await expect(
        lineItemPriceWebhookService.markAsError(
          LineItemPriceWebhookEvent,
          'event-1',
          new Error('boom'),
          { calls: [] }
        )
      ).resolves.toBeUndefined();

      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
        1,
        { _id: 'event-1' },
        { $set: { isSend: false, errorMessage: 'boom' } }
      );
    });

    it('skips the audit write when there is no audit', async () => {
      const LineItemPriceWebhookEvent = {
        updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      };

      await lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, 'event-1');

      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledTimes(1);
    });
  });
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/lineItemPriceWebhook.service.test.js -t "audit persistence"
```

Esperado: FAIL — `updateOne` llamado 1 vez, no 2.

- [ ] **Step 3: Agregar el campo al schema**

En `src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js`, después de `dealId` (líneas 20-23):

```javascript
    // El audit se escribe SIEMPRE en un $set aparte del de isSend/errorMessage: el Mongo de
    // producción es < 5.0 y rechaza el $set completo por una sola clave con `$` al inicio
    // (los params de OData traen `$select`), y con él se perdería el errorMessage.
    audit: {
      type: Schema.Types.Mixed,
      default: null,
    },
```

- [ ] **Step 4: Agregar el logger y el helper de persistencia**

En `src/infrastructure/webhook/lineItemPriceWebhook.service.js`, agregar al bloque de imports (después de la línea 3):

```javascript
import logger from '../logger/logger.js';
```

Y antes del objeto `lineItemPriceWebhookService` (antes de la línea 497):

```javascript
// Escritura aparte, y con su propio try/catch: si Mongo rechaza el audit, el resultado del
// evento (isSend / errorMessage) ya quedó guardado por el updateOne anterior.
async function persistAudit(LineItemPriceWebhookEvent, executionId, audit) {
  if (!audit) {
    return;
  }

  try {
    await LineItemPriceWebhookEvent.updateOne(
      { _id: executionId },
      { $set: { audit } }
    );
  } catch (error) {
    logger.warn({
      msg: 'Line item price audit could not be persisted',
      executionId: String(executionId),
      error: error.message,
    });
  }
}
```

- [ ] **Step 5: Aceptar el audit en `markAsSent` y `markAsError`**

Reemplazar los dos métodos (líneas 630-660) por:

```javascript
  async markAsSent(LineItemPriceWebhookEvent, executionId, audit = null) {
    if (!LineItemPriceWebhookEvent || !executionId) {
      return;
    }

    await LineItemPriceWebhookEvent.updateOne(
      { _id: executionId },
      {
        $set: {
          isSend: true,
          errorMessage: null,
        },
      }
    );

    await persistAudit(LineItemPriceWebhookEvent, executionId, audit);
  },

  async markAsError(LineItemPriceWebhookEvent, executionId, error, audit = null) {
    if (!LineItemPriceWebhookEvent || !executionId || !error) {
      return;
    }

    await LineItemPriceWebhookEvent.updateOne(
      { _id: executionId },
      {
        $set: {
          isSend: false,
          errorMessage: error.message,
        },
      }
    );

    await persistAudit(LineItemPriceWebhookEvent, executionId, audit);
  },
```

- [ ] **Step 6: Correr los tests para verificar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/lineItemPriceWebhook.service.test.js
```

Esperado: PASS, incluidos los 3 nuevos y todos los preexistentes de ese archivo.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/database/models/tenant/LineItemPriceWebhookEvent.js src/infrastructure/webhook/lineItemPriceWebhook.service.js tests/unit/lineItemPriceWebhook.service.test.js
git commit -m "feat: persist line item price audit in its own updateOne"
```

---

### Task 3: `readLineItems` tolerante y `readDealLineItemIds`

**Files:**
- Modify: `src/infrastructure/webhook/lineItemPriceWebhook.shared.js`
- Modify: `src/ports/line-item-price.port.js:33-53`
- Modify: `src/infrastructure/external-services/HubspotLineItemPriceClient.js:131-147`
- Test: `tests/unit/infrastructure/readLineItems.test.js` (crear)

**Interfaces:**
- Produces:
  - `readLineItems({ token, lineItemIds, extraProperties = [], fetch }): Promise<{ lineItems, failures }>`
    - `lineItems: [{ id: string, itemCode: string, quantity: any, properties: object, ...extraProperties }]`
    - `failures: [{ id: string, stage: 'hubspot_read', reason: string, status: number|null, endpoint: string|null }]`
  - `readDealLineItemIds({ token, dealId, fetch }): Promise<string[]>` — **lanza** si el GET del deal falla (fatal por diseño)
  - `HubspotLineItemPriceClient.readLineItems({ token, lineItemIds, extraProperties })`
  - `HubspotLineItemPriceClient.readDealLineItemIds({ token, dealId })`

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/infrastructure/readLineItems.test.js`:

```javascript
import { jest } from '@jest/globals';
import {
  readLineItems,
  readDealLineItemIds,
} from '../../../src/infrastructure/webhook/lineItemPriceWebhook.shared.js';

function hubspot404(endpoint) {
  return Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
    details: { endpoint, method: 'GET', status: 404, statusText: 'Not Found' },
  });
}

describe('readLineItems', () => {
  it('keeps the readable lines when one of them 404s', async () => {
    const fetch = jest.fn(async (_token, _type, id) => {
      if (id === 'line-2') {
        throw hubspot404('/crm/v3/objects/line_items/line-2');
      }
      return { id, properties: { hs_sku: `SKU-${id}`, quantity: '2' } };
    });

    const result = await readLineItems({
      token: 'tok',
      lineItemIds: ['line-1', 'line-2', 'line-3'],
      fetch,
    });

    expect(result.lineItems).toEqual([
      { id: 'line-1', itemCode: 'SKU-line-1', quantity: '2', properties: { hs_sku: 'SKU-line-1', quantity: '2' } },
      { id: 'line-3', itemCode: 'SKU-line-3', quantity: '2', properties: { hs_sku: 'SKU-line-3', quantity: '2' } },
    ]);
    expect(result.failures).toEqual([{
      id: 'line-2',
      stage: 'hubspot_read',
      reason: 'HubSpot API request failed: 404 Not Found',
      status: 404,
      endpoint: '/crm/v3/objects/line_items/line-2',
    }]);
  });

  it('reports a line without hs_sku as a failure instead of throwing', async () => {
    const fetch = jest.fn(async (_token, _type, id) => ({ id, properties: { quantity: '1' } }));

    const result = await readLineItems({ token: 'tok', lineItemIds: ['line-9'], fetch });

    expect(result.lineItems).toEqual([]);
    expect(result.failures[0]).toMatchObject({
      id: 'line-9',
      stage: 'hubspot_read',
      reason: 'line item has no hs_sku',
      status: null,
    });
  });

  it('requests and exposes the extra properties at the top level', async () => {
    const fetch = jest.fn(async (_token, _type, id) => ({
      id,
      properties: { hs_sku: 'A0001', quantity: '3', miscelaneo: '10', price: '0' },
    }));

    const result = await readLineItems({
      token: 'tok',
      lineItemIds: ['line-1'],
      extraProperties: ['miscelaneo', 'price'],
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith('tok', 'line_items', 'line-1', {
      properties: ['hs_sku', 'quantity', 'miscelaneo', 'price'],
    });
    expect(result.lineItems[0]).toMatchObject({ miscelaneo: '10', price: '0' });
  });

  it('returns empty collections for an empty id list', async () => {
    const fetch = jest.fn();

    const result = await readLineItems({ token: 'tok', lineItemIds: [], fetch });

    expect(result).toEqual({ lineItems: [], failures: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('readDealLineItemIds', () => {
  it('extracts the ids from any of the association aliases', async () => {
    const fetch = jest.fn(async () => ({
      id: '900100',
      associations: { 'line items': { results: [{ id: '1' }, { id: '2' }] } },
    }));

    await expect(readDealLineItemIds({ token: 'tok', dealId: '900100', fetch }))
      .resolves.toEqual(['1', '2']);
    expect(fetch).toHaveBeenCalledWith('tok', 'deals', '900100', {
      associations: ['line_items'],
    });
  });

  it('propagates the error when the deal read fails (fatal by design)', async () => {
    const fetch = jest.fn(async () => {
      throw hubspot404('/crm/v3/objects/deals/900100');
    });

    await expect(readDealLineItemIds({ token: 'tok', dealId: '900100', fetch }))
      .rejects.toThrow('404 Not Found');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/readLineItems.test.js
```

Esperado: FAIL — `readLineItems is not a function`.

- [ ] **Step 3: Implementar las dos funciones**

Agregar al final de `src/infrastructure/webhook/lineItemPriceWebhook.shared.js`:

```javascript
// Lector tolerante: NUNCA lanza por una línea individual. Sigue usando Promise.all porque el
// paralelismo no es el problema; el problema era que un solo rechazo mataba al conjunto y
// dejaba sin precio a todas las demás líneas del deal.
export async function readLineItems({
  token,
  lineItemIds = [],
  extraProperties = [],
  fetch = fetchHubspotObject,
} = {}) {
  const normalizedExtras = extraProperties.filter(Boolean);
  const properties = ['hs_sku', 'quantity', ...normalizedExtras]
    .filter((value, index, values) => value && values.indexOf(value) === index);

  const results = await Promise.all(lineItemIds.map(async (lineItemId) => {
    const id = String(lineItemId);

    try {
      const record = await fetch(token, 'line_items', lineItemId, { properties });
      const itemCode = toNonEmptyString(
        record?.properties?.hs_sku || record?.properties?.itemCode
      );

      if (!itemCode) {
        return {
          failure: {
            id,
            stage: 'hubspot_read',
            reason: 'line item has no hs_sku',
            status: null,
            endpoint: null,
          },
        };
      }

      const recordProperties = record?.properties ?? {};

      return {
        lineItem: {
          id: toNonEmptyString(record?.id) || id,
          itemCode,
          quantity: recordProperties.quantity ?? null,
          properties: recordProperties,
          ...Object.fromEntries(
            normalizedExtras.map((name) => [name, recordProperties[name] ?? null])
          ),
        },
      };
    } catch (error) {
      return {
        failure: {
          id,
          stage: 'hubspot_read',
          reason: error.message,
          status: error?.details?.status ?? error?.response?.status ?? null,
          endpoint: error?.details?.endpoint ?? null,
        },
      };
    }
  }));

  return {
    lineItems: results.map((entry) => entry.lineItem).filter(Boolean),
    failures: results.map((entry) => entry.failure).filter(Boolean),
  };
}

// Lectura del deal: SÍ lanza. Sin el deal no hay nada que valorizar, así que es fatal y
// HubSpot debe reintentar en vez de que el evento se marque como bueno sin haber hecho nada.
export async function readDealLineItemIds({ token, dealId, fetch = fetchHubspotObject } = {}) {
  const deal = await fetch(token, 'deals', dealId, { associations: ['line_items'] });

  return extractLineItemAssociationIds(deal);
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/readLineItems.test.js
```

Esperado: PASS, 6 tests.

- [ ] **Step 5: Declarar los métodos en el puerto**

En `src/ports/line-item-price.port.js`, dentro de `HubspotLineItemPriceClientPort` (después de `fetchObject`, línea 40):

```javascript
  async readLineItems() {
    throw new Error('Not implemented');
  }

  async readDealLineItemIds() {
    throw new Error('Not implemented');
  }
```

- [ ] **Step 6: Implementar los métodos en el cliente**

En `src/infrastructure/external-services/HubspotLineItemPriceClient.js`, agregar el import al bloque de arriba:

```javascript
import {
  readDealLineItemIds,
  readLineItems,
} from '#infrastructure/webhook/lineItemPriceWebhook.shared.js';
```

Y los dos métodos después de `fetchObject` (que termina en la línea 147):

```javascript
  // Delega en la única implementación del lector tolerante. Existe como método del puerto
  // para que SyncLineItemPrices la alcance sin que application importe infrastructure.
  async readLineItems({ token, lineItemIds, extraProperties = [] }) {
    return readLineItems({ token, lineItemIds, extraProperties });
  }

  async readDealLineItemIds({ token, dealId }) {
    return readDealLineItemIds({ token, dealId });
  }
```

- [ ] **Step 7: Verificar los límites hexagonales y la suite completa**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/architecture/hexagonalBoundaries.test.js
NODE_OPTIONS=--experimental-vm-modules npx jest
```

Esperado: los límites pasan y no hay fallos nuevos respecto al baseline.

- [ ] **Step 8: Commit**

```bash
git add src/infrastructure/webhook/lineItemPriceWebhook.shared.js src/ports/line-item-price.port.js src/infrastructure/external-services/HubspotLineItemPriceClient.js tests/unit/infrastructure/readLineItems.test.js
git commit -m "feat: add tolerant readLineItems reader behind the line item price port"
```

---

### Task 4: `buildLegacyPayload` usa el lector tolerante

**Files:**
- Modify: `src/infrastructure/webhook/lineItemPriceWebhook.service.js:105-141` (borrar `resolveLineItems`), `:479-495` (`buildLegacyPayload`)
- Test: `tests/unit/lineItemPriceWebhook.service.test.js`

**Interfaces:**
- Consumes: `readLineItems` de Task 3
- Produces: `buildLegacyPayload` devuelve `{ dealId, cardCode, lineItems, lineItemFailures }`

- [ ] **Step 1: Escribir el test que falla**

Agregar en `tests/unit/lineItemPriceWebhook.service.test.js`:

```javascript
  it('builds the legacy payload with two of three lines when one line 404s', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/64058987777') {
        return {
          id: '64058987777',
          associations: {
            companies: { results: [{ id: 'company-1' }] },
            'line items': { results: [{ id: 'line-1' }, { id: 'line-2' }, { id: 'line-3' }] },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/company-1') {
        return { id: 'company-1', properties: { idsap: 'C20000' } };
      }

      if (path === '/crm/v3/objects/line_items/line-2') {
        throw Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
          details: { endpoint: path, method: 'GET', status: 404 },
        });
      }

      return { id: path.split('/').pop(), properties: { hs_sku: 'A0001', quantity: '1' } };
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 2073333923,
        subscriptionId: 6955444,
        portalId: 50249912,
        appId: 36665006,
        occurredAt: 1786997905997,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 64058987777,
      },
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result.skip).toBe(false);
    expect(result.payload.lineItems.map((line) => line.id)).toEqual(['line-1', 'line-3']);
    expect(result.payload.lineItemFailures).toEqual([{
      id: 'line-2',
      stage: 'hubspot_read',
      reason: 'HubSpot API request failed: 404 Not Found',
      status: 404,
      endpoint: '/crm/v3/objects/line_items/line-2',
    }]);
    expect(result.payload.cardCode).toBe('C20000');
  });
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/lineItemPriceWebhook.service.test.js -t "two of three lines"
```

Esperado: FAIL — el `Promise.all` rechaza y `preparePayload` lanza el 404.

- [ ] **Step 3: Reemplazar `buildLegacyPayload` y borrar `resolveLineItems`**

Borrar por completo `resolveLineItems` (líneas 105-141). Reemplazar `buildLegacyPayload` (líneas 479-495) por:

```javascript
async function buildLegacyPayload(payload, token, miscPriceCalculationConfig = null) {
  const dealId = toNonEmptyString(payload?.fromObjectId);

  if (!dealId) {
    throw new Error('fromObjectId is required');
  }

  const deal = await fetchHubspotObject(token, 'deals', dealId, {
    associations: ['companies', 'contacts', 'line_items'],
  });
  const lineItemIds = extractLineItemAssociationIds(deal);

  if (lineItemIds.length === 0) {
    throw new Error('Deal has no associated line items');
  }

  const miscSourceProperty = miscPriceCalculationConfig?.enableMiscPriceCalculation === true
    ? toNonEmptyString(miscPriceCalculationConfig?.miscSourceProperty)
    : null;

  const cardCode = await resolveCardCode(token, deal);
  // Una línea ilegible ya no tumba al resto: viaja en lineItemFailures hasta el audit.
  const { lineItems, failures } = await readLineItems({
    token,
    lineItemIds,
    extraProperties: [miscSourceProperty].filter(Boolean),
  });

  if (lineItems.length === 0) {
    throw new Error('Deal has no readable line items');
  }

  return {
    dealId,
    cardCode,
    lineItems,
    lineItemFailures: failures,
  };
}
```

Agregar `readLineItems` al import del shared (línea 4-13).

- [ ] **Step 4: Correr el test nuevo**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/lineItemPriceWebhook.service.test.js -t "two of three lines"
```

Esperado: PASS.

- [ ] **Step 5: Ajustar los tests preexistentes de este archivo**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/lineItemPriceWebhook.service.test.js
```

El test `builds the legacy payload from the HubSpot deal associations` va a fallar porque el payload ahora trae `lineItemFailures: []` y cada línea trae `properties`. Actualizar la aserción para incluir ambos. **No** relajar la aserción a `expect.objectContaining` sin más: verificar explícitamente que `lineItemFailures` es `[]` en el camino feliz.

Esperado tras el ajuste: PASS, todo el archivo.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/webhook/lineItemPriceWebhook.service.js tests/unit/lineItemPriceWebhook.service.test.js
git commit -m "fix: one unreadable line item no longer blocks the rest of the deal"
```

---

### Task 5: Grabador de llamadas en `SyncLineItemPrices`

**Files:**
- Modify: `src/infrastructure/sap/sapCallRecorder.js:38-43`
- Modify: `src/application/use-cases/SyncLineItemPrices.js:109-130` (constructor), `:130-140` (inicio de `execute`), `:185-250` y `:308-345` (llamadas)
- Modify: `src/composition/line-item-prices.composition.js:15-33`
- Test: `tests/unit/application/syncLineItemPrices.test.js`

**Interfaces:**
- Consumes: `createNoopSapCallRecorder` de `#application/services/sap-call-audit.service.js`
- Produces: `SyncLineItemPrices` acepta `createSapCallRecorder` en el constructor; cada entrada grabada lleva `target: 'sap' | 'hubspot'`

- [ ] **Step 1: Escribir el test que falla**

Agregar en `tests/unit/application/syncLineItemPrices.test.js`:

```javascript
  it('records SAP and HubSpot traffic through the injected recorder', async () => {
    const calls = [];
    const createSapCallRecorder = () => ({
      calls,
      droppedCalls: 0,
      record: async (options, run) => {
        try {
          const response = await run();
          calls.push({ ...options, ok: true });
          return response;
        } catch (error) {
          calls.push({ ...options, ok: false, error });
          throw error;
        }
      },
      wrap: (adapter) => adapter,
    });

    const { useCase } = createUseCase({ createSapCallRecorder });

    await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: { client: { hubspot: { portalId: '12345' } } },
        tenantKey: 'tenant_1',
      }
    );

    expect(calls.some((call) => call.target === 'sap' && call.ok === true)).toBe(true);
    expect(calls.some((call) => call.target === 'hubspot'
      && call.path === '/crm/v3/objects/line_items/batch/update')).toBe(true);
  });

  it('works without a recorder injected (noop default)', async () => {
    const { useCase, hubspotPriceClient } = createUseCase();

    await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1' }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js -t "records SAP and HubSpot traffic"
```

Esperado: FAIL — `calls` queda vacío.

- [ ] **Step 3: Pasar `target` en el grabador**

En `src/infrastructure/sap/sapCallRecorder.js`, dentro de `record` (líneas 38-43), agregar la clave a `base`:

```javascript
    const base = {
      // `target` distingue SAP de HubSpot cuando un mismo grabador audita las dos patas
      // (el webhook de precios). Las entradas de los flujos que sólo hablan con SAP quedan
      // con `target: null`, y serializeSapCalls no la copia, así que sapAudit no cambia.
      target: options?.target ?? null,
      method: String(options?.method || 'get').toUpperCase(),
      path: options?.path ?? null,
      params: options?.params ?? null,
      request: options?.data ?? null,
    };
```

- [ ] **Step 4: Inyectar la fábrica en el use case**

En `src/application/use-cases/SyncLineItemPrices.js`, agregar el import arriba:

```javascript
import { createNoopSapCallRecorder } from '#application/services/sap-call-audit.service.js';
```

En el constructor (líneas 110-128), agregar el parámetro y la asignación, siguiendo el patrón de `ProcessHubspotCreateQuotation.js:48` y `:51`:

```javascript
    createSapCallRecorder = createNoopSapCallRecorder,
```

```javascript
    this.createSapCallRecorder = createSapCallRecorder;
```

Al inicio de `execute` (antes de `const auditTrail`, línea 131):

```javascript
    const callRecorder = this.createSapCallRecorder();
```

- [ ] **Step 5: Envolver las llamadas a SAP y a HubSpot**

`wrap()` no sirve acá: `SapLineItemPriceClient` llama a axios directo y no tiene `.request`. Se usa `record` explícito.

Llamada de precio de business partner (línea 193):

```javascript
          priceData = await callRecorder.record(
            {
              target: 'sap',
              method: 'POST',
              path: '/b1s/v2/CompanyService_GetItemPrice',
              data: sapRequestPayload,
            },
            () => this.sapPriceClient.fetchBusinessPartnerPrice({
              sapConfig,
              cardCode,
              itemCode,
              date: currentDate,
              tenantKey,
              requestPayload: sapRequestPayload,
            })
          );
```

Cada `this.sapPriceClient.fetchItemPrices({...})` (líneas 210 y 240) se envuelve igual, con:

```javascript
            {
              target: 'sap',
              method: 'GET',
              path: buildSapItemPricesPath(itemCode, itemSelectFields),
            },
```

Las tres escrituras de HubSpot (líneas 312, 317, 340):

```javascript
      const hubspotUpdate = await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/line_items/batch/update' },
        () => this.hubspotPriceClient.updateLineItems({ token, enrichedLineItems, tenantKey })
      );
```

```javascript
      const hubspotProductUpdate = await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/products/batch/update' },
        () => this.hubspotPriceClient.updateProducts({ token, enrichedLineItems, tenantKey })
      );
```

```javascript
        dealUpdate = await callRecorder.record(
          { target: 'hubspot', method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}` },
          () => this.hubspotPriceClient.updateDealAmount({ token, dealId, totalAmount, tenantKey })
        );
```

- [ ] **Step 6: Cablear en composition**

En `src/composition/line-item-prices.composition.js`, agregar el import:

```javascript
import { createSapCallRecorder } from '#infrastructure/sap/sapCallRecorder.js';
```

Y dentro de `new SyncLineItemPrices({...})` (líneas 20-32), agregar:

```javascript
    createSapCallRecorder,
```

- [ ] **Step 7: VERIFICAR EL CABLEADO (obligatorio)**

Un parámetro de constructor sin cablear pasa los tests igual. Confirmar con grep:

```bash
grep -n "createSapCallRecorder" src/composition/line-item-prices.composition.js
```

Esperado: dos líneas — el `import` y la clave dentro del `new`.

- [ ] **Step 8: Correr los tests**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js
```

Esperado: PASS, incluidos los preexistentes.

- [ ] **Step 9: Commit**

```bash
git add src/infrastructure/sap/sapCallRecorder.js src/application/use-cases/SyncLineItemPrices.js src/composition/line-item-prices.composition.js tests/unit/application/syncLineItemPrices.test.js
git commit -m "feat: record SAP and HubSpot traffic in the line item price use case"
```

---

### Task 6: Tolerancia en el ciclo de SAP y caché por invocación

**Files:**
- Modify: `src/application/use-cases/SyncLineItemPrices.js:177-306` (el `for`)
- Test: `tests/unit/application/syncLineItemPrices.test.js`

**Interfaces:**
- Produces:
  - `sapCache: Map<itemCode, { priceData, sapItemData }>` local a `execute`
  - `roundFailures: [{ id, itemCode, stage: 'sap_price', reason, status }]`
  - Lanza `'No line item prices could be resolved for this deal'` si no queda ninguna línea

- [ ] **Step 1: Escribir el test que falla**

```javascript
  it('keeps pricing the other lines when SAP fails for one item', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    sapPriceClient.fetchBusinessPartnerPrice = jest.fn(async ({ itemCode }) => {
      if (itemCode === 'BAD') {
        throw new Error('Price list 4 not found for item BAD');
      }
      return { Price: 100, Currency: 'C$', Discount: 0 };
    });

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'BAD', id: 'line-2', quantity: 1 },
          { itemCode: 'A0002', id: 'line-3', quantity: 1 },
        ],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    const sent = hubspotPriceClient.updateLineItems.mock.calls[0][0].enrichedLineItems;
    expect(sent.map((line) => line.id)).toEqual(['line-1', 'line-3']);
    expect(result.meta.skippedCount).toBe(1);
  });

  it('queries SAP once for an itemCode repeated across two lines', async () => {
    const { useCase, sapPriceClient } = createUseCase();

    await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'A0001', id: 'line-2', quantity: 4 },
        ],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
  });

  it('throws when SAP fails for every line', async () => {
    const { useCase } = createUseCase({
      sapPriceClient: {
        fetchBusinessPartnerPrice: jest.fn().mockRejectedValue(new Error('SAP down')),
        fetchItemPrices: jest.fn().mockRejectedValue(new Error('SAP down')),
      },
    });

    await expect(useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1' }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    )).rejects.toThrow('No line item prices could be resolved for this deal');
  });
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js -t "keeps pricing the other lines"
```

Esperado: FAIL — el error de SAP escapa del `for` y tumba el `execute`.

- [ ] **Step 3: Extraer la resolución de precios a un método con caché**

Agregar como método de la clase `SyncLineItemPrices`:

```javascript
  // Una sola entrada por itemCode: cardCode y fecha son fijos durante la invocación, así que
  // dos líneas del mismo producto comparten resultado. La caché también es la que le permite
  // a la reconciliación reescribir una línea sin volver a SAP.
  async resolveSapPricing({
    itemCode,
    sapCache,
    callRecorder,
    sapConfig,
    cardCode,
    currentDate,
    tenantKey,
    itemSelectFields,
    fallbackPriceList,
    useBusinessPartnerPrice,
    auditTrail,
  }) {
    const cached = sapCache.get(itemCode);

    if (cached) {
      return { ...cached, source: 'cache' };
    }

    let priceData;
    let sapItemData;

    if (useBusinessPartnerPrice) {
      const sapRequestPayload = buildSapPricePayload({ cardCode, itemCode, date: currentDate });
      auditTrail.payload_SAP.push(sapRequestPayload);

      priceData = await callRecorder.record(
        {
          target: 'sap',
          method: 'POST',
          path: '/b1s/v2/CompanyService_GetItemPrice',
          data: sapRequestPayload,
        },
        () => this.sapPriceClient.fetchBusinessPartnerPrice({
          sapConfig,
          cardCode,
          itemCode,
          date: currentDate,
          tenantKey,
          requestPayload: sapRequestPayload,
        })
      );
      auditTrail.response_SAP.push(priceData);

      sapItemData = await callRecorder.record(
        { target: 'sap', method: 'GET', path: buildSapItemPricesPath(itemCode, itemSelectFields) },
        () => this.sapPriceClient.fetchItemPrices({
          sapConfig,
          itemCode,
          tenantKey,
          selectFields: itemSelectFields,
        })
      );
    } else {
      const sapRequestPayload = {
        method: 'GET',
        endpoint: buildSapItemPricesPath(itemCode, itemSelectFields),
        priceList: fallbackPriceList,
      };
      auditTrail.payload_SAP.push(sapRequestPayload);

      sapItemData = await callRecorder.record(
        { target: 'sap', method: 'GET', path: sapRequestPayload.endpoint },
        () => this.sapPriceClient.fetchItemPrices({
          sapConfig,
          itemCode,
          tenantKey,
          selectFields: itemSelectFields,
        })
      );

      const selectedPrice = selectConfiguredItemPrice(
        sapItemData?.ItemPrices,
        fallbackPriceList,
        itemCode
      );

      priceData = {
        Price: selectedPrice?.Price ?? 0,
        Currency: selectedPrice?.Currency ?? null,
        Discount: 0,
        PriceList: selectedPrice?.PriceList ?? fallbackPriceList,
      };

      auditTrail.response_SAP.push({ ...sapItemData, selectedPrice });
    }

    const entry = { priceData, sapItemData };
    sapCache.set(itemCode, entry);

    return { ...entry, source: 'sap' };
  }
```

- [ ] **Step 4: Hacer tolerante el ciclo**

Reemplazar el cuerpo del `for` (líneas 179-306) por esta forma, que envuelve la parte de SAP:

```javascript
      const sapCache = new Map();
      const enrichedLineItems = [];
      const roundFailures = [...(payload.lineItemFailures ?? [])];
      const pricedLog = [];

      for (const lineItem of payload.lineItems) {
        const itemCode = toNonEmptyString(lineItem.itemCode);
        const id = toNonEmptyString(lineItem.id);
        let pricing;

        try {
          // eslint-disable-next-line no-await-in-loop
          pricing = await this.resolveSapPricing({
            itemCode,
            sapCache,
            callRecorder,
            sapConfig,
            cardCode,
            currentDate,
            tenantKey,
            itemSelectFields,
            fallbackPriceList,
            useBusinessPartnerPrice,
            auditTrail,
          });
        } catch (error) {
          // Una línea sin precio en SAP no puede dejar sin precio a las demás del deal.
          this.logger.warn({
            msg: 'Line item skipped: SAP price could not be resolved',
            tenantKey,
            lineItemId: id,
            itemCode,
            error: error.message,
          });
          roundFailures.push({
            id,
            itemCode,
            stage: 'sap_price',
            reason: error.message,
            status: error?.response?.status ?? error?.details?.status ?? null,
          });
          // eslint-disable-next-line no-continue
          continue;
        }

        const { priceData, sapItemData: sapItemStockData } = pricing;

        // ... desde acá el cuerpo sigue EXACTAMENTE igual que hoy, a partir de
        // `const warehouseStockProperties = await this.credentialRepository...`
        // (línea 247), hasta el `enrichedLineItems.push({...})` inclusive.

        pricedLog.push({ id, itemCode, price, source: pricing.source });
      }

      if (enrichedLineItems.length === 0) {
        throw new Error('No line item prices could be resolved for this deal');
      }
```

Notas para quien implementa:
- `warehouseStockProperties`, `tax`, `finalDiscount`, `quantity`, `priceCalculation`, `price`, `lineTotal` y el `enrichedLineItems.push` **no cambian**. Sólo cambia de dónde vienen `priceData` y `sapItemStockData`.
- Borrar el bloque `if (useBusinessPartnerPrice) { auditTrail.response_SAP.push(priceData); }` (líneas 235-237) y el `const sapItemStockData = useBusinessPartnerPrice ? ... : ...` (líneas 239-246): ese trabajo ahora vive en `resolveSapPricing`.
- Agregar `skippedCount: roundFailures.length` al objeto `meta` del return.

- [ ] **Step 5: Correr los tests**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js
```

Esperado: PASS. Si el test preexistente `syncs business partner prices through injected ports` falla por el orden de las llamadas a `fetchItemPrices`, revisar que `resolveSapPricing` mantenga el orden precio → stock del código original.

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/SyncLineItemPrices.js tests/unit/application/syncLineItemPrices.test.js
git commit -m "fix: a line without SAP price no longer blocks the rest of the deal"
```

---

### Task 7: Ronda de reconciliación y `amount` al cierre

**Files:**
- Modify: `src/application/use-cases/SyncLineItemPrices.js` (después de las escrituras batch; mover el bloque de `totalAmount`/`updateDealAmount` de las líneas 334-351 al final)
- Test: `tests/unit/application/syncLineItemPrices.test.js`

**Interfaces:**
- Consumes: `hubspotPriceClient.readDealLineItemIds`, `hubspotPriceClient.readLineItems` (Task 3); `sapCache` (Task 6)
- Produces: `reconcile({...}): Promise<{ triggered, trigger, priced, failures }>`; `meta.reconciliation`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al helper `createUseCase` del archivo de test, dentro de `hubspotPriceClient`:

```javascript
    readDealLineItemIds: jest.fn().mockResolvedValue(['line-1']),
    readLineItems: jest.fn().mockResolvedValue({
      lineItems: [{ id: 'line-1', itemCode: 'A0001', quantity: '2', price: '704.35', properties: {} }],
      failures: [],
    }),
```

Y los tests:

```javascript
  it('does not reconcile when count and prices already match', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.triggered).toBe(false);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(1);
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
  });

  it('reconciles a line that appeared after the first read, reusing the SAP cache', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    hubspotPriceClient.readDealLineItemIds.mockResolvedValue(['line-1', 'line-2']);
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [
        { id: 'line-1', itemCode: 'A0001', quantity: '2', price: '704.35', properties: {} },
        { id: 'line-2', itemCode: 'A0001', quantity: '1', price: '0', properties: {} },
      ],
      failures: [],
    });

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.triggered).toBe(true);
    expect(result.meta.reconciliation.trigger).toContain('count_mismatch');
    // A0001 ya estaba en caché: la ronda 2 no vuelve a SAP.
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(2);
    expect(hubspotPriceClient.updateLineItems.mock.calls[1][0].enrichedLineItems[0].id).toBe('line-2');
  });

  it('does not reconcile a zero price that SAP itself reports as zero', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase({
      sapPriceClient: {
        fetchBusinessPartnerPrice: jest.fn().mockResolvedValue({ Price: 0, Currency: 'C$', Discount: 0 }),
        fetchItemPrices: jest.fn().mockResolvedValue({
          ItemPrices: [{ PriceList: 4, Price: 0, Currency: 'C$' }],
          ItemWarehouseInfoCollection: [],
        }),
      },
    });

    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [{ id: 'line-1', itemCode: 'A0001', quantity: '2', price: '0', properties: {} }],
      failures: [],
    });

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.triggered).toBe(false);
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(1);
  });

  it('reconciles a zero price that the SAP cache contradicts, without calling SAP again', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [{ id: 'line-1', itemCode: 'A0001', quantity: '2', price: '0', properties: {} }],
      failures: [],
    });

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.trigger).toContain('zero_price');
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(2);
  });

  it('updates the deal amount once, after reconciliation, with both rounds', async () => {
    const { useCase, hubspotPriceClient } = createUseCase();

    hubspotPriceClient.readDealLineItemIds.mockResolvedValue(['line-1', 'line-2']);
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [
        { id: 'line-1', itemCode: 'A0001', quantity: '1', price: '704.35', properties: {} },
        { id: 'line-2', itemCode: 'A0001', quantity: '1', price: '0', properties: {} },
      ],
      failures: [],
    });

    await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 1 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(hubspotPriceClient.updateDealAmount).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateDealAmount.mock.calls[0][0].totalAmount).toBe(1408.7);
  });
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js -t "reconcil"
```

Esperado: FAIL — `result.meta.reconciliation` es `undefined`.

- [ ] **Step 3: Implementar `reconcile`**

Agregar como método de la clase:

```javascript
  // Segunda pasada de seguridad, UNA sola vez. Existe porque el índice de asociaciones de
  // HubSpot va unos segundos atrasado: cuando el asesor quita o agrega líneas, la lectura de
  // la ronda 1 puede traer una línea ya archivada (404) o perderse una recién creada.
  //
  // Sólo corre si hay señal de que algo quedó mal: diferencia de cantidad, o una línea en
  // precio 0 que la caché de SAP contradice. Un 0 que SAP mismo reporta es correcto y no
  // dispara trabajo.
  async reconcile({
    token,
    dealId,
    updatedIds,
    sapCache,
    callRecorder,
    sapConfig,
    cardCode,
    currentDate,
    tenantKey,
    itemSelectFields,
    fallbackPriceList,
    useBusinessPartnerPrice,
    miscPriceCalculationConfig,
    taxSettings,
    discountHsField,
    auditTrail,
    tenantModels,
  }) {
    const freshIds = await this.hubspotPriceClient.readDealLineItemIds({ token, dealId });
    const { lineItems: freshLines, failures: readFailures } = await this.hubspotPriceClient
      .readLineItems({ token, lineItemIds: freshIds, extraProperties: ['price'] });

    const trigger = [];

    if (freshIds.length !== updatedIds.size) {
      trigger.push('count_mismatch');
    }

    const zeroPriceLines = freshLines.filter((line) => {
      if (normalizeNumber(line.price, 0) !== 0) {
        return false;
      }

      const cached = sapCache.get(line.itemCode);

      // El 0 viene de SAP: es correcto, no se toca.
      return !(cached && roundCurrency(cached.priceData?.Price ?? 0) === 0);
    });

    if (zeroPriceLines.length > 0) {
      trigger.push('zero_price');
    }

    if (trigger.length === 0) {
      return { triggered: false, trigger: [], priced: [], failures: readFailures, enriched: [] };
    }

    const pending = freshLines.filter(
      (line) => !updatedIds.has(String(line.id)) || zeroPriceLines.includes(line)
    );
    const enriched = [];
    const priced = [];
    const failures = [...readFailures];

    for (const line of pending) {
      let pricing;

      try {
        // eslint-disable-next-line no-await-in-loop
        pricing = await this.resolveSapPricing({
          itemCode: line.itemCode,
          sapCache,
          callRecorder,
          sapConfig,
          cardCode,
          currentDate,
          tenantKey,
          itemSelectFields,
          fallbackPriceList,
          useBusinessPartnerPrice,
          auditTrail,
        });
      } catch (error) {
        failures.push({
          id: String(line.id),
          itemCode: line.itemCode,
          stage: 'sap_price',
          reason: error.message,
          status: error?.response?.status ?? error?.details?.status ?? null,
        });
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const warehouseStockProperties = await this.credentialRepository
        .resolveWarehouseStockProperties({
          tenantModels,
          itemWarehouseInfoCollection: pricing.sapItemData?.ItemWarehouseInfoCollection,
        });
      const tax = taxSettings?.taxCodes?.find(
        (entry) => toNonEmptyString(entry?.Code)
          === toNonEmptyString(pricing.sapItemData?.[taxSettings.fieldItem])
      ) || {};
      const quantity = normalizeQuantity(line.quantity);
      const priceCalculation = calculateUnitPriceWithMisc({
        sapPrice: pricing.priceData?.Price ?? 0,
        lineItem: line,
        config: miscPriceCalculationConfig,
      });
      const price = priceCalculation.price;

      enriched.push({
        itemCode: line.itemCode,
        id: String(line.id),
        quantity,
        Price: price,
        ...(priceCalculation.originalPriceTargetProperty
          ? {
            originalPrice: priceCalculation.originalPrice,
            originalPriceTargetProperty: priceCalculation.originalPriceTargetProperty,
          }
          : {}),
        Currency: pricing.priceData?.Currency ?? null,
        Discount: 0,
        lineTotal: roundCurrency(quantity * price),
        ...(toNonEmptyString(tax.HSCode) ? { tax: tax.HSCode } : {}),
        ...(discountHsField ? { _discountHsProperty: discountHsField } : {}),
        warehouseStockProperties,
      });
      priced.push({ id: String(line.id), itemCode: line.itemCode, price, source: pricing.source });
    }

    if (enriched.length > 0) {
      await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/line_items/batch/update' },
        () => this.hubspotPriceClient.updateLineItems({
          token,
          enrichedLineItems: enriched,
          tenantKey,
        })
      );
    }

    return { triggered: true, trigger, priced, failures, enriched };
  }
```

- [ ] **Step 4: Llamarla y mover el `amount` al cierre**

En `execute`, después de `updateProducts` y **antes** del bloque de `totalAmount`:

```javascript
      const updatedIds = new Set(
        (Array.isArray(hubspotUpdate.response?.results)
          ? hubspotUpdate.response.results.map((entry) => String(entry?.id))
          : hubspotUpdate.payload.inputs.map((input) => String(input.id))
        ).filter(Boolean)
      );

      const reconciliation = dealId
        ? await this.reconcile({
          token, dealId, updatedIds, sapCache, callRecorder, sapConfig, cardCode,
          currentDate, tenantKey, itemSelectFields, fallbackPriceList,
          useBusinessPartnerPrice, miscPriceCalculationConfig, taxSettings,
          discountHsField, auditTrail, tenantModels,
        })
        : { triggered: false, trigger: [], priced: [], failures: [], enriched: [] };
```

Reemplazar el cálculo del total (línea 335) para que sume las dos rondas:

```javascript
      const allPricedLines = [...enrichedLineItems, ...reconciliation.enriched];
      const totalAmount = roundCurrency(
        allPricedLines.reduce((sum, line) => sum + line.lineTotal, 0)
      );
```

El `if (dealId) { dealUpdate = await callRecorder.record(...) }` queda **después** de eso, tal como está hoy pero en su nueva posición. Agregar al `meta` del return:

```javascript
          reconciliation: {
            triggered: reconciliation.triggered,
            trigger: reconciliation.trigger,
            pricedCount: reconciliation.priced.length,
          },
```

- [ ] **Step 5: Correr los tests**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js
```

Esperado: PASS, los 5 nuevos y todos los anteriores.

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/SyncLineItemPrices.js tests/unit/application/syncLineItemPrices.test.js
git commit -m "feat: reconcile deal line items once after pricing, reusing the SAP cache"
```

---

### Task 8: Ensamblar y propagar el audit

**Files:**
- Modify: `src/application/use-cases/SyncLineItemPrices.js` (return y `catch`)
- Modify: `src/infrastructure/webhook/lineItemPriceWebhook.service.js:615-627` (audit fatal)
- Modify: `src/infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js:29-35`
- Modify: `src/interfaces/http/controllers/lineItemPrice.controller.js:67-72`, `:97-103`
- Test: `tests/unit/application/syncLineItemPrices.test.js`, `tests/unit/lineItemPrice.controller.test.js`

**Interfaces:**
- Consumes: `buildLineItemPriceAudit` (T1), `markAsSent/markAsError` con audit (T2)
- Produces: `result.audit`, `error.lineItemPriceAudit`

- [ ] **Step 1: Escribir el test que falla**

```javascript
  it('returns an audit with the failed line and its stage', async () => {
    const { useCase, sapPriceClient } = createUseCase();

    sapPriceClient.fetchBusinessPartnerPrice = jest.fn(async ({ itemCode }) => {
      if (itemCode === 'BAD') {
        throw new Error('Price list 4 not found for item BAD');
      }
      return { Price: 100, Currency: 'C$', Discount: 0 };
    });

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'BAD', id: 'line-2', quantity: 1 },
        ],
        lineItemFailures: [{
          id: 'line-3', stage: 'hubspot_read', reason: '404 Not Found', status: 404,
          endpoint: '/crm/v3/objects/line_items/line-3',
        }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    const failures = result.audit.rounds[0].failures;
    expect(failures.map((entry) => entry.stage).sort()).toEqual(['hubspot_read', 'sap_price']);
    expect(result.audit.dealId).toBe('deal-1');
    expect(result.audit.amount.written).toBe(true);
  });

  it('attaches the audit to the thrown error when the whole deal fails', async () => {
    const failing = createUseCase({
      sapPriceClient: {
        fetchBusinessPartnerPrice: jest.fn().mockRejectedValue(new Error('SAP down')),
        fetchItemPrices: jest.fn().mockRejectedValue(new Error('SAP down')),
      },
    });

    await expect(failing.useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1' }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    )).rejects.toMatchObject({
      lineItemPriceAudit: expect.objectContaining({
        rounds: expect.any(Array),
      }),
    });
  });
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncLineItemPrices.test.js -t "audit"
```

Esperado: FAIL — `result.audit` es `undefined`.

- [ ] **Step 3: Inyectar el constructor de audit y armarlo**

En el constructor de `SyncLineItemPrices`, agregar el parámetro:

```javascript
    buildLineItemPriceAudit = () => null,
```

```javascript
    this.buildLineItemPriceAudit = buildLineItemPriceAudit;
```

Al inicio de `execute`, junto a `auditTrail`:

```javascript
    const auditRounds = [];
```

Después del ciclo de la ronda 1, empujar la ronda:

```javascript
      auditRounds.push({
        round: 1,
        lineItemIdsFromDeal: payload.lineItems.map((line) => String(line.id)),
        priced: pricedLog,
        failures: roundFailures,
      });
```

Después de la reconciliación:

```javascript
      if (reconciliation.triggered) {
        auditRounds.push({
          round: 2,
          trigger: reconciliation.trigger,
          priced: reconciliation.priced,
          failures: reconciliation.failures,
        });
      }
```

En el `return`, agregar:

```javascript
        audit: this.buildLineItemPriceAudit({
          dealId,
          cardCode,
          rounds: auditRounds,
          calls: callRecorder.calls,
          unresolved: [
            ...roundFailures,
            ...(reconciliation.failures ?? []),
          ],
          amount: { written: Boolean(dealUpdate), total: totalAmount },
        }),
```

En el `catch` (línea 372), antes del `throw`:

```javascript
      error.lineItemPriceAudit = this.buildLineItemPriceAudit({
        dealId: toNonEmptyString(payload?.dealId) || toNonEmptyString(payload?.fromObjectId),
        cardCode: toNonEmptyString(payload?.cardCode),
        rounds: auditRounds,
        calls: callRecorder.calls,
        unresolved: [],
        fatalError: {
          message: error.message,
          status: error?.details?.status ?? error?.response?.status ?? null,
          endpoint: error?.details?.endpoint ?? null,
        },
      });
```

Mover `auditRounds`, `callRecorder`, `roundFailures` y `reconciliation` a `let` declarados **fuera** del `try` para que el `catch` los vea. Inicializar `reconciliation` en `{ triggered: false, trigger: [], priced: [], failures: [], enriched: [] }`.

- [ ] **Step 4: Cablear en composition**

En `src/composition/line-item-prices.composition.js`, agregar al import de `syncLog.service.js` (línea 10-13) `buildLineItemPriceAudit`, y pasarlo al `new SyncLineItemPrices({...})`:

```javascript
    buildLineItemPriceAudit,
```

- [ ] **Step 5: VERIFICAR EL CABLEADO**

```bash
grep -n "buildLineItemPriceAudit" src/composition/line-item-prices.composition.js
```

Esperado: dos líneas (import y clave del `new`).

- [ ] **Step 6: Propagar por el adapter y el controlador**

En `src/infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js`, líneas 29-35:

```javascript
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
```

En `src/interfaces/http/controllers/lineItemPrice.controller.js`, línea 68:

```javascript
          await dependencies.webhookPayload.markAsSent(
            tenantModels.LineItemPriceWebhookEvent,
            executionId,
            result.audit
          );
```

Y línea 98:

```javascript
          await dependencies.webhookPayload.markAsError(
            tenantModels.LineItemPriceWebhookEvent,
            executionId,
            error,
            error.lineItemPriceAudit ?? null
          );
```

- [ ] **Step 7: Audit para el fallo fatal de `preparePayload`**

En `src/infrastructure/webhook/lineItemPriceWebhook.service.js`, en el `catch` de `preparePayload` (líneas 615-627), pasar a usar `markAsError` para que el audit fatal también quede guardado:

```javascript
    } catch (error) {
      // Un fallo acá (GET del deal, token, credenciales) deja el evento sin nada valorizado.
      // Se guarda un audit mínimo para que se vea el endpoint y el status, que es justo lo
      // que faltaba cuando el cliente reportó "no cargan los precios".
      await lineItemPriceWebhookService.markAsError(
        LineItemPriceWebhookEvent,
        createdEvent._id,
        error,
        buildLineItemPriceAudit({
          dealId: toNonEmptyString(payload?.fromObjectId),
          rounds: [],
          calls: [],
          unresolved: [],
          fatalError: {
            message: error.message,
            status: error?.details?.status ?? error?.response?.status ?? null,
            endpoint: error?.details?.endpoint ?? null,
          },
        })
      );

      throw error;
    }
```

Agregar el import:

```javascript
import { buildLineItemPriceAudit } from '../sync/syncLog.service.js';
```

- [ ] **Step 8: Correr toda la suite**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest
```

Esperado: sin fallos nuevos respecto al baseline. `tests/unit/lineItemPrice.controller.test.js` puede necesitar que sus dobles de `markAsSent`/`markAsError` acepten el cuarto argumento.

- [ ] **Step 9: Commit**

```bash
git add src/application/use-cases/SyncLineItemPrices.js src/composition/line-item-prices.composition.js src/infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js src/infrastructure/webhook/lineItemPriceWebhook.service.js src/interfaces/http/controllers/lineItemPrice.controller.js tests/
git commit -m "feat: persist the line item price audit on the webhook event"
```

---

### Task 9: Guard de duplicados y reutilización del registro en el reintento

**Files:**
- Modify: `src/infrastructure/webhook/lineItemPriceWebhook.service.js:559-599`
- Test: `tests/unit/lineItemPriceWebhook.service.test.js`

**Interfaces:**
- Produces: `preparePayload` reutiliza el registro fallido en un reintento en lugar de crear uno nuevo

- [ ] **Step 1: Escribir los tests que fallan**

```javascript
  it('processes a HubSpot retry after a failed attempt instead of skipping it as duplicate', async () => {
    const tenantModels = buildTenantModels();
    const previous = { _id: 'event-previous' };

    // Primer findOne: guard de duplicados con $or -> no hay duplicado "vivo".
    // Segundo findOne: registro fallido previo con el mismo filtro -> se reutiliza.
    tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
      .mockReturnValueOnce(leanResult(null))
      .mockReturnValueOnce(leanResult(previous));

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/64058987777') {
        return {
          id: '64058987777',
          associations: {
            companies: { results: [{ id: 'company-1' }] },
            'line items': { results: [{ id: 'line-1' }] },
          },
        };
      }
      if (path === '/crm/v3/objects/companies/company-1') {
        return { id: 'company-1', properties: { idsap: 'C20000' } };
      }
      return { id: 'line-1', properties: { hs_sku: 'A0001', quantity: '1' } };
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 2073333923,
        subscriptionId: 6955444,
        portalId: 50249912,
        appId: 36665006,
        occurredAt: 1786997905997,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 64058987777,
      },
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result.skip).toBe(false);
    expect(result.executionId).toBe('event-previous');
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-previous' },
      { $set: { isSend: false, errorMessage: null } }
    );
  });

  it('still skips a resend of an already successful event', async () => {
    const tenantModels = buildTenantModels();
    tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
      .mockReturnValueOnce(leanResult({ _id: 'event-done' }));

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 2073333923,
        subscriptionId: 6955444,
        portalId: 50249912,
        appId: 36665006,
        occurredAt: 1786997905997,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 64058987777,
      },
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result).toMatchObject({ skip: true, meta: { reason: 'duplicate_event' } });
  });
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/lineItemPriceWebhook.service.test.js -t "HubSpot retry after a failed attempt"
```

Esperado: FAIL — el primer `findOne` devuelve el registro fallido y se salta como duplicado.

- [ ] **Step 3: Reemplazar el bloque de duplicado y creación**

Reemplazar las líneas 559-599 por:

```javascript
    const { LineItemPriceWebhookEvent } = tenantModels;
    const duplicateFilter = buildDuplicateFilter(payload);
    // El $or va acá y NO dentro de buildDuplicateFilter: ese helper es compartido y la
    // estrategia dealPriceList ya le agrega el mismo $or por su cuenta.
    // Sin esto, un reintento de HubSpot tras un fallo nuestro se descartaba como duplicado y
    // el precio no cargaba nunca.
    const duplicate = await LineItemPriceWebhookEvent.findOne({
      ...duplicateFilter,
      $or: [{ isSend: true }, { errorMessage: null }],
    })
      .select({ _id: 1 })
      .lean();

    if (duplicate) {
      return {
        skip: true,
        payload: null,
        executionId: duplicate._id,
        meta: {
          skipped: true,
          reason: 'duplicate_event',
        },
      };
    }

    // El índice único cubre los 6 campos del filtro, así que un reintento NO puede crear un
    // registro nuevo: hay que reutilizar el que quedó del intento fallido.
    let createdEvent = await LineItemPriceWebhookEvent.findOne(duplicateFilter)
      .select({ _id: 1 })
      .lean();

    if (createdEvent) {
      await LineItemPriceWebhookEvent.updateOne(
        { _id: createdEvent._id },
        { $set: { isSend: false, errorMessage: null } }
      );
    } else {
      try {
        createdEvent = await LineItemPriceWebhookEvent.create({
          payload,
          isSend: false,
          errorMessage: null,
        });
      } catch (error) {
        if (error?.code === 11000) {
          // Carrera con otro proceso que insertó el mismo evento: se reutiliza el suyo.
          createdEvent = await LineItemPriceWebhookEvent.findOne(duplicateFilter)
            .select({ _id: 1 })
            .lean();

          if (!createdEvent) {
            return {
              skip: true,
              payload: null,
              executionId: null,
              meta: {
                skipped: true,
                reason: 'duplicate_event',
              },
            };
          }
        } else {
          throw error;
        }
      }
    }
```

- [ ] **Step 4: Correr los tests**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/lineItemPriceWebhook.service.test.js
```

Esperado: PASS, todo el archivo.

- [ ] **Step 5: Correr toda la suite**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest
```

Esperado: sin fallos nuevos respecto al baseline anotado en Task 0.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/webhook/lineItemPriceWebhook.service.js tests/unit/lineItemPriceWebhook.service.test.js
git commit -m "fix: let HubSpot retries reprocess a failed line item price event"
```

---

### Task 10: Verificación manual contra el tenant de pruebas

**Files:** ninguno (verificación)

- [ ] **Step 1: Levantar el servidor**

```bash
npm run dev
```

- [ ] **Step 2: Caso "un ítem sin precio en SAP"**

Con la estrategia `businessPartner` activa, crear un deal con 3 líneas, una con un `hs_sku` que no existe en SAP. Tocar una asociación para disparar el webhook.

Esperado: 2 líneas con precio en HubSpot; el evento en `LineItemPriceWebhookEvents` con `isSend: true` y `audit.rounds[0].failures` con la tercera línea en `stage: 'sap_price'`.

- [ ] **Step 3: Caso "el 404 reportado"**

Deal con 2 líneas: quitar una desde la UI de HubSpot y agregar otra en la misma ráfaga.

Esperado: las líneas que quedan cargan precio. **Revisar si aparece un `hubspot_read` con `status: 404` en `audit`** — esto es lo que confirma o descarta la hipótesis del índice de asociaciones desfasado.

- [ ] **Step 4: Caso "todo cuadra"**

Deal cuyas líneas todas resuelven precio.

Esperado: `audit.rounds` tiene un solo elemento (la reconciliación no se disparó) y `meta.reconciliation.triggered` es `false`.

- [ ] **Step 5: Verificar que Mongo aceptó las escrituras**

```bash
grep -i "dollar\|audit could not be persisted" logs/app.log
```

Esperado: sin coincidencias. Confirmar en Mongo que los documentos tienen `audit` poblado.

- [ ] **Step 6: Anotar el hallazgo del paso 3**

Si el 404 apareció como `hubspot_read`, la hipótesis queda confirmada y se puede cerrar el reporte del cliente. Si apareció como otro `stage` o como `fatalError`, el diagnóstico cambia y hay que volver al spec.

---

## Notas de auto-revisión

Cobertura del spec, sección por sección:

| Requisito del spec | Tarea |
|---|---|
| Campo `audit` en el evento | T2 |
| `buildLineItemPriceAudit` + exportar `sanitizeAuditKeys`/`truncateAuditBody` | T1 |
| Tope de llamadas y llamadas exitosas compactas | T1 |
| `updateOne` separado para el audit | T2 |
| Lector tolerante + puerto | T3 |
| `buildLegacyPayload` tolerante y `lineItemFailures` | T4 |
| Grabador con `target` + cableado | T5 |
| Tolerancia SAP + caché por `itemCode` | T6 |
| Reconciliación de una ronda + disparadores | T7 |
| `amount` una sola vez al cierre | T7 |
| `stage` de los fallos (`hubspot_read`/`sap_price`) | T4, T6 |
| Clasificación fatal (cero líneas, deal, token) | T4 (deal/token), T6 (cero líneas) |
| Guard de duplicados + `E11000` | T9 |
| Verificación manual | T10 |

Pendiente conocido: el `stage: 'hubspot_write'` (línea aceptada por el batch pero rechazada por HubSpot) no tiene tarea propia. `batchUpdateLineItems` devuelve 207 con `errors` y hoy nadie los mira. Queda como deuda: se registrará en el audit sólo cuando el batch entero falle, no por línea rechazada.
