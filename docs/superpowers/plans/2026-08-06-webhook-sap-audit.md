# Webhook SAP Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `WebhookEvent` (createDeal, createQuotation, updateQuotation, convertQuotationToOrder) persists a `sapAudit` field with everything sent to and received from SAP — BusinessPartner, ContactEmployee, and the order/quotation — on both success and failure, so a failed event can be diagnosed without reproducing it.

**Architecture:** Each of the four webhook use cases already builds an in-memory `auditTrail` object as it calls SAP. A new pure function, `buildWebhookSapAudit`, condenses that trail into a persistable shape and is injected into each use case (same pattern as the existing `buildWebhookSyncErrorEntry`). Each use case attaches the result to its success `return` and to `error.sapAudit` in its `catch`. `ProcessWebhookDealEventBatch` forwards `result.sapAudit` / `error.sapAudit` to `MongooseWebhookEventRepository`, which writes it to the new `sapAudit` schema field.

**Tech Stack:** Node.js ESM, Jest (`NODE_OPTIONS=--experimental-vm-modules jest`), Mongoose.

**Spec:** [docs/superpowers/specs/2026-08-06-webhook-sap-audit-design.md](../specs/2026-08-06-webhook-sap-audit-design.md)

## Global Constraints

- Application-layer code (`src/application/**`) must never import from `src/infrastructure/**` directly — dependencies cross that boundary only via constructor injection (enforced by `tests/unit/architecture/hexagonalBoundaries.test.js`).
- Every new/changed function that sits in an error path must never throw back into its caller.
- Baseline test suite (before this plan): **6 failed suites / 108 total, 12 failed tests / 820 total** — all failures pre-existing and unrelated to webhooks (`sendMappedItemsToHubspot`, `lineItemPriceWebhook.service`, `syncLineItemPrices`, `serviceLayerService`, `serviceLayerFlow`, `integration/internalTenant`). No task in this plan may change that count.
- Run the full suite with: `NODE_OPTIONS=--experimental-vm-modules npx jest` (bash) from the repo root.

---

### Task 1: `buildWebhookSapAudit` utility

**Files:**
- Modify: `src/infrastructure/sync/syncLog.service.js`
- Test: `tests/unit/infrastructure/webhookSapAudit.test.js` (create)

**Interfaces:**
- Produces: `buildWebhookSapAudit(auditTrail)` — pure function, never throws. `auditTrail` is the shape already built by each use case (`{ payload_Hubspot, payload_SAP: {...}, response_hubspot, response_SAP: {...} }`, or `null`/`undefined`). Returns either `null` (when `payload_SAP`, `response_SAP`, and `response_hubspot` are all empty/all-null) or `{ payloadSap, responseSap, responseHubspot, capturedAt }` where `capturedAt` is an ISO date string.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/infrastructure/webhookSapAudit.test.js`:

```js
import { buildWebhookSapAudit } from '../../../src/infrastructure/sync/syncLog.service.js';

describe('buildWebhookSapAudit', () => {
  it('returns null when the audit trail has no SAP or HubSpot activity', () => {
    const auditTrail = {
      payload_Hubspot: { deal: {} },
      payload_SAP: { businessPartner: null, contactEmployee: null, quotation: null },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, quotation: null },
    };

    expect(buildWebhookSapAudit(auditTrail)).toBeNull();
  });

  it('returns null for a null or undefined audit trail', () => {
    expect(buildWebhookSapAudit(null)).toBeNull();
    expect(buildWebhookSapAudit(undefined)).toBeNull();
  });

  it('captures business partner, contact employee and document request/response', () => {
    const auditTrail = {
      payload_Hubspot: { deal: { hs_object_id: '1' } },
      payload_SAP: {
        businessPartner: { CardCode: 'CL001', CardName: 'Acme' },
        contactEmployee: { Name: 'Jane' },
        order: { CardCode: 'CL001', DocumentLines: [{ ItemCode: 'A1' }] },
      },
      response_hubspot: { deal: { ok: true } },
      response_SAP: {
        businessPartner: { CardCode: 'CL001' },
        contactEmployee: { InternalCode: 5 },
        order: { DocEntry: 10, DocNum: 20 },
      },
    };

    const result = buildWebhookSapAudit(auditTrail);

    expect(result).toEqual({
      payloadSap: {
        businessPartner: { CardCode: 'CL001', CardName: 'Acme' },
        contactEmployee: { Name: 'Jane' },
        order: { CardCode: 'CL001', DocumentLines: [{ ItemCode: 'A1' }] },
      },
      responseSap: {
        businessPartner: { CardCode: 'CL001' },
        contactEmployee: { InternalCode: 5 },
        order: { DocEntry: 10, DocNum: 20 },
      },
      responseHubspot: { deal: { ok: true } },
      capturedAt: expect.any(String),
    });
    expect(() => new Date(result.capturedAt).toISOString()).not.toThrow();
  });

  it('omits keys that do not apply to this event type instead of inventing them', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, quotation: { CardCode: 'CL001' } },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, quotation: { DocEntry: 1 } },
    };

    const result = buildWebhookSapAudit(auditTrail);

    expect(result.payloadSap).not.toHaveProperty('order');
    expect(result.payloadSap.quotation).toEqual({ CardCode: 'CL001' });
  });

  it('degrades a circular SAP response to a string instead of throwing', () => {
    const circular = { CardCode: 'CL001' };
    circular.self = circular;
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, order: { CardCode: 'CL001' } },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, order: circular },
    };

    expect(() => buildWebhookSapAudit(auditTrail)).not.toThrow();
    const result = buildWebhookSapAudit(auditTrail);
    expect(result).not.toBeNull();
    expect(typeof result.responseSap.order).toBe('string');
  });

  it('returns a real record when only the HubSpot response has content', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, order: null },
      response_hubspot: { deal: { ok: true } },
      response_SAP: { businessPartner: null, contactEmployee: null, order: null },
    };

    expect(buildWebhookSapAudit(auditTrail)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/webhookSapAudit.test.js`
Expected: FAIL — `buildWebhookSapAudit is not a function` / `does not provide an export named 'buildWebhookSapAudit'` (the export doesn't exist yet).

- [ ] **Step 3: Implement `buildWebhookSapAudit`**

In `src/infrastructure/sync/syncLog.service.js`, insert the following after `buildWebhookSyncErrorEntry` (after its closing `}` at line 55) and before `const SYNC_LOG_OBJECT_TYPES = ...`:

```js
function isEmptyAuditValue(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isEmptyAuditValue);
  }

  if (typeof value === 'object') {
    return Object.values(value).every(isEmptyAuditValue);
  }

  return false;
}

