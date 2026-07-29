# HubSpot Prefetch Index Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the company/contact sync from creating duplicates and bring a 9k-company run down to minutes, by loading every HubSpot record once into an in-memory index and matching against it instead of calling a lookup API per record.

**Architecture:** One paginated `GET /crm/v3/objects/{type}` sweep per object type builds a `CrmObjectIndex` (Maps keyed by identity and fallback property). All existence checks become in-memory lookups — the same shape as `readExistingProductsBySku`, which loads one Map and then diffs in memory. Matching is two-tier: `idsap` first, then the tenant's `defaultFindHubspot` property. Batch write payloads are sanitized against the portal's real property list before being sent.

**Tech Stack:** Node.js ESM, Jest (`@jest/globals`, DI stubs, no module mocking), axios (only inside `hubspotClient.js`), Mongoose tenant models.

## Evidence This Plan Is Built On (probed live against portal 50396297)

These are measured facts, not assumptions. Do not "fix" code in ways that contradict them.

1. **`batch/read` with a non-unique `idProperty` fails silently.** `POST /companies/batch/read {idProperty:"idsap"}` for a company that demonstrably exists returned **HTTP 200** with `results: []`, `numErrors: 1`, `category: "OBJECT_NOT_FOUND"`. It does **not** throw. The old code's `try/catch` fallback to Search therefore never ran, every record looked new, and the whole base was re-created. This is the root cause of the duplicates.
2. **`batch/create` does NOT preserve input order.** Inputs `[A, B]` came back as `[B, A]`. Positional matching (`results[index]`) is never sound and must not appear anywhere.
3. **`batch/create` DOES echo custom properties.** The response carried `idsap: "PROBE-AAA"`. Matching created records by the identity property is correct.
4. **The Search API is eventually consistent.** `search {idsap IN [...]}` returned `total: 0` for two companies created ~0.4s earlier. Search must not decide "exists or not".
5. **One invalid property rejects the entire batch** with HTTP 400 `PROPERTY_DOESNT_EXIST` — there is no partial success on create. A single bad property costs all 100 records.
6. **The list endpoint is fast and authoritative.** `GET /companies?limit=100&properties=idsap,...` returned custom properties in **208 ms/page**. ~57 pages for 5,691 companies ≈ 12 s.

## Global Constraints

- **Applies to B1 AND S/4.** No flavor-specific branches in the new code; flavor differences live only in field mappings and in the existing `_s4Contacts ?? ContactEmployees` selector.
- **Model usage:** all implementation tasks run with **Opus 5** (`model: "opus"` when dispatching subagents).
- **Tests:** run ONLY the touched test files: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/<file>`. Never bare `npx jest` and never a whole directory. Jest in this repo does not work without `NODE_OPTIONS=--experimental-vm-modules`.
- **Known baseline (not to be fixed here):** 3 tests in `tests/unit/application/sendMappedItemsToHubspot.test.js` fail before any of this work (an unrelated in-flight change commented out the `updateHubspotIdInSap` call). No task may add failures beyond those 3.
- **Hexagonal boundaries:** `src/application/**` must not import from `src/infrastructure/**` (enforced by `tests/unit/architecture/hexagonalBoundaries.test.js`). Infrastructure arrives by constructor DI or call parameters.
- **Identity properties:** main records (company, business-partner contact) → **`idsap`**. Company child contacts (contactEmployee) → **`internalcode`**. The tenant's `defaultFindHubspot` value is the **secondary** fallback, never the primary key.
- **HubSpot limits:** 100 inputs per batch write, waves of 4 (`BATCH_CONCURRENCY`), 429 retry through the shared `retryRequest`. List pagination is cursor-based and therefore sequential.
- **No positional matching anywhere**, including the existing product flow.
- **The gate is unchanged:** company/contact runs use the batch path only when `Number(clientConfig.hubspotBatchSize) > 1` and a processor is injected.
- **The working tree carries unrelated in-flight edits.** `git add` only the files each task names — never `git add -A` or `git add .`.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/infrastructure/hubspot/hubspotClient.js` | Modify | add `listAllObjects`, `listWritablePropertyNames`; delete `batchReadObjectsByProperty` + `searchObjectsByPropertyIn` |
| `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js` | Modify | expose the new functions, drop the removed ones |
| `src/application/services/crmObjectIndex.service.js` | Create | in-memory two-tier index + `normalizeIndexKey` |
| `src/application/services/hubspotPropertyPayload.service.js` | Create | `sanitizeProperties` (drop unknown/read-only keys and null values) |
| `src/application/use-cases/ProcessCrmObjectBatches.js` | Modify | index-based matching, no batch/read, no positional matching, sanitized payloads |
| `src/application/use-cases/SyncCompanyContactsInBatches.js` | Modify | same, with `internalcode` identity |
| `src/application/use-cases/SendMappedItemsToHubspot.js` | Modify | remove positional fallback in `finalizeCreatedProductBatch` |
| `src/application/services/defaultClientConfigMappings.service.js` | Modify | S/4 contactEmployee identity → `internalcode` |
| `src/composition/hubspot-sync.composition.js` | Modify | wire identity/fallback resolvers |
| `scripts/migrate-s4-contact-internalcode.mjs` | Create | one-off migration for existing S/4 tenants (run manually) |

---

### Task 1: List-all + property-catalog endpoints

**Files:**
- Modify: `src/infrastructure/hubspot/hubspotClient.js`
- Modify: `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js`
- Test: none direct (repo precedent: client functions are covered through use-case tests with injected stubs)

**Interfaces:**
- Produces:
  - `listAllObjects(token, objectType, properties = [], { pageLimit = 100, maxPages = 2000 } = {})` → `Array<{ id, properties }>` — walks `paging.next.after` until exhausted.
  - `listWritablePropertyNames(token, objectType)` → `Set<string>` of property names that can be written (excludes `readOnlyValue: true`).
  - `objectType` is `'company'` or `'contact'` (singular), mapped to the plural collection by the existing `crmCollection` helper.
- Removes: `batchReadObjectsByProperty`, `searchObjectsByPropertyIn` (proven unusable — evidence items 1 and 4).

- [ ] **Step 1: Add the two functions**

In `src/infrastructure/hubspot/hubspotClient.js`, delete `batchReadObjectsByProperty` and `searchObjectsByPropertyIn` entirely, and add in their place:

```js
// Loads every record of an object type, 100 per page, following the cursor.
// This is the authoritative read: unlike the Search API it hits the CRM
// directly, so records created moments earlier are already visible, and
// unlike batch/read with idProperty it works with non-unique properties.
export async function listAllObjects(token, objectType, properties = [], { pageLimit = 100, maxPages = 2000 } = {}) {
  const collection = crmCollection(objectType);
  const records = [];
  let after;
  let pages = 0;

  do {
    // eslint-disable-next-line no-await-in-loop
    const response = await hubspotGet(token, `/crm/v3/objects/${collection}`, {
      limit: pageLimit,
      ...(Array.isArray(properties) && properties.length > 0 ? { properties: properties.join(',') } : {}),
      ...(after ? { after } : {}),
    });

    records.push(...(response?.results ?? []));
    after = response?.paging?.next?.after;
    pages += 1;
  } while (after && pages < maxPages);

  return records;
}

// Writable property names for an object type. A single unknown or read-only
// property makes HubSpot reject an entire 100-record batch with 400
// PROPERTY_DOESNT_EXIST, so payloads are filtered against this set.
export async function listWritablePropertyNames(token, objectType) {
  const collection = crmCollection(objectType);
  const response = await hubspotGet(token, `/crm/v3/properties/${collection}`);

  return new Set(
    (response?.results ?? [])
      .filter((property) => property?.modificationMetadata?.readOnlyValue !== true)
      .map((property) => property?.name)
      .filter(Boolean)
  );
}
```

- [ ] **Step 2: Update the adapter**

Replace the contents of `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js` with:

```js
import {
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
} from './hubspotClient.js';

export const hubspotCrmBatchAdapter = Object.freeze({
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
});

export default hubspotCrmBatchAdapter;
```

- [ ] **Step 3: Verify nothing else referenced the removed functions**

Run: `npx grep -rn "batchReadObjectsByProperty\|searchObjectsByPropertyIn" src/ tests/` (or use ripgrep). Expected after Tasks 4-5: no hits in `src/`. At this point hits will remain in `ProcessCrmObjectBatches.js`, `SyncCompanyContactsInBatches.js` and their tests — that is expected and those are rewritten in Tasks 4 and 5. Note the hit list in your report; do not edit those files in this task.

- [ ] **Step 4: Sanity check**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/architecture/hexagonalBoundaries.test.js tests/unit/hubspotSyncAdapter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/hubspotClient.js src/infrastructure/hubspot/hubspot-crm-batch.adapter.js
git commit -m "feat: add list-all and property-catalog HubSpot reads, drop unusable batch read/search"
```

---

### Task 2: `CrmObjectIndex` service

**Files:**
- Create: `src/application/services/crmObjectIndex.service.js`
- Test: `tests/unit/application/crmObjectIndex.test.js` (new)

**Interfaces:**
- Produces:
  - `normalizeIndexKey(value)` → `string` (trim + lowercase; `''` for null/undefined)
  - `class CrmObjectIndex` — `new CrmObjectIndex({ records, identityProperty, fallbackProperty })`
    - `find(properties)` → record | `null`. Two-tier: identity property first, then fallback property. Never falls through to anything else.
    - `add(record)` — indexes a newly created record so later phases of the same run resolve it.
    - `get size()` → number of identity-keyed records.
  - First record wins on duplicate keys (matches the product flow's `!existingBySku.has(sku)` rule).

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/application/crmObjectIndex.test.js
import { CrmObjectIndex, normalizeIndexKey } from '../../../src/application/services/crmObjectIndex.service.js';

const records = [
  { id: 'hs-1', properties: { idsap: 'C001', email: 'a@x.com' } },
  { id: 'hs-2', properties: { idsap: ' C002 ', email: 'B@X.com' } },
  { id: 'hs-3', properties: { idsap: '', email: 'c@x.com' } },
  { id: 'hs-4', properties: { idsap: 'C001', email: 'dupe@x.com' } },
];

function buildIndex(overrides = {}) {
  return new CrmObjectIndex({ records, identityProperty: 'idsap', fallbackProperty: 'email', ...overrides });
}

describe('normalizeIndexKey', () => {
  it('trims and lowercases, and maps empty values to an empty string', () => {
    expect(normalizeIndexKey(' C001 ')).toBe('c001');
    expect(normalizeIndexKey('B@X.com')).toBe('b@x.com');
    expect(normalizeIndexKey(null)).toBe('');
    expect(normalizeIndexKey(undefined)).toBe('');
    expect(normalizeIndexKey(0)).toBe('0');
  });
});

describe('CrmObjectIndex', () => {
  it('matches by identity property regardless of case and padding', () => {
    const index = buildIndex();
    expect(index.find({ idsap: 'c001' })?.id).toBe('hs-1');
    expect(index.find({ idsap: 'C002' })?.id).toBe('hs-2');
  });

  it('keeps the first record when two share an identity value', () => {
    expect(buildIndex().find({ idsap: 'C001' })?.id).toBe('hs-1');
  });

  it('falls back to the secondary property only when identity does not match', () => {
    const index = buildIndex();
    // identity misses, fallback hits
    expect(index.find({ idsap: 'C999', email: 'c@x.com' })?.id).toBe('hs-3');
    // identity hits: fallback is not consulted even though it points elsewhere
    expect(index.find({ idsap: 'C001', email: 'c@x.com' })?.id).toBe('hs-1');
  });

  it('returns null when neither property matches', () => {
    expect(buildIndex().find({ idsap: 'C999', email: 'nope@x.com' })).toBeNull();
    expect(buildIndex().find({})).toBeNull();
  });

  it('ignores the fallback when it is the same property as identity', () => {
    const index = new CrmObjectIndex({ records, identityProperty: 'idsap', fallbackProperty: 'idsap' });
    expect(index.find({ idsap: 'C001' })?.id).toBe('hs-1');
    expect(index.find({ idsap: 'C999' })).toBeNull();
  });

  it('indexes records added after construction', () => {
    const index = buildIndex();
    expect(index.find({ idsap: 'C777' })).toBeNull();
    index.add({ id: 'hs-new', properties: { idsap: 'C777', email: 'new@x.com' } });
    expect(index.find({ idsap: 'C777' })?.id).toBe('hs-new');
    expect(index.find({ idsap: 'nope', email: 'new@x.com' })?.id).toBe('hs-new');
  });

  it('reports how many identity keys it holds', () => {
    expect(buildIndex().size).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/crmObjectIndex.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/application/services/crmObjectIndex.service.js

// HubSpot returns every property as a string. Keys are compared trimmed and
// lowercased so SAP padding/casing noise cannot cause a false "not found",
// which would create a duplicate record.
export function normalizeIndexKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// In-memory view of every HubSpot record of one object type, loaded once per
// run. Replaces per-record lookup calls: the Search API is eventually
// consistent and batch/read only works with unique properties, so neither can
// decide whether a record exists.
export class CrmObjectIndex {
  constructor({ records = [], identityProperty, fallbackProperty = null }) {
    this.identityProperty = identityProperty;
    // A fallback identical to the identity property adds nothing.
    this.fallbackProperty = fallbackProperty && fallbackProperty !== identityProperty
      ? fallbackProperty
      : null;
    this.byIdentity = new Map();
    this.byFallback = new Map();

    for (const record of records) {
      this.add(record);
    }
  }

  add(record) {
    const identity = normalizeIndexKey(record?.properties?.[this.identityProperty]);

    // First record wins, matching the product flow's existing dedupe rule.
    if (identity && !this.byIdentity.has(identity)) {
      this.byIdentity.set(identity, record);
    }

    if (this.fallbackProperty) {
      const fallback = normalizeIndexKey(record?.properties?.[this.fallbackProperty]);

      if (fallback && !this.byFallback.has(fallback)) {
        this.byFallback.set(fallback, record);
      }
    }
  }

  // idsap is the key between SAP and HubSpot; the tenant's configured
  // defaultFindHubspot property (email/cedula/phone) is only consulted when
  // the record carries no idsap match yet.
  find(properties) {
    const identity = normalizeIndexKey(properties?.[this.identityProperty]);

    if (identity) {
      const hit = this.byIdentity.get(identity);

      if (hit) {
        return hit;
      }
    }

    if (this.fallbackProperty) {
      const fallback = normalizeIndexKey(properties?.[this.fallbackProperty]);

      if (fallback) {
        return this.byFallback.get(fallback) ?? null;
      }
    }

    return null;
  }

  get size() {
    return this.byIdentity.size;
  }
}

export default CrmObjectIndex;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/crmObjectIndex.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/application/services/crmObjectIndex.service.js tests/unit/application/crmObjectIndex.test.js
git commit -m "feat: add in-memory CRM object index with two-tier matching"
```

---

### Task 3: Payload sanitizer

**Files:**
- Create: `src/application/services/hubspotPropertyPayload.service.js`
- Test: `tests/unit/application/hubspotPropertyPayload.test.js` (new)

**Interfaces:**
- Produces: `sanitizeProperties(properties, allowedNames = null)` → new object containing only entries whose key is in `allowedNames` (when provided) and whose value is neither `null` nor `undefined`. Never mutates its input.
- Rationale: `mapFields` writes `null` for every unresolved mapping, and a single unknown property makes HubSpot reject all 100 records of a batch with 400.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/application/hubspotPropertyPayload.test.js
import { sanitizeProperties } from '../../../src/application/services/hubspotPropertyPayload.service.js';

describe('sanitizeProperties', () => {
  it('drops properties the portal does not accept', () => {
    const allowed = new Set(['name', 'idsap']);
    expect(sanitizeProperties({ name: 'Acme', idsap: 'C001', inventada: 'x' }, allowed))
      .toEqual({ name: 'Acme', idsap: 'C001' });
  });

  it('drops null and undefined values that unresolved mappings produce', () => {
    const allowed = new Set(['name', 'idsap', 'email']);
    expect(sanitizeProperties({ name: 'Acme', idsap: null, email: undefined }, allowed))
      .toEqual({ name: 'Acme' });
  });

  it('keeps empty strings and zero, which are real values', () => {
    const allowed = new Set(['email', 'quantity']);
    expect(sanitizeProperties({ email: '', quantity: 0 }, allowed))
      .toEqual({ email: '', quantity: 0 });
  });

  it('keeps every non-null property when no allow list is given', () => {
    expect(sanitizeProperties({ a: 1, b: null, c: 'x' }))
      .toEqual({ a: 1, c: 'x' });
  });

  it('does not mutate the input and tolerates missing input', () => {
    const input = { name: 'Acme', bad: null };
    sanitizeProperties(input, new Set(['name']));
    expect(input).toEqual({ name: 'Acme', bad: null });
    expect(sanitizeProperties(null)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/hubspotPropertyPayload.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/application/services/hubspotPropertyPayload.service.js

// HubSpot rejects an entire batch (400 PROPERTY_DOESNT_EXIST) when a single
// input carries a property the portal does not have or cannot write, so one
// stale mapping would cost all 100 records of a chunk. Unresolved mappings
// also arrive as null, which is noise on create.
export function sanitizeProperties(properties, allowedNames = null) {
  const sanitized = {};

  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value === null || value === undefined) {
      continue;
    }

    if (allowedNames && !allowedNames.has(key)) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export default { sanitizeProperties };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/hubspotPropertyPayload.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/application/services/hubspotPropertyPayload.service.js tests/unit/application/hubspotPropertyPayload.test.js
git commit -m "feat: add HubSpot property payload sanitizer"
```

---

### Task 4: Rewire `ProcessCrmObjectBatches` onto the index

**Files:**
- Modify: `src/application/use-cases/ProcessCrmObjectBatches.js`
- Test: `tests/unit/application/processCrmObjectBatches.test.js` (rewrite the read/create expectations)

**Interfaces:**
- Consumes: `CrmObjectIndex`, `normalizeIndexKey` (Task 2); `sanitizeProperties` (Task 3); `crmBatchClient.listAllObjects` / `listWritablePropertyNames` (Task 1); the existing `batchCreateObjects`, `batchUpdateObjects`, `batchAssociateDefault`, `associateObjects`.
- Produces: `execute({ mappedItems, objectType, clientConfig, tenantModels, handler, getToken, mainDataInUpdate, bypassEmail, preprocessContext, syncLogId, sequentialFallback })` → `{ ok: true, sent, failed, created, updated, skipped, errors }` — unchanged shape.
- Constructor gains `identityProperty = 'idsap'` and keeps `findPropertyResolver` (now the **fallback** resolver).

**Binding behavior changes:**
- `readExisting` is deleted. `buildIndex` replaces it: one `listAllObjects` sweep requesting the identity property, the fallback property and the handler's search properties.
- If the index sweep throws, the whole run degrades to `sequentialFallback` (unchanged degradation contract).
- Items are matched with `index.find(item.properties)` — identity first, fallback second.
- The `withValue` / `withoutValue` split is gone: **an item is never created without first being looked up**.
- Items are deduped by identity within the run before creating, so two SAP rows with the same `idsap` cannot create two records.
- Created records are matched **only** by the identity property echoed in the response, never positionally, and are added back into the index.
- Every create/update payload passes through `sanitizeProperties` with the portal's writable property names.

- [ ] **Step 1: Write the failing tests**

Replace the read-related tests in `tests/unit/application/processCrmObjectBatches.test.js`. The stub client changes from `batchReadObjectsByProperty`/`searchObjectsByPropertyIn` to `listAllObjects`/`listWritablePropertyNames`; keep every other existing test in the file working with the new stub.

```js
// tests/unit/application/processCrmObjectBatches.test.js — new/changed cases
  it('matches existing records from the prefetched index without any lookup call', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([
      { id: 'hs-1', properties: { idsap: 'C001', name: 'A' } },
    ]);
    const params = baseParams();
    params.handler.buildBatchUpdateEntry.mockReturnValue(null);

    const result = await useCase.execute({
      mappedItems: [{ properties: { idsap: 'C001', email: 'a@x.com', name: 'A' }, rawSapData: {} }],
      ...params,
    });

    expect(useCase.crmBatchClient.listAllObjects).toHaveBeenCalledTimes(1);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 1, created: 0, skipped: 1 });
  });

  it('falls back to the configured find property when idsap does not match', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([
      { id: 'hs-9', properties: { idsap: 'OTRO', email: 'a@x.com' } },
    ]);
    const params = baseParams();
    params.handler.buildBatchUpdateEntry.mockReturnValue({ id: 'hs-9', properties: { idsap: 'C001' } });

    const result = await useCase.execute({
      mappedItems: [{ properties: { idsap: 'C001', email: 'a@x.com' }, rawSapData: {} }],
      ...params,
    });

    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchUpdateObjects).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: 1, updated: 1, created: 0 });
  });

  it('matches created records by identity property, never by position', async () => {
    const useCase = buildUseCase();
    // HubSpot returns results in a different order than the inputs.
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [
        { id: 'hs-B', properties: { idsap: 'C002' } },
        { id: 'hs-A', properties: { idsap: 'C001' } },
      ],
    });
    const params = baseParams();

    await useCase.execute({
      mappedItems: [
        { properties: { idsap: 'C001', email: 'a@x.com' }, rawSapData: {} },
        { properties: { idsap: 'C002', email: 'b@x.com' }, rawSapData: {} },
      ],
      ...params,
    });

    const [, , mappings] = useCase.associationRegistry.registerBaseObjectMappings.mock.calls[0];
    expect(mappings).toEqual(expect.arrayContaining([
      { sapId: 'C001', hubspotId: 'hs-A' },
      { sapId: 'C002', hubspotId: 'hs-B' },
    ]));
  });

  it('creates one record when two SAP rows share an identity value', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [{ id: 'hs-1', properties: { idsap: 'C001' } }],
    });
    const params = baseParams();

    await useCase.execute({
      mappedItems: [
        { properties: { idsap: 'C001', email: 'a@x.com' }, rawSapData: {} },
        { properties: { idsap: 'C001', email: 'dupe@x.com' }, rawSapData: {} },
      ],
      ...params,
    });

    const inputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(inputs).toHaveLength(1);
  });

  it('strips properties the portal does not accept before sending', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listWritablePropertyNames.mockResolvedValue(new Set(['idsap', 'email', 'name']));
    const params = baseParams();

    await useCase.execute({
      mappedItems: [{ properties: { idsap: 'C001', email: 'a@x.com', propiedad_inventada: 'x', vacia: null }, rawSapData: {} }],
      ...params,
    });

    const inputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(inputs[0].properties).toEqual({ idsap: 'C001', email: 'a@x.com' });
  });

  it('degrades the whole run to sequential when the index sweep fails', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockRejectedValue(new Error('list down'));
    const params = baseParams();
    params.sequentialFallback.mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0, errors: [] });

    const result = await useCase.execute({
      mappedItems: [{ properties: { idsap: 'C001', email: 'a@x.com' }, rawSapData: {} }],
      ...params,
    });

    expect(params.sequentialFallback).toHaveBeenCalledTimes(1);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 1, created: 1 });
  });
```

Update `buildUseCase`'s stub client to:

```js
    crmBatchClient: {
      listAllObjects: jest.fn().mockResolvedValue([]),
      listWritablePropertyNames: jest.fn().mockResolvedValue(null),
      batchCreateObjects: jest.fn().mockImplementation(async (_t, _o, { inputs }) => ({
        results: inputs.map((input, index) => ({ id: `hs-${index}`, properties: { ...input.properties } })),
      })),
      batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
      batchAssociateDefault: jest.fn().mockResolvedValue({}),
      associateObjects: jest.fn().mockResolvedValue({}),
    },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processCrmObjectBatches.test.js`
Expected: FAIL — `listAllObjects is not a function` / matching assertions unmet.

- [ ] **Step 3: Implement**

In `src/application/use-cases/ProcessCrmObjectBatches.js`:

Replace the `normalizeKey` helper with the shared one and add the new imports:

```js
import { CrmObjectIndex, normalizeIndexKey } from '#application/services/crmObjectIndex.service.js';
import { sanitizeProperties } from '#application/services/hubspotPropertyPayload.service.js';
```

Delete the local `normalizeKey` function and replace every use of `normalizeKey(` with `normalizeIndexKey(`. Delete `readExisting` and `SEARCH_FALLBACK_CONCURRENCY` from the imports if it becomes unused.

Add `identityProperty = 'idsap'` to the constructor options and store it as `this.identityProperty`.

Add the index builder:

```js
  // One sweep of the whole object type, indexed in memory. This is what makes
  // the run fast: every later existence check is a Map lookup instead of an
  // API call. See the plan's evidence section for why batch/read and Search
  // cannot do this job.
  async buildIndex({ objectType, fallbackProperty, clientConfig, tenantModels, handler, getToken }) {
    const searchProperties = await handler.getSearchProperties({ clientConfig, tenantModels });
    const properties = [...new Set([
      this.identityProperty,
      fallbackProperty,
      ...searchProperties,
    ].filter(Boolean))].filter((name) => name !== 'hs_object_id' && name !== 'associations');

    const token = await getToken();
    const records = await this.retry(() =>
      this.crmBatchClient.listAllObjects(token, objectType, properties)
    );

    this.logger.info?.(`CRM index built for ${objectType}: ${records.length} records`);

    return new CrmObjectIndex({
      records,
      identityProperty: this.identityProperty,
      fallbackProperty,
    });
  }
```

Replace the block from `const findProperty = await this.findPropertyResolver(...)` through the end of the `for (const item of withValue)` loop with:

```js
    const fallbackProperty = await this.findPropertyResolver({ tenantModels });

    let index;
    let writableProperties = null;
    try {
      index = await this.buildIndex({
        objectType,
        fallbackProperty,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });

      const token = await getToken();
      writableProperties = await this.retry(() =>
        this.crmBatchClient.listWritablePropertyNames(token, objectType)
      );
    } catch (error) {
      // Without the index we cannot tell creates from updates, and guessing
      // would duplicate the whole base: fall back to the per-item path.
      this.logger.error?.('ProcessCrmObjectBatches index error:', error);
      const fallbackResult = await sequentialFallback(syncable);
      this.mergeStats(stats, fallbackResult);
      return { ok: true, ...stats };
    }

    const createEntries = [];
    const updateEntries = [];
    const sapModeEntries = [];
    const processed = [];
    // Two SAP rows carrying the same identity must not create two records.
    const claimedIdentities = new Set();

    for (const item of syncable) {
      const existing = index.find(item?.properties);

      if (!existing) {
        const identity = normalizeIndexKey(item?.properties?.[this.identityProperty]);

        if (identity && claimedIdentities.has(identity)) {
          stats.sent += 1;
          stats.skipped += 1;
          continue;
        }
        if (identity) {
          claimedIdentities.add(identity);
        }

        createEntries.push({ item });
        continue;
      }

      processed.push({ item, hubspotId: existing.id });

      if (shouldUpdateSapFromHubspot({ mainDataInUpdate, objectType })) {
        sapModeEntries.push({ item, existing });
      } else if (normalizeMainDataInUpdate(mainDataInUpdate) === MAIN_DATA_IN_UPDATE.HUBSPOT) {
        const updateInput = handler.buildBatchUpdateEntry({ existing, item });

        if (updateInput) {
          updateEntries.push({ item, updateInput });
        } else {
          stats.sent += 1;
          stats.skipped += 1;
        }
      } else {
        stats.sent += 1;
      }
    }
```

Rewrite the create wave's body (keep `runInWaves`, `chunkArray`, `this.writeChunkSize(clientConfig)` and the `catch` → `sequentialFallback(chunkItems)` exactly as they are) so it sanitizes and matches by identity only:

```js
        try {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchCreateObjects(token, objectType, {
              inputs: chunkItems.map((item) => ({
                properties: sanitizeProperties(item.properties, writableProperties),
              })),
            })
          );

          const results = Array.isArray(response?.results) ? response.results : [];
          // HubSpot does not preserve input order in batch/create responses,
          // so the identity property echoed back is the only sound match.
          const resultByIdentity = new Map();
          for (const result of results) {
            const key = normalizeIndexKey(result?.properties?.[this.identityProperty]);
            if (key && !resultByIdentity.has(key)) {
              resultByIdentity.set(key, result);
            }
          }

          const mappings = [];
          let unmatched = 0;

          for (const item of chunkItems) {
            const created = resultByIdentity.get(
              normalizeIndexKey(item?.properties?.[this.identityProperty])
            );

            if (!created?.id) {
              unmatched += 1;
              continue;
            }

            index.add(created);
            processed.push({ item, hubspotId: created.id });
            const sapId = getSapId(item);
            if (sapId) {
              mappings.push({ sapId, hubspotId: created.id });
            }
          }

          if (mappings.length > 0) {
            await this.associationRegistry.registerBaseObjectMappings(
              clientConfig.hubspotCredentialId,
              objectType,
              mappings,
              tenantModels
            );
          }

          if (unmatched > 0) {
            this.logger.warn?.(`Batch create: ${unmatched} record(s) could not be matched back by ${this.identityProperty}`);
          }

          return { sent: results.length, created: results.length, failed: chunkItems.length - results.length };
        } catch (error) {
          this.logger.error?.('ProcessCrmObjectBatches create error:', error);
          return sequentialFallback(chunkItems);
        }
```

In the update wave, sanitize too:

```js
            this.crmBatchClient.batchUpdateObjects(token, objectType, {
              inputs: entryChunk.map(({ updateInput }) => ({
                id: updateInput.id,
                properties: sanitizeProperties(updateInput.properties, writableProperties),
              })),
            })
```

Delete `summarizeBatchResponse` usage from this file if it is no longer referenced (create is all-or-nothing per the evidence section); leave the helper in `hubspotBatching.utils.js` for the association sites that still use it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processCrmObjectBatches.test.js tests/unit/architecture/hexagonalBoundaries.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/use-cases/ProcessCrmObjectBatches.js tests/unit/application/processCrmObjectBatches.test.js
git commit -m "fix: match companies and contacts against a prefetched in-memory index"
```

---

### Task 5: Rewire `SyncCompanyContactsInBatches` with `internalcode` identity

**Files:**
- Modify: `src/application/use-cases/SyncCompanyContactsInBatches.js`
- Test: `tests/unit/application/syncCompanyContactsInBatches.test.js`

**Interfaces:**
- Consumes: everything from Task 4 plus the constructor option `identityProperty = 'internalcode'`.
- Produces: `execute({ companies, clientConfig, tenantModels, getToken, syncLogId })` → `{ contactErrors }` — unchanged shape, still never rejects.

**Binding behavior changes:**
- Child contacts are identified by **`internalcode`**, with the tenant's `defaultFindHubspot` value as the fallback tier — the tenant-wide property is no longer the primary key.
- `readExistingContacts` is deleted; a `CrmObjectIndex` over all contacts replaces it.
- Dedupe, create-result matching and payload sanitizing follow the same rules as Task 4.
- Existing contract preserved: mappings fetched once, `mapRecords` called once, `contactEmailMissingSkipped` warnings, per-contact fallback on chunk failure, per-pair fallback on association failure, `sapIdsByKey` twin registration, and an empty `mapRecords` result still syncs nothing.

- [ ] **Step 1: Write the failing tests**

Update the stub client in `buildUseCase` exactly as in Task 4 (`listAllObjects`, `listWritablePropertyNames`; remove `batchReadObjectsByProperty` and `searchObjectsByPropertyIn`), then add:

```js
  it('identifies child contacts by internalcode, not by the tenant find property', async () => {
    const useCase = buildUseCase();
    useCase.findPropertyResolver.mockResolvedValue('email');
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-7' } },
    ]);
    useCase.crmBatchClient.listAllObjects.mockResolvedValue([
      { id: 'hs-c-existing', properties: { internalcode: 'IC-7', email: 'otro@x.com' } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 7, E_Mail: 'ana@x.com' }] } },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toEqual([{ fromId: 'hs-co-1', toId: 'hs-c-existing' }]);
  });

  it('matches created child contacts by internalcode regardless of response order', async () => {
    const useCase = buildUseCase();
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-1' } },
      { properties: { firstname: 'Luis', internalcode: 'IC-2' } },
    ]);
    useCase.crmBatchClient.batchCreateObjects.mockResolvedValue({
      results: [
        { id: 'hs-luis', properties: { internalcode: 'IC-2' } },
        { id: 'hs-ana', properties: { internalcode: 'IC-1' } },
      ],
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'ana@x.com' },
            { InternalCode: 2, E_Mail: 'luis@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    const [, , mappings] = useCase.associationRegistry.registerBaseObjectMappings.mock.calls[0];
    expect(mappings).toEqual(expect.arrayContaining([
      { sapId: 1, hubspotId: 'hs-ana' },
      { sapId: 2, hubspotId: 'hs-luis' },
    ]));
  });

  it('returns a single contactError when the contact index cannot be built', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.listAllObjects.mockRejectedValue(new Error('list down'));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toHaveLength(1);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncCompanyContactsInBatches.test.js`
Expected: FAIL — `listAllObjects is not a function`.

- [ ] **Step 3: Implement**

In `src/application/use-cases/SyncCompanyContactsInBatches.js`:

- Import `CrmObjectIndex`, `normalizeIndexKey` and `sanitizeProperties` as in Task 4; delete the local `normalizeKey` and replace its uses.
- Add `identityProperty = 'internalcode'` to the constructor options, stored as `this.identityProperty`.
- Delete `readExistingContacts` and the `rawValueByKey` map (the index needs no wire values).
- In `execute`, replace the dedupe/read block with:

```js
    const fallbackProperty = await this.findPropertyResolver({ tenantModels });

    let index;
    let writableProperties = null;
    try {
      const searchProperties = await this.contactHandler.getSearchProperties({ clientConfig, tenantModels });
      const properties = [...new Set([
        this.identityProperty,
        fallbackProperty,
        ...searchProperties,
      ].filter(Boolean))].filter((name) => name !== 'hs_object_id' && name !== 'associations');

      const token = await getToken();
      const records = await this.retry(() =>
        this.crmBatchClient.listAllObjects(token, 'contact', properties)
      );
      index = new CrmObjectIndex({
        records,
        identityProperty: this.identityProperty,
        fallbackProperty,
      });
      writableProperties = await this.retry(() =>
        this.crmBatchClient.listWritablePropertyNames(token, 'contact')
      );
    } catch (readError) {
      // Without the index we cannot tell creates from updates; creating blindly
      // would duplicate the contact base.
      this.logger.error?.('Company contact batch sync error:', readError);
      contactErrors.push(buildContactErrorEntry({ error: readError }));
      return { contactErrors };
    }

    // Entries sharing an identity collapse into one write; every company still
    // gets its association pair, and every twin SAP id is still registered.
    const byKey = new Map();
    const sapIdsByKey = new Map();
    for (const entry of entries) {
      const key = normalizeIndexKey(entry.contactPayload?.properties?.[this.identityProperty]);
      entry.key = key;

      if (key) {
        if (!byKey.has(key)) {
          byKey.set(key, entry);
        }
        if (entry.sapInternalCode) {
          if (!sapIdsByKey.has(key)) {
            sapIdsByKey.set(key, new Set());
          }
          sapIdsByKey.get(key).add(entry.sapInternalCode);
        }
      } else {
        entry.alwaysCreate = true;
      }
    }
    const uniqueEntries = [...byKey.values(), ...entries.filter((entry) => entry.alwaysCreate)];

    const createEntries = [];
    const updateEntries = [];
    const hubspotIdByKey = new Map();

    for (const entry of uniqueEntries) {
      const existing = index.find(entry.contactPayload?.properties);

      if (!existing) {
        createEntries.push(entry);
        continue;
      }

      if (entry.key) {
        hubspotIdByKey.set(entry.key, existing.id);
      } else {
        entry.hubspotId = existing.id;
      }

      const updateInput = this.contactHandler.buildBatchUpdateEntry({ existing, item: entry.contactPayload });

      if (updateInput) {
        updateEntries.push({ entry, updateInput });
      }
    }
```

- Pass `index`, `writableProperties` and `sapIdsByKey` into `createContactBatches`; inside it, sanitize the inputs, match results by `this.identityProperty` only (drop the positional fallback and the `positionalSafe` guard entirely), and `index.add(created)` for each match. Keep the existing `seenMappings` dedupe and the `sequentialContactFallback` catch untouched.
- Sanitize the update inputs the same way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/syncCompanyContactsInBatches.test.js tests/unit/architecture/hexagonalBoundaries.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/use-cases/SyncCompanyContactsInBatches.js tests/unit/application/syncCompanyContactsInBatches.test.js
git commit -m "fix: identify company child contacts by internalcode against a prefetched index"
```

---

### Task 6: Remove positional matching from the product flow

**Files:**
- Modify: `src/application/use-cases/SendMappedItemsToHubspot.js` (`finalizeCreatedProductBatch`)
- Test: `tests/unit/application/sendMappedItemsToHubspot.test.js`

**Interfaces:**
- Produces: `finalizeCreatedProductBatch` matches created products **only** by `hs_sku`; unmatched results are logged and skipped instead of being paired with `createdItems[index]`.
- Rationale: evidence item 2 — HubSpot returned `[B, A]` for inputs `[A, B]`. The current `?? createdItems[index]` fallback can write another product's HubSpot id into SAP and into the registry.

- [ ] **Step 1: Write the failing test**

```js
  it('does not pair a created product with another product by position', async () => {
    const sapHubspotIdUpdater = {
      updateHubspotIdInSap: jest.fn().mockResolvedValue(null),
      updateBusinessPartnerInSapFromHubspot: jest.fn().mockResolvedValue(null),
    };
    const associationRegistry = { registerBaseObjectMapping: jest.fn().mockResolvedValue(null) };
    const useCase = buildUseCase({ sapHubspotIdUpdater, associationRegistry });

    await useCase.finalizeCreatedProductBatch({
      // Response carries no hs_sku for the second entry: it must not be
      // attributed to createdItems[1].
      createdResults: [
        { id: 'hs-2', properties: { hs_sku: 'SKU-2' } },
        { id: 'hs-x', properties: {} },
      ],
      createdItems: [
        { properties: { hs_sku: 'SKU-1', idsap: 'P1' } },
        { properties: { hs_sku: 'SKU-2', idsap: 'P2' } },
      ],
      clientConfig: { hubspotCredentialId: 'cred-1' },
      tenantModels: {},
    });

    expect(sapHubspotIdUpdater.updateHubspotIdInSap).toHaveBeenCalledTimes(1);
    expect(sapHubspotIdUpdater.updateHubspotIdInSap).toHaveBeenCalledWith(
      expect.objectContaining({ hubspotId: 'hs-2', sapRecord: { hs_sku: 'SKU-2', idsap: 'P2' } })
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/sendMappedItemsToHubspot.test.js -t "by position"`
Expected: FAIL — the positional fallback attributes `hs-x` to `SKU-1`.

- [ ] **Step 3: Implement**

Replace the loop body in `finalizeCreatedProductBatch`:

```js
    for (const created of createdResults) {
      // HubSpot does not preserve input order in batch/create responses, so
      // hs_sku echoed in the result is the only sound way to attribute an id.
      const item = itemsBySku.get(created?.properties?.hs_sku);

      if (!item || !created?.id) {
        this.logger?.warn?.('Batch create: product result without a matching hs_sku', {
          hubspotId: created?.id ?? null,
        });
        continue;
      }

      await this.sapHubspotIdUpdater.updateHubspotIdInSap({
        clientConfig,
        objectType: 'product',
        sapRecord: item?.properties ?? {},
        hubspotId: created.id,
        tenantModels,
      });

      await this.registerBaseMapping(
        clientConfig,
        'product',
        getSapIdForRegistry('product', item),
        created.id,
        tenantModels
      );
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/sendMappedItemsToHubspot.test.js`
Expected: the new test PASSES; the 3 documented baseline failures remain, nothing else fails. Report the before/after counts.

- [ ] **Step 5: Commit**

```bash
git add src/application/use-cases/SendMappedItemsToHubspot.js tests/unit/application/sendMappedItemsToHubspot.test.js
git commit -m "fix: attribute created products by hs_sku only, never by response position"
```

---

### Task 7: S/4 contactEmployee identity seed + tenant migration script

**Files:**
- Modify: `src/application/services/defaultClientConfigMappings.service.js`
- Create: `scripts/migrate-s4-contact-internalcode.mjs`
- Test: `tests/unit/application/defaultMappingsByFlavor.test.js`

**Interfaces:**
- Produces: S/4 `contactEmployee` mappings identify the contact person by **`internalcode`** (`BusinessPartner → internalcode`), matching B1's `InternalCode → internalcode`. The `sourceField` stays unique per `(objectType, sourceContext)`, as the file's own note requires — this is a **replacement** of the `BusinessPartner → idsap` row, not an addition.
- The migration script updates already-provisioned S/4 tenants; it is **run manually by the maintainer**, never automatically.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/application/defaultMappingsByFlavor.test.js` (match the file's existing import/assertion style):

```js
  it('identifies S/4 company contacts by internalcode, like B1 does', () => {
    const s4ContactMappings = buildDefaultMappings({ objectType: 'contact', sapFlavor: 'S4' });
    const identity = s4ContactMappings.filter((m) => m.sourceContext === 'contactEmployee' && m.targetField === 'internalcode');

    expect(identity).toHaveLength(1);
    expect(identity[0].sourceField).toBe('BusinessPartner');
    expect(s4ContactMappings.some((m) => m.sourceContext === 'contactEmployee' && m.targetField === 'idsap')).toBe(false);
  });
```

If the file's helper is not named `buildDefaultMappings`, use whatever export it already exercises for the S/4 contact list — read the file first and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/defaultMappingsByFlavor.test.js`
Expected: FAIL — the mapping still targets `idsap`.

- [ ] **Step 3: Change the seed**

In `src/application/services/defaultClientConfigMappings.service.js`, in `DEFAULT_S4_CONTACT_MAPPINGS`, change the first entry:

```js
const DEFAULT_S4_CONTACT_MAPPINGS = [
  // The contact person is its own BusinessPartner in S/4. It is the contact's
  // internal code, not the customer's idsap: idsap identifies the company a
  // contact belongs to, and reusing it here would collide with company ids.
  { sourceField: 'BusinessPartner', targetField: 'internalcode', sourceContext: 'contactEmployee' },
  { sourceField: 'FirstName', targetField: 'firstname', sourceContext: 'contactEmployee' },
  { sourceField: 'LastName', targetField: 'lastname', sourceContext: 'contactEmployee' },
  { sourceField: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress', targetField: 'email', sourceContext: 'contactEmployee' },
  { sourceField: 'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber', targetField: 'phone', sourceContext: 'contactEmployee' },
];
```

- [ ] **Step 4: Write the migration script**

```js
// scripts/migrate-s4-contact-internalcode.mjs
// One-off migration for S/4 tenants provisioned before the contactEmployee
// identity moved from idsap to internalcode. Run manually, one tenant at a
// time:  node scripts/migrate-s4-contact-internalcode.mjs <tenantDbName>
// Pass --apply to write; without it the script only reports what it would do.
import { MongoClient } from 'mongodb';

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';

if (!tenantDb) {
  console.error('Usage: node scripts/migrate-s4-contact-internalcode.mjs <tenantDbName> [--apply]');
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();

try {
  const mappings = client.db(tenantDb).collection('FieldMappings');
  const filter = {
    objectType: 'contact',
    sourceContext: 'contactEmployee',
    sourceField: 'BusinessPartner',
    targetField: 'idsap',
  };

  const affected = await mappings.find(filter).toArray();
  console.log(`${tenantDb}: ${affected.length} contactEmployee mapping(s) would change idsap -> internalcode`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write.');
  } else {
    const result = await mappings.updateMany(filter, { $set: { targetField: 'internalcode' } });
    console.log(`Updated ${result.modifiedCount} mapping(s).`);
  }
} finally {
  await client.close();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/defaultMappingsByFlavor.test.js`
Expected: PASS.

Then verify the script's dry run does not write:

```bash
node scripts/migrate-s4-contact-internalcode.mjs sap_integration_multiquimica
```
Expected: reports 1 mapping, states "Dry run".

- [ ] **Step 6: Commit**

```bash
git add src/application/services/defaultClientConfigMappings.service.js scripts/migrate-s4-contact-internalcode.mjs tests/unit/application/defaultMappingsByFlavor.test.js
git commit -m "fix: identify S/4 company contacts by internalcode and add tenant migration"
```

---

### Task 8: Composition wiring and whole-flow verification

**Files:**
- Modify: `src/composition/hubspot-sync.composition.js`
- Test: `tests/unit/composition/hubspotSyncComposition.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `ProcessCrmObjectBatches` receives `identityProperty: 'idsap'`; `SyncCompanyContactsInBatches` receives `identityProperty: 'internalcode'`; both keep `findPropertyResolver` as the **fallback** resolver (`getConfiguredFindProperty`).

- [ ] **Step 1: Wire the identities**

In `buildSendMappedItemsToHubspot()`, add `identityProperty` to both constructions:

```js
  const syncCompanyContactsInBatches = new SyncCompanyContactsInBatches({
    crmBatchClient: hubspotCrmBatchAdapter,
    contactHandler,
    associationRegistry: associationRegistryService,
    fieldMappingService: new FieldMappingService({
      fieldMappingRepository: new TenantFieldMappingRepository(),
    }),
    fallbackEmailGenerator: generateFallbackEmail,
    // Company child contacts are keyed by their own SAP internal code; the
    // tenant's defaultFindHubspot property is only the second tier.
    identityProperty: 'internalcode',
    findPropertyResolver,
    bypassEmailConfigRepository: new BypassEmailConfigRepository(),
    syncWarningRepository: new MongooseSyncWarningRepository(),
    logger,
  });

  const crmBatchProcessor = new ProcessCrmObjectBatches({
    crmBatchClient: hubspotCrmBatchAdapter,
    associationRegistry: associationRegistryService,
    sapHubspotIdUpdater: sapSyncAdapter,
    validationFailureWriter,
    // idsap is the key between SAP and HubSpot for main records.
    identityProperty: 'idsap',
    findPropertyResolver,
    fetchFallbackAssociations: ({ clientConfig, objectType }) =>
      handleHubspotAssociations.fetchAssociationsIfNeeded(clientConfig, objectType),
    syncCompanyContactsInBatches,
    syncWarningRepository: new MongooseSyncWarningRepository(),
    logger,
  });
```

- [ ] **Step 2: Extend the composition smoke test**

```js
  it('wires the identity properties for main records and child contacts', async () => {
    const { buildSendMappedItemsToHubspot } = await import('../../../src/composition/hubspot-sync.composition.js');
    const useCase = buildSendMappedItemsToHubspot();

    expect(useCase.crmBatchProcessor.identityProperty).toBe('idsap');
    expect(useCase.crmBatchProcessor.syncCompanyContactsInBatches.identityProperty).toBe('internalcode');
  });
```

- [ ] **Step 3: Run the full touched set**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/crmObjectIndex.test.js tests/unit/application/hubspotPropertyPayload.test.js tests/unit/application/processCrmObjectBatches.test.js tests/unit/application/syncCompanyContactsInBatches.test.js tests/unit/application/sendMappedItemsToHubspot.test.js tests/unit/application/sendMappedItemsToHubspot.emailBypass.test.js tests/unit/application/defaultMappingsByFlavor.test.js tests/unit/application/syncCompanyContactsS4.test.js tests/unit/application/handleHubspotAssociations.emailBypass.test.js tests/unit/composition/hubspotSyncComposition.test.js tests/unit/composition/sapSyncComposition.test.js tests/unit/architecture/hexagonalBoundaries.test.js tests/unit/hubspotSyncAdapter.test.js tests/unit/companyHandler.test.js tests/unit/contactHandler.test.js tests/unit/product.handler.test.js
```

Expected: all pass except the 3 documented baseline failures in `sendMappedItemsToHubspot.test.js`. Report exact counts.

- [ ] **Step 4: Commit**

```bash
git add src/composition/hubspot-sync.composition.js tests/unit/composition/hubspotSyncComposition.test.js
git commit -m "feat: wire identity properties for CRM batch matching"
```

---

## Post-merge Runbook (maintainer, not an implementation task)

1. Migrate the S/4 tenant's contact identity mapping:
   ```bash
   node scripts/migrate-s4-contact-internalcode.mjs sap_integration_multiquimica --apply
   ```
2. Backfill the contacts already in HubSpot, which still carry the value in `idsap` with `internalcode` empty. Without this the identity tier misses forever: email resolves them and `resolveSapIdentifier` reads `idsap ?? idSap ?? internalcode` on both sides, so the values compare equal, no update is emitted and `internalcode` is never written.
   ```bash
   node --env-file=.env scripts/backfill-hubspot-contact-internalcode.mjs sap_integration_multiquimica          # dry run
   node --env-file=.env scripts/backfill-hubspot-contact-internalcode.mjs sap_integration_multiquimica --apply
   ```
3. **Measure the portal's contact count before the first run.** `SyncCompanyContactsInBatches` sweeps EVERY contact in the portal on every company run, and `listAllObjects` throws past `maxPages = 2000` (~200,000 contacts) rather than returning a partial index — which aborts child-contact sync entirely with one generic error. If the count approaches 200,000, raise `maxPages` in `src/infrastructure/hubspot/hubspotClient.js` **and re-measure the sweep time**: at ~208 ms/page a 200k-contact sweep already costs ~7 minutes per company run.
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     'https://api.hubapi.com/crm/v3/objects/contacts?limit=1' # then read the portal's contact total in the UI
   ```
4. Confirm `hubspotBatchSize > 1` on the company and contact client configs (multiquimica already has 100).
5. Run the company sync and watch the log line `CRM index built for company: N records` — N must match the portal's real count. If it is 0 on a non-empty portal, stop: the sweep is not reading.
6. Expect the first clean run to report mostly `skipped` for records that already match and `created` only for genuinely new SAP records. `AssociationRegistries` must stop being empty — that collection filling up is the signal the matching works.