// Builds the persisted record of everything a webhook use case sent to and received from
// SAP (BusinessPartner, ContactEmployee, order/quotation), plus the HubSpot response, so a
// failed WebhookEvent shows exactly what was attempted instead of just an error message.
// Returns null when nothing was ever sent to SAP (e.g. the use case failed before its first
// SAP call), so WebhookEvent documents aren't cluttered with an all-null audit record.
export function buildWebhookSapAudit(auditTrail) {
  try {
    const payloadSap = serializeLogValue(auditTrail?.payload_SAP ?? null);
    const responseSap = serializeLogValue(auditTrail?.response_SAP ?? null);
    const responseHubspot = serializeLogValue(auditTrail?.response_hubspot ?? null);

    if (isEmptyAuditValue(payloadSap) && isEmptyAuditValue(responseSap) && isEmptyAuditValue(responseHubspot)) {
      return null;
    }

    return {
      payloadSap,
      responseSap,
      responseHubspot,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/webhookSapAudit.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sync/syncLog.service.js tests/unit/infrastructure/webhookSapAudit.test.js
git commit -m "feat: add buildWebhookSapAudit to condense SAP traffic for WebhookEvent auditing"
```

---

### Task 2: `sapAudit` schema field and repository persistence

**Files:**
- Modify: `src/infrastructure/database/models/tenant/WebhookEvent.js:44-48`
- Modify: `src/infrastructure/repositories/MongooseWebhookEventRepository.js`
- Test: `tests/unit/infrastructure/mongooseWebhookEventRepository.test.js` (extend)

**Interfaces:**
- Consumes: nothing new from Task 1 directly (schema/repository just store whatever `sapAudit` value they're given).
- Produces: `MongooseWebhookEventRepository.markCompleted(event, result)` writes `sapAudit` to Mongo when `result.sapAudit` is present. `markFailed(event, failure)` writes `sapAudit` when `failure.sapAudit` is present. Neither method writes `payload.payloadSAP` anymore — `sapAudit` supersedes it as the closing-write record. (`MongooseWebhookEventProgressRepository.markOrderCreated`'s own `payload.payloadSAP` write, used as an interim crash-recovery marker before the event closes, is untouched — out of scope for this task.)

- [ ] **Step 1: Write the failing tests**

Read the current `tests/unit/infrastructure/mongooseWebhookEventRepository.test.js` first — it already has 3 tests for `markFailed`'s `lastError` coercion (from a prior fix) using this pattern:

```js
const updateOne = jest.fn().mockResolvedValue({});
const WebhookEvent = { updateOne };
const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
```

Add these 5 tests inside the existing `describe('MongooseWebhookEventRepository', ...)` block, after the last existing test (`'leaves an already-safe string lastError intact'`):

```js
  it('markCompleted writes sapAudit when the result carries one', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } }, capturedAt: '2026-01-01T00:00:00.000Z' };

    await repository.markCompleted(event, {
      docEntry: 10,
      docNum: 20,
      cardCode: 'CL001',
      sapAudit,
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect($set.sapAudit).toEqual(sapAudit);
  });

  it('markCompleted omits sapAudit when the result has none', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markCompleted(event, { docEntry: 10, docNum: 20, cardCode: 'CL001' });

    const [, { $set }] = updateOne.mock.calls[0];
    expect(Object.keys($set)).not.toContain('sapAudit');
  });

  it('markCompleted no longer writes payload.payloadSAP', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markCompleted(event, {
      docEntry: 10,
      docNum: 20,
      cardCode: 'CL001',
      payloadSap: { CardCode: 'CL001' },
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect(Object.keys($set)).not.toContain('payload.payloadSAP');
  });

  it('markFailed writes sapAudit when the failure carries one', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };
    const sapAudit = { payloadSap: { quotation: { CardCode: 'CL001' } }, capturedAt: '2026-01-01T00:00:00.000Z' };

    await repository.markFailed(event, {
      status: 'errored',
      retries: 3,
      lastError: 'SAP timeout',
      sapAudit,
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect($set.sapAudit).toEqual(sapAudit);
  });

  it('markFailed no longer writes payload.payloadSAP even when failure.payloadSap is given', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markFailed(event, {
      status: 'errored',
      retries: 3,
      lastError: 'SAP timeout',
      payloadSap: { CardCode: 'CL001' },
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect(Object.keys($set)).not.toContain('payload.payloadSAP');
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/mongooseWebhookEventRepository.test.js`
Expected: FAIL — the 2 new "no longer writes payload.payloadSAP" tests fail because the key is still present (current code still writes it); the 3 "writes/omits sapAudit" tests fail because `$set.sapAudit` is `undefined`.

- [ ] **Step 3: Add the schema field**

In `src/infrastructure/database/models/tenant/WebhookEvent.js`, change:

```js
    lastError: {
      type: String,
      default: null,
    },
  },
```

to:

```js
    lastError: {
      type: String,
      default: null,
    },
    sapAudit: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
```

- [ ] **Step 4: Update the repository**

In `src/infrastructure/repositories/MongooseWebhookEventRepository.js`, change `markCompleted`:

```js
  async markCompleted(event, result) {
    const updates = {
      status: 'completed',
      lastError: null,
      'payload.sapResult': {
        docEntry: result.docEntry,
        docNum: result.docNum,
        cardCode: result.cardCode,
      },
      'payload.processedAt': new Date().toISOString(),
    };

    if (result.payloadSap) {
      updates['payload.payloadSAP'] = result.payloadSap;
    }

    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: updates,
      }
    );
  }
```

to:

```js
  // payload.payloadSAP (the old single-document snapshot) is superseded by sapAudit, which
  // captures request + response for BusinessPartner, ContactEmployee and the document
  // together -- see buildWebhookSapAudit in infrastructure/sync/syncLog.service.js.
  async markCompleted(event, result) {
    const updates = {
      status: 'completed',
      lastError: null,
      'payload.sapResult': {
        docEntry: result.docEntry,
        docNum: result.docNum,
        cardCode: result.cardCode,
      },
      'payload.processedAt': new Date().toISOString(),
    };

    if (result.sapAudit) {
      updates.sapAudit = result.sapAudit;
    }

    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: updates,
      }
    );
  }
```

And `markFailed`:

```js
  async markFailed(event, failure) {
    const updates = {
      status: failure.status,
      retries: failure.retries,
      lastError: toSafeLastError(failure.lastError),
    };

    if (failure.sapResult) {
      updates['payload.sapResult'] = {
        docEntry: failure.sapResult.docEntry ?? null,
        docNum: failure.sapResult.docNum ?? null,
        cardCode: failure.sapResult.cardCode ?? null,
      };
    }

    if (failure.payloadSap) {
      updates['payload.payloadSAP'] = failure.payloadSap;
    }

    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: updates,
      }
    );
  }
```

to:

```js
  async markFailed(event, failure) {
    const updates = {
      status: failure.status,
      retries: failure.retries,
      lastError: toSafeLastError(failure.lastError),
    };

    if (failure.sapResult) {
      updates['payload.sapResult'] = {
        docEntry: failure.sapResult.docEntry ?? null,
        docNum: failure.sapResult.docNum ?? null,
        cardCode: failure.sapResult.cardCode ?? null,
      };
    }

    if (failure.sapAudit) {
      updates.sapAudit = failure.sapAudit;
    }

    await this.WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: updates,
      }
    );
  }
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/mongooseWebhookEventRepository.test.js`
Expected: PASS (8 tests: 3 pre-existing + 5 new)

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/database/models/tenant/WebhookEvent.js src/infrastructure/repositories/MongooseWebhookEventRepository.js tests/unit/infrastructure/mongooseWebhookEventRepository.test.js
git commit -m "feat: persist sapAudit on WebhookEvent and stop writing payload.payloadSAP"
```

---

### Task 3: Forward `sapAudit` through `ProcessWebhookDealEventBatch`

**Files:**
- Modify: `src/application/use-cases/ProcessWebhookDealEventBatch.js`
- Test: `tests/unit/application/processWebhookDealEventBatch.test.js` (extend)

**Interfaces:**
- Consumes: nothing from Task 1/2 directly at compile time (this is plain pass-through of `result.sapAudit` / `error.sapAudit`, whatever shape Task 1 produces).
- Produces: `markFailed` is now called with a `sapAudit` key sourced from `error?.sapAudit` (normal/`sapOrderCreated` branches of `handleProcessingError`) or `result?.sapAudit` (`handlePostSapBookkeepingFailure`). Deliberately uses `error?.sapAudit` / `result?.sapAudit` with **no** `?? null` fallback: when the caller never sets `.sapAudit` (as none of the 9 existing tests in this file do), the key evaluates to `undefined`, which Jest's `toHaveBeenCalledWith` treats as equivalent to an absent key — so none of the 9 existing tests need to change.

- [ ] **Step 1: Write the failing tests**

Add these 3 tests to `tests/unit/application/processWebhookDealEventBatch.test.js`, inside the `describe('ProcessWebhookDealEventBatch', ...)` block, after the last existing test:

```js
  it('forwards error.sapAudit to markFailed on a normal transient failure', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { quotation: { CardCode: 'CL001' } } };
    const error = new Error('SAP timeout');
    error.sapAudit = sapAudit;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });

  it('forwards error.sapAudit to markFailed when SAP already created the order', async () => {
    const event = { _id: 'event-1', retries: 1, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } } };
    const error = new Error('HubSpot update failed');
    error.sapOrderCreated = true;
    error.sapOrderResult = { cardCode: 'C20000', docEntry: 10, docNum: 20 };
    error.sapAudit = sapAudit;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: error.message })),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });

  it('forwards result.sapAudit to markFailed when SAP succeeded but bookkeeping fails afterward', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } } };
    const result = { cardCode: 'C20000', docEntry: 10, docNum: 20, sapAudit };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn().mockRejectedValue(new Error('Mongo write failed')),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockResolvedValue(result),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: 'Mongo write failed' })),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processWebhookDealEventBatch.test.js`
Expected: FAIL — all 3 new tests fail because `markFailed` is called without a `sapAudit` key at all.

- [ ] **Step 3: Wire `sapAudit` through the three terminal call sites**

In `src/application/use-cases/ProcessWebhookDealEventBatch.js`, in `handleProcessingError`, change the `sapOrderCreated` branch's `markFailed` call:

```js
    if (error?.sapOrderCreated) {
      await this.webhookEventRepository.markFailed(event, {
        status: POST_SAP_FAILURE_STATUS,
        retries: currentRetries,
        lastError,
        sapResult: error.sapOrderResult,
        payloadSap: error.sapOrderPayload ?? null,
      });
```

to:

```js
    if (error?.sapOrderCreated) {
      await this.webhookEventRepository.markFailed(event, {
        status: POST_SAP_FAILURE_STATUS,
        retries: currentRetries,
        lastError,
        sapResult: error.sapOrderResult,
        payloadSap: error.sapOrderPayload ?? null,
        sapAudit: error?.sapAudit,
      });
```

Then the normal-branch `markFailed` call:

```js
    await this.webhookEventRepository.markFailed(event, {
      status: nextStatus,
      retries: nextRetries,
      lastError,
      payloadSap: error?.sapOrderPayload ?? null,
    });
```

to:

```js
    await this.webhookEventRepository.markFailed(event, {
      status: nextStatus,
      retries: nextRetries,
      lastError,
      payloadSap: error?.sapOrderPayload ?? null,
      sapAudit: error?.sapAudit,
    });
```

Then in `handlePostSapBookkeepingFailure`, change:

```js
    try {
      await this.webhookEventRepository.markFailed(event, {
        status: POST_SAP_FAILURE_STATUS,
        retries: currentRetries,
        lastError,
        sapResult: result,
        payloadSap: result?.payloadSap ?? null,
      });
```

to:

```js
    try {
      await this.webhookEventRepository.markFailed(event, {
        status: POST_SAP_FAILURE_STATUS,
        retries: currentRetries,
        lastError,
        sapResult: result,
        payloadSap: result?.payloadSap ?? null,
        sapAudit: result?.sapAudit,
      });
```

(`markCompleted` needs no change — it already receives the whole `result` object verbatim at the `execute()` call site, so any `sapAudit` a use case attaches to its return value already flows through untouched.)

- [ ] **Step 4: Run the tests and verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processWebhookDealEventBatch.test.js`
Expected: PASS (12 tests: 9 pre-existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add src/application/use-cases/ProcessWebhookDealEventBatch.js tests/unit/application/processWebhookDealEventBatch.test.js
git commit -m "feat: forward sapAudit from webhook use cases to the repository"
```

---

### Task 4: Attach `sapAudit` in `ProcessHubspotCreateQuotation`

**Files:**
- Modify: `src/application/use-cases/ProcessHubspotCreateQuotation.js`
- Modify: `src/composition/webhook-processing.composition.js`
- Test: `tests/unit/application/processQuotationFlows.test.js` (extend)

**Interfaces:**
- Consumes: `buildWebhookSapAudit(auditTrail)` from Task 1, injected via constructor (not imported directly — `application` cannot import `infrastructure`).
- Produces: adds `buildWebhookSapAudit` to the shared `noopSyncError` test double at the top of `processQuotationFlows.test.js` — Tasks 5 and 6 (same file) rely on it already being there.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/application/processQuotationFlows.test.js`, change the shared `noopSyncError` object at the top of the file:

```js
const noopSyncError = {
  buildWebhookSyncErrorEntry: jest.fn((x) => x),
  buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
};
```

to:

```js
const noopSyncError = {
  buildWebhookSyncErrorEntry: jest.fn((x) => x),
  buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
  buildWebhookSapAudit: jest.fn((auditTrail) => ({ auditTrail })),
};
```

Then, in the `describe('ProcessHubspotCreateQuotation', ...)` block, change the success-path assertion in `'creates a quotation, persists the SAP document link and updates the deal'`:

```js
    expect(result).toEqual({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
```

to:

```js
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
    expect(result.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({ CardCode: 'CL00129' });
    expect(result.sapAudit.auditTrail.response_SAP.quotation).toEqual({
      DocEntry: 12345,
      DocNum: 8001,
      DocumentLines: [{ LineNum: 0 }],
    });
```

Then add this new test at the end of the `describe('ProcessHubspotCreateQuotation', ...)` block, right before its closing `});`:

```js
  it('attaches sapAudit with the attempted quotation payload when SAP creation fails', async () => {
    const deps = buildDeps();
    const sapError = new Error('Request failed with status code 400');
    sapError.response = {
      data: {
        error: {
          code: -5002,
          message: { lang: 'en-us', value: 'To generate this document, first define the numbering series' },
        },
      },
    };
    deps.sapQuotationAdapter.createQuotation.mockRejectedValue(sapError);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    await expect(useCase.execute({ event: baseEvent, tenantModels })).rejects.toBe(sapError);

    expect(sapError.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({ CardCode: 'CL00129' });
    expect(sapError.sapAudit.auditTrail.response_SAP.quotation).toBeNull();
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js -t ProcessHubspotCreateQuotation`
Expected: FAIL — `result.sapAudit` is `undefined` (`Cannot read properties of undefined`), and the constructor doesn't yet accept/use `buildWebhookSapAudit`.

- [ ] **Step 3: Implement in `ProcessHubspotCreateQuotation`**

Change the constructor:

```js
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    sapQuotationAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.sapQuotationAdapter = sapQuotationAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.logger = logger;
  }
```

to:

```js
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    sapQuotationAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.sapQuotationAdapter = sapQuotationAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSapAudit = buildWebhookSapAudit;
    this.logger = logger;
  }
```

Change the success return:

```js
      return {
        cardCode,
        docEntry: quotationResponse?.DocEntry ?? null,
        docNum: quotationResponse?.DocNum ?? null,
        dealId,
      };
    } catch (error) {
      if (quotationResponse) {
```

to:

```js
      return {
        cardCode,
        docEntry: quotationResponse?.DocEntry ?? null,
        docNum: quotationResponse?.DocNum ?? null,
        dealId,
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
      }

      if (quotationResponse) {
```

(The idempotent-skip early return at `if (existingLink) { ...; return {cardCode, docEntry, docNum, dealId}; }` is untouched — no SAP call happens on that path, so there's nothing to audit.)

- [ ] **Step 4: Wire the composition**

In `src/composition/webhook-processing.composition.js`, change the import:

```js
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';
```

to:

```js
import {
  buildErrorResponseSnapshot,
  buildWebhookSapAudit,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';
```

Then change `buildProcessHubspotCreateQuotationUseCase`:

```js
export function buildProcessHubspotCreateQuotationUseCase() {
  return new ProcessHubspotCreateQuotation({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    sapQuotationAdapter: new SapWebhookQuotationAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}
```

to:

```js
export function buildProcessHubspotCreateQuotationUseCase() {
  return new ProcessHubspotCreateQuotation({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    sapQuotationAdapter: new SapWebhookQuotationAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger,
  });
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js`
Expected: PASS — all tests in the file pass (the `ProcessHubspotUpdateQuotation` and `ProcessHubspotConvertQuotationToOrder` describe blocks are untouched by this task and must still pass unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/ProcessHubspotCreateQuotation.js src/composition/webhook-processing.composition.js tests/unit/application/processQuotationFlows.test.js
git commit -m "feat: attach sapAudit to ProcessHubspotCreateQuotation success and failure paths"
```

---

### Task 5: Attach `sapAudit` in `ProcessHubspotUpdateQuotation`

**Files:**
- Modify: `src/application/use-cases/ProcessHubspotUpdateQuotation.js`
- Modify: `src/composition/webhook-processing.composition.js`
- Test: `tests/unit/application/processQuotationFlows.test.js` (extend)

**Interfaces:**
- Consumes: `noopSyncError.buildWebhookSapAudit` (added in Task 4) and `buildWebhookSapAudit` import (already added to composition in Task 4).

- [ ] **Step 1: Write the failing tests**

In `tests/unit/application/processQuotationFlows.test.js`, in the `describe('ProcessHubspotUpdateQuotation', ...)` block, change the test `'patches existing quotation lines and refreshes the stored link lines'` — after its existing assertions, add:

```js
    expect(result.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({
      Comments: 'Oferta actualizada por contrapropuesta desde HubSpot',
    });
```

so the full test body ends with:

```js
  it('patches existing quotation lines and refreshes the stored link lines', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const result = await useCase.execute({ event: updateEvent, tenantModels });

    expect(deps.sapQuotationAdapter.getQuotation).toHaveBeenCalledWith({
      sapConfig: expect.any(Object),
      docEntry: 12345,
    });
    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.DocumentLines).toEqual([{ LineNum: 0, UnitPrice: 17.5, Quantity: 2 }]);
    expect(patch.SalesPersonCode).toBe(61);
    expect(deps.sapDocumentLinkRepository.updateLines).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ docEntry: 12345, docNum: 8001, dealId: '59680314911' });
    expect(result.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({
      Comments: 'Oferta actualizada por contrapropuesta desde HubSpot',
    });
  });
```

Then add this new test at the end of the `describe('ProcessHubspotUpdateQuotation', ...)` block, right before its closing `});`:

```js
  it('attaches sapAudit with the attempted patch payload when SAP update fails', async () => {
    const deps = buildDeps();
    const sapError = new Error('SAP update failed');
    deps.sapQuotationAdapter.updateQuotation.mockRejectedValue(sapError);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await expect(useCase.execute({ event: updateEvent, tenantModels })).rejects.toBe(sapError);

    expect(sapError.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({
      DocumentLines: [{ LineNum: 0, UnitPrice: 17.5, Quantity: 2 }],
    });
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js -t ProcessHubspotUpdateQuotation`
Expected: FAIL — `result.sapAudit` is `undefined`.

- [ ] **Step 3: Implement in `ProcessHubspotUpdateQuotation`**

Change the constructor:

```js
  constructor({
    runtimeRepository,
    sapQuotationAdapter,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapQuotationAdapter = sapQuotationAdapter;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.logger = logger;
  }
```

to:

```js
  constructor({
    runtimeRepository,
    sapQuotationAdapter,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapQuotationAdapter = sapQuotationAdapter;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSapAudit = buildWebhookSapAudit;
    this.logger = logger;
  }
```

Change the success return and the start of the catch:

```js
      return {
        cardCode: link.cardCode,
        docEntry: link.sapDocEntry,
        docNum: link.sapDocNum,
        dealId,
      };
    } catch (error) {
      error.syncLogWebhookErrors = [
```

to:

```js
      return {
        cardCode: link.cardCode,
        docEntry: link.sapDocEntry,
        docNum: link.sapDocNum,
        dealId,
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
      }

      error.syncLogWebhookErrors = [
```

- [ ] **Step 4: Wire the composition**

In `src/composition/webhook-processing.composition.js`, change `buildProcessHubspotUpdateQuotationUseCase`:

```js
export function buildProcessHubspotUpdateQuotationUseCase() {
  return new ProcessHubspotUpdateQuotation({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapQuotationAdapter: new SapWebhookQuotationAdapter(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}
```

to:

```js
export function buildProcessHubspotUpdateQuotationUseCase() {
  return new ProcessHubspotUpdateQuotation({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapQuotationAdapter: new SapWebhookQuotationAdapter(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger,
  });
}
```

(the `buildWebhookSapAudit` import itself was already added to this file in Task 4 — do not add it again.)

- [ ] **Step 5: Run the tests and verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js`
Expected: PASS — all tests in the file pass.

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/ProcessHubspotUpdateQuotation.js src/composition/webhook-processing.composition.js tests/unit/application/processQuotationFlows.test.js
git commit -m "feat: attach sapAudit to ProcessHubspotUpdateQuotation success and failure paths"
```

---

### Task 6: Attach `sapAudit` in `ProcessHubspotConvertQuotationToOrder`

**Files:**
- Modify: `src/application/use-cases/ProcessHubspotConvertQuotationToOrder.js`
- Modify: `src/composition/webhook-processing.composition.js`
- Test: `tests/unit/application/processQuotationFlows.test.js` (extend)

**Interfaces:**
- Consumes: `noopSyncError.buildWebhookSapAudit` and the composition's `buildWebhookSapAudit` import (both added in Task 4).

- [ ] **Step 1: Write the failing tests**

In `tests/unit/application/processQuotationFlows.test.js`, in the `describe('ProcessHubspotConvertQuotationToOrder', ...)` block, change the success-path assertion in `'creates an order from the quotation using BaseType/BaseEntry/BaseLine'`:

```js
    expect(result).toEqual({
      cardCode: 'CL00129',
      docEntry: 67890,
      docNum: 9001,
      dealId: '59680314911',
      payloadSap: orderPayload,
    });
```

to:

```js
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 67890,
      docNum: 9001,
      dealId: '59680314911',
      payloadSap: orderPayload,
    });
    expect(result.sapAudit.auditTrail.payload_SAP.order).toBe(orderPayload);
    expect(result.sapAudit.auditTrail.response_SAP.order).toEqual({ DocEntry: 67890, DocNum: 9001 });
```

Then add this new test at the end of the `describe('ProcessHubspotConvertQuotationToOrder', ...)` block, right before its closing `});`:

```js
  it('attaches sapAudit with the attempted order payload when SAP order creation fails', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const sapError = new Error('SAP order create failed');
    deps.sapOrderAdapter.createOrder.mockRejectedValue(sapError);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    await expect(useCase.execute({ event: convertEvent, tenantModels })).rejects.toBe(sapError);

    expect(sapError.sapAudit.auditTrail.payload_SAP.order).toMatchObject({
      DocumentLines: [{ BaseType: 23, BaseEntry: 12345, BaseLine: 0 }],
    });
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js -t ProcessHubspotConvertQuotationToOrder`
Expected: FAIL — `result.sapAudit` is `undefined`.

- [ ] **Step 3: Implement in `ProcessHubspotConvertQuotationToOrder`**

Change the constructor:

```js
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    hubspotWebhookAdapter,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.logger = logger;
  }
```

to:

```js
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    hubspotWebhookAdapter,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSapAudit = buildWebhookSapAudit;
    this.logger = logger;
  }
```

Change the success return and the start of the catch:

```js
      return {
        cardCode,
        docEntry: orderResponse?.DocEntry ?? null,
        docNum: orderResponse?.DocNum ?? null,
        dealId,
        payloadSap: orderPayload,
      };
    } catch (error) {
      error.sapOrderPayload = auditTrail.payload_SAP.order;
```

to:

```js
      return {
        cardCode,
        docEntry: orderResponse?.DocEntry ?? null,
        docNum: orderResponse?.DocNum ?? null,
        dealId,
        payloadSap: orderPayload,
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
      }

      error.sapOrderPayload = auditTrail.payload_SAP.order;
```

- [ ] **Step 4: Wire the composition**

In `src/composition/webhook-processing.composition.js`, change `buildProcessHubspotConvertQuotationToOrderUseCase`:

```js
export function buildProcessHubspotConvertQuotationToOrderUseCase() {
  return new ProcessHubspotConvertQuotationToOrder({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}
```

to:

```js
export function buildProcessHubspotConvertQuotationToOrderUseCase() {
  return new ProcessHubspotConvertQuotationToOrder({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger,
  });
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js`
Expected: PASS — all tests in the file pass, including all three describe blocks (`ProcessHubspotCreateQuotation`, `ProcessHubspotUpdateQuotation`, `ProcessHubspotConvertQuotationToOrder`).

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/ProcessHubspotConvertQuotationToOrder.js src/composition/webhook-processing.composition.js tests/unit/application/processQuotationFlows.test.js
git commit -m "feat: attach sapAudit to ProcessHubspotConvertQuotationToOrder success and failure paths"
```

---

### Task 7: Attach `sapAudit` in `ProcessHubspotWebhookEvent` (createDeal) and retire `markBusinessPartnerCreated`

**Files:**
- Modify: `src/application/use-cases/ProcessHubspotWebhookEvent.js`
- Modify: `src/infrastructure/database/repositories/MongooseWebhookEventProgressRepository.js`
- Modify: `src/composition/webhook-processing.composition.js`
- Test: `tests/unit/webhookProcessor.flow.test.js` (extend — this is the only test coverage for `ProcessHubspotWebhookEvent`, exercised end-to-end through the real composition)

**Interfaces:**
- Consumes: `buildWebhookSapAudit` import from composition (already added in Task 4).
- Produces: `ProcessHubspotWebhookEvent`'s success return and `error.sapAudit` now carry the audit record, same contract as the other three use cases. `webhookEventProgressRepository.markBusinessPartnerCreated` no longer exists — it wrote `payload.payloadBPSAP` / `payload.responseBPSAP`, which `sapAudit.payloadSap.businessPartner` / `sapAudit.responseSap.businessPartner` now cover.

This is the only one of the four use cases with no dedicated unit test file (`ProcessHubspotWebhookEvent` is currently exercised only through `tests/unit/webhookProcessor.flow.test.js`, an integration-style test that runs the real use case against a mocked `axios` and mocked Mongoose models). Use that file as the TDD vehicle for this task.

- [ ] **Step 1: Write the failing test**

In `tests/unit/webhookProcessor.flow.test.js`, find the test `'keeps SAP order creation from being retried when HubSpot update fails afterward'` (it contains two `expect(tenantModels.WebhookEvent.updateOne).toHaveBeenCalledWith(...)` blocks). Change the **second** one:

```js
    expect(tenantModels.WebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'evt-1' },
      {
        $set: {
          status: 'sap_created_hubspot_error',
          retries: 0,
          lastError: 'HubSpot update failed',
          'payload.sapResult': {
            cardCode: 'CL99999',
            docEntry: 99,
            docNum: 199,
          },
          'payload.payloadSAP': expect.objectContaining({
            CardCode: 'CL99999',
          }),
        },
      }
    );
  });
});
```

to:

```js
    expect(tenantModels.WebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'evt-1' },
      {
        $set: expect.objectContaining({
          status: 'sap_created_hubspot_error',
          retries: 0,
          lastError: 'HubSpot update failed',
          'payload.sapResult': {
            cardCode: 'CL99999',
            docEntry: 99,
            docNum: 199,
          },
        }),
      }
    );

    const [, secondUpdateArgs] = tenantModels.WebhookEvent.updateOne.mock.calls[1];
    expect(Object.keys(secondUpdateArgs.$set)).not.toContain('payload.payloadSAP');
    expect(secondUpdateArgs.$set.sapAudit.payloadSap.order).toMatchObject({ CardCode: 'CL99999' });
    expect(secondUpdateArgs.$set.sapAudit.responseSap.order).toEqual({ DocEntry: 99, DocNum: 199 });
  });
});
```

(The **first** `toHaveBeenCalledWith` block right above it, for `markOrderCreated`'s interim write with `status: 'sap_order_created'`, is untouched — that write comes from `MongooseWebhookEventProgressRepository.markOrderCreated`, which this task does not modify.)

- [ ] **Step 2: Run the test and verify it fails**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/webhookProcessor.flow.test.js -t "keeps SAP order creation from being retried"`
Expected: FAIL — `secondUpdateArgs.$set.sapAudit` is `undefined` (`Cannot read properties of undefined (reading 'payloadSap')`), and `Object.keys(...)` still contains `'payload.payloadSAP'`.

- [ ] **Step 3: Implement in `ProcessHubspotWebhookEvent`**

Change the constructor:

```js
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    webhookEventProgressRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.webhookEventProgressRepository = webhookEventProgressRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.logger = logger;
  }
```

to:

```js
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    webhookEventProgressRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.webhookEventProgressRepository = webhookEventProgressRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSapAudit = buildWebhookSapAudit;
    this.logger = logger;
  }
```

Remove the `markBusinessPartnerCreated` call:

```js
      if (businessPartnerResult.created) {
        await this.webhookEventProgressRepository?.markBusinessPartnerCreated({
          WebhookEvent,
          eventId: event?._id,
          requestPayload: businessPartnerResult.requestPayload,
          responsePayload: businessPartnerResult.responsePayload,
        });
        await this.webhookReferenceRepository.persistReferences({
          WebhookEvent,
          eventId: event?._id,
          payload,
          companyExists,
          contactExists,
          cardCode,
        });
      }
```

to:

```js
      if (businessPartnerResult.created) {
        await this.webhookReferenceRepository.persistReferences({
          WebhookEvent,
          eventId: event?._id,
          payload,
          companyExists,
          contactExists,
          cardCode,
        });
      }
```

Change the success return and the start of the catch:

```js
      return {
        cardCode,
        docEntry: orderResponse?.DocEntry ?? null,
        docNum: orderResponse?.DocNum ?? null,
        dealId: toNonEmptyString(deal?.hs_object_id),
        payloadSap: orderPayload,
      };
    } catch (error) {
      error.sapOrderPayload = auditTrail.payload_SAP.order;
```

to:

```js
      return {
        cardCode,
        docEntry: orderResponse?.DocEntry ?? null,
        docNum: orderResponse?.DocNum ?? null,
        dealId: toNonEmptyString(deal?.hs_object_id),
        payloadSap: orderPayload,
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
      }

      error.sapOrderPayload = auditTrail.payload_SAP.order;
```

- [ ] **Step 4: Delete the now-dead `markBusinessPartnerCreated` method**

In `src/infrastructure/database/repositories/MongooseWebhookEventProgressRepository.js`, remove:

```js
  async markBusinessPartnerCreated({ WebhookEvent, eventId, requestPayload, responsePayload }) {
    if (!WebhookEvent || !eventId) {
      return;
    }

    await WebhookEvent.updateOne(
      { _id: eventId },
      {
        $set: {
          'payload.payloadBPSAP': requestPayload ?? null,
          'payload.responseBPSAP': responsePayload ?? null,
        },
      }
    );
  }

```

so the file becomes:

```js
export class MongooseWebhookEventProgressRepository {
  async markOrderCreated({ WebhookEvent, eventId, result }) {
    if (!WebhookEvent || !eventId) {
      return;
    }

    const updates = {
      status: 'sap_order_created',
      lastError: null,
      'payload.sapResult': {
        docEntry: result?.docEntry ?? null,
        docNum: result?.docNum ?? null,
        cardCode: result?.cardCode ?? null,
      },
      'payload.sapOrderCreatedAt': new Date().toISOString(),
    };

    if (result?.payloadSap) {
      updates['payload.payloadSAP'] = result.payloadSap;
    }

    await WebhookEvent.updateOne(
      { _id: eventId },
      {
        $set: updates,
      }
    );
  }
}

export default MongooseWebhookEventProgressRepository;
```

- [ ] **Step 5: Wire the composition**

In `src/composition/webhook-processing.composition.js`, change `buildProcessHubspotWebhookEventUseCase`:

```js
export function buildProcessHubspotWebhookEventUseCase() {
  return new ProcessHubspotWebhookEvent({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    webhookEventProgressRepository: new MongooseWebhookEventProgressRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}
```

to:

```js
export function buildProcessHubspotWebhookEventUseCase() {
  return new ProcessHubspotWebhookEvent({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    webhookEventProgressRepository: new MongooseWebhookEventProgressRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger,
  });
}
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/webhookProcessor.flow.test.js`
Expected: PASS — every test in this file (it's a large file; confirm the full file passes, not just the one test, since removing `markBusinessPartnerCreated` touches a shared code path).

- [ ] **Step 7: Commit**

```bash
git add src/application/use-cases/ProcessHubspotWebhookEvent.js src/infrastructure/database/repositories/MongooseWebhookEventProgressRepository.js src/composition/webhook-processing.composition.js tests/unit/webhookProcessor.flow.test.js
git commit -m "feat: attach sapAudit to ProcessHubspotWebhookEvent and retire markBusinessPartnerCreated"
```

---

### Task 8: Full suite verification and manual end-to-end check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest`
Expected: **6 failed suites / 108 total, 12 failed tests / 820 total minus whatever the new test files add** — specifically, the same 6 pre-existing failing suites as the Global Constraints baseline (`sendMappedItemsToHubspot`, `lineItemPriceWebhook.service`, `syncLineItemPrices`, `serviceLayerService`, `serviceLayerFlow`, `integration/internalTenant`), and every other suite — including the 2 new test files from Task 1 and Task 2 — passing. If any suite outside that list fails, treat it as a regression introduced by this plan and fix it before proceeding.

- [ ] **Step 2: Manual end-to-end check against a real tenant database**

This step needs a real MongoDB connection and SAP Service Layer credentials — run it in whatever environment already has `/sap-sync/runWebHook` working (per [docs/superpowers/specs/2026-08-06-webhook-sap-audit-design.md](../specs/2026-08-06-webhook-sap-audit-design.md)'s Verification section):

1. Queue a `createQuotation` webhook event that you know will fail in SAP (e.g. missing numbering series, as in the original bug report) and one that will succeed.
2. Call `POST /sap-sync/runWebHook` with `{"tenantID": "<tenant key>"}`.
3. Query both `WebhookEvent` documents in Mongo. Confirm both now have a `sapAudit` field with `payloadSap.quotation` populated with the request that was sent to SAP, and (for the successful one) `responseSap.quotation` populated with SAP's response.
4. Confirm the documents no longer have `payload.payloadSAP` written by this run (older documents from before this change may still have it — that's expected and fine, per the spec's "no migration" decision).

No commit for this step — it's a verification checkpoint, not a code change.
