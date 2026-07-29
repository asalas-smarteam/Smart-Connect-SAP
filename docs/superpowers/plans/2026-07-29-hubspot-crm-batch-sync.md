# HubSpot Company/Contact Batch Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce company/contact sync time from hours to minutes (9k companies + associations ≈ 4h today) by replicating the product batch pattern (`processProductBatches`) for companies and contacts, including batched company→contact associations.

**Architecture:** A new application use case `ProcessCrmObjectBatches` replaces the per-item find/create/update/associate loop for `company` and `contact` when `clientConfig.hubspotBatchSize > 1`. It reads existing records via HubSpot `batch/read` (with `idProperty` = the tenant's configured find property), falls back to Search API with the `IN` operator, and degrades to the existing sequential path on failure (identical to the product flow). Company child contacts (`ContactEmployees` B1 / `_s4Contacts` S/4) are synced by a second use case `SyncCompanyContactsInBatches` that maps all contacts in one pass, batch-creates/updates them, and creates associations via the v4 `batch/associate/default` endpoint. Mongo registry lookups/writes become bulk (`$in` / `insertMany`).

**Tech Stack:** Node.js ESM, Jest (`@jest/globals`, DI-style tests, no module mocking), axios (only inside `hubspotClient.js`), Mongoose tenant models.

## Global Constraints

- **Applies to B1 AND S/4:** both flavors produce the same `mappedItems`; child contacts come from `item.rawSapData._s4Contacts ?? item.rawSapData.ContactEmployees`. No flavor-specific branching is allowed in the new code.
- **Model usage:** this plan was authored with Fable 5; **all implementation tasks must be executed with Opus 5** (`model: "opus"` when dispatching subagents).
- **Tests:** run ONLY the touched test files: `npx jest tests/unit/<file>` — never `npx jest tests/unit` or the full suite.
- **Token efficiency:** each task lists exactly which files to read; do not read other files.
- **Hexagonal boundaries:** files under `src/application/` must NOT import from `src/infrastructure/` (enforced by `tests/unit/architecture/hexagonalBoundaries.test.js`). All infrastructure reaches the application layer via constructor DI or call parameters.
- **HubSpot limits:** batch read/create/update accept max **100 inputs per call**; wave concurrency is **4** (Search fallback uses **2** because Search is limited to ~4 req/s). 429s are retried with the existing backoff pattern (5 retries, linear 1s/2s/...).
- **No behavior change** for `product`, `deal`, `invoice` object types, nor for company/contact when `hubspotBatchSize` is absent or ≤ 1 (sequential path stays the default).
- **Metrics parity:** the result shape stays `{ ok, sent, failed, created, updated, errors }` (plus `skipped`, which the product flow already introduced). Company child-contact failures keep the `buildContactErrorEntry` shape and flow into `errors`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/application/services/hubspotBatching.utils.js` | Create | `chunkArray`, `runInWaves`, `retryRequest`, limits (shared by product + CRM flows) |
| `src/application/use-cases/SendMappedItemsToHubspot.js` | Modify | import shared utils; add `crmBatchProcessor` gate |
| `src/infrastructure/hubspot/hubspotClient.js` | Modify | generic company/contact batch endpoints + `IN` search + v4 batch associations |
| `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js` | Create | frozen adapter over the new client functions (mirrors `hubspot-product.adapter.js`) |
| `src/infrastructure/hubspot/associationRegistryService.js` | Modify | bulk `findHubspotIdsForSapIds` + `registerBaseObjectMappings` |
| `src/infrastructure/hubspot/handlers/utils/searchCriteria.utils.js` | Modify | export `getConfiguredFindProperty` |
| `src/infrastructure/hubspot/handlers/company.handler.js` | Modify | `getSearchProperties`, `buildBatchUpdateEntry` |
| `src/infrastructure/hubspot/handlers/contact.handler.js` | Modify | `getSearchProperties`, `buildBatchUpdateEntry` |
| `src/application/services/companyContactPayload.service.js` | Create | pure payload builder shared by per-item and batch child-contact sync |
| `src/application/use-cases/HandleHubspotAssociations.js` | Modify | refactor `syncCompanyContacts` to use the shared payload builder |
| `src/application/use-cases/SyncCompanyContactsInBatches.js` | Create | batched child-contact sync + company→contact associations |
| `src/application/use-cases/ProcessCrmObjectBatches.js` | Create | batched company/contact main flow |
| `src/composition/hubspot-sync.composition.js` | Modify | wire the two new use cases |

---

### Task 1: Shared batching utils

**Files:**
- Create: `src/application/services/hubspotBatching.utils.js`
- Modify: `src/application/use-cases/SendMappedItemsToHubspot.js` (lines 30–49 and the `retryRequest` method around line 207)
- Test: `tests/unit/application/hubspotBatchingUtils.test.js` (new)

**Interfaces:**
- Produces: `HUBSPOT_BATCH_INPUT_LIMIT = 100`, `BATCH_CONCURRENCY = 4`, `SEARCH_FALLBACK_CONCURRENCY = 2`, `chunkArray(array, size)`, `runInWaves(chunks, concurrency, worker)`, `retryRequest(fn, { retries = 5, sleeper })`. All later tasks import from `#application/services/hubspotBatching.utils.js`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/application/hubspotBatchingUtils.test.js
import { jest } from '@jest/globals';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  SEARCH_FALLBACK_CONCURRENCY,
  chunkArray,
  retryRequest,
  runInWaves,
} from '../../../src/application/services/hubspotBatching.utils.js';

describe('hubspotBatching.utils', () => {
  it('exposes the HubSpot batch limits', () => {
    expect(HUBSPOT_BATCH_INPUT_LIMIT).toBe(100);
    expect(BATCH_CONCURRENCY).toBe(4);
    expect(SEARCH_FALLBACK_CONCURRENCY).toBe(2);
  });

  it('chunks arrays preserving order', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 2)).toEqual([]);
  });

  it('runs chunks in waves and collects results in order', async () => {
    const calls = [];
    const results = await runInWaves([1, 2, 3], 2, async (chunk) => {
      calls.push(chunk);
      return chunk * 10;
    });
    expect(results).toEqual([10, 20, 30]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('retries on 429 with linear backoff and rethrows other errors', async () => {
    const sleeper = jest.fn().mockResolvedValue(undefined);
    const rateLimited = Object.assign(new Error('rate'), { response: { status: 429 } });
    const fn = jest.fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce('ok');

    await expect(retryRequest(fn, { sleeper })).resolves.toBe('ok');
    expect(sleeper).toHaveBeenCalledWith(1000);

    const boom = Object.assign(new Error('boom'), { response: { status: 500 } });
    await expect(retryRequest(jest.fn().mockRejectedValue(boom), { sleeper })).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/application/hubspotBatchingUtils.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the utils module**

```js
// src/application/services/hubspotBatching.utils.js
// HubSpot batch endpoints (read/create/update) accept at most 100 inputs per call.
export const HUBSPOT_BATCH_INPUT_LIMIT = 100;
// Concurrent batch calls per wave. 4 keeps us well under HubSpot's ~190 requests/10s limit.
export const BATCH_CONCURRENCY = 4;
// The Search API is limited to ~4 requests/second, so its fallback waves are narrower.
export const SEARCH_FALLBACK_CONCURRENCY = 2;

export function chunkArray(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

export async function runInWaves(chunks, concurrency, worker) {
  const results = [];
  for (const wave of chunkArray(chunks, concurrency)) {
    results.push(...await Promise.all(wave.map(worker)));
  }
  return results;
}

const defaultSleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryRequest(fn, { retries = 5, sleeper = defaultSleeper } = {}) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.response?.status ?? err?.details?.status ?? err?.cause?.response?.status;

    if (status === 429 && retries > 0) {
      const delay = 1000 * (6 - retries);
      await sleeper(delay);
      return retryRequest(fn, { retries: retries - 1, sleeper });
    }

    throw err;
  }
}
```

- [ ] **Step 4: Refactor `SendMappedItemsToHubspot.js` to use the shared utils**

Delete its local `HUBSPOT_BATCH_INPUT_LIMIT`, `BATCH_CONCURRENCY`, `chunkArray`, `runInWaves` (lines 30–49) and add the import:

```js
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  chunkArray,
  runInWaves,
  retryRequest as retryHubspotRequest,
} from '#application/services/hubspotBatching.utils.js';
```

Replace the `retryRequest` method body (keep the method — tests and internal callers use it, and it must keep honoring `this.sleeper`):

```js
  async retryRequest(fn, retries = 5) {
    return retryHubspotRequest(fn, { retries, sleeper: this.sleeper });
  }
```

- [ ] **Step 5: Run the touched tests**

Run: `npx jest tests/unit/application/hubspotBatchingUtils.test.js tests/unit/application/sendMappedItemsToHubspot.test.js tests/unit/application/sendMappedItemsToHubspot.emailBypass.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/hubspotBatching.utils.js src/application/use-cases/SendMappedItemsToHubspot.js tests/unit/application/hubspotBatchingUtils.test.js
git commit -m "refactor: extract shared HubSpot batching utils"
```

---

### Task 2: Generic CRM batch endpoints in hubspotClient + adapter

**Files:**
- Modify: `src/infrastructure/hubspot/hubspotClient.js` (append after `batchReadProductsBySku`, ~line 232)
- Create: `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js`
- Test: none direct (precedent: `batchCreateProducts`/`batchUpdateProducts`/`batchReadProductsBySku` have no direct unit tests; behavior is covered through use-case tests with injected stubs in Tasks 6–7).

**Interfaces:**
- Produces (all exported from `hubspotClient.js` and re-exported frozen in the adapter):
  - `batchReadObjectsByProperty(token, objectType, { idProperty, values, properties = [] })` → HubSpot batch/read response `{ results: [...] }`
  - `batchCreateObjects(token, objectType, data)` — `data = { inputs: [{ properties }] }`
  - `batchUpdateObjects(token, objectType, data)` — `data = { inputs: [{ id, properties }] }`, strips `hs_object_id`
  - `searchObjectsByPropertyIn(token, objectType, propertyName, values, properties = [])` → array of all results (paginated)
  - `batchAssociateDefault(token, fromObjectType, toObjectType, pairs)` — `pairs = [{ fromId, toId }]`
  - `associateObjects` (already exists; re-exported by the adapter for per-pair fallbacks)
  - `objectType` is `'company'` or `'contact'` (singular); the helpers map to plural REST collections.

- [ ] **Step 1: Add the client functions**

Append to `src/infrastructure/hubspot/hubspotClient.js` right after `batchReadProductsBySku`:

```js
const CRM_BATCH_COLLECTIONS = {
  company: 'companies',
  contact: 'contacts',
};

function crmCollection(objectType) {
  const collection = CRM_BATCH_COLLECTIONS[objectType];
  if (!collection) {
    throw new Error(`Unsupported CRM batch object type: ${objectType}`);
  }
  return collection;
}

// Reads up to 100 companies/contacts keyed by a unique-value property (e.g. email
// for contacts, or a custom unique property like idsap). Missing values come back
// in `errors` (207 Multi-Status), not as a request failure — callers treat absence
// from `results` as "does not exist". Throws 400 when idProperty is not unique,
// which callers use to fall back to the Search API.
export async function batchReadObjectsByProperty(token, objectType, { idProperty, values, properties = [] }) {
  return hubspotRequest(
    'post',
    `/crm/v3/objects/${crmCollection(objectType)}/batch/read`,
    token,
    {
      idProperty,
      inputs: values.map((value) => ({ id: String(value) })),
      ...(Array.isArray(properties) && properties.length > 0 ? { properties } : {}),
    },
  );
}

export async function batchCreateObjects(token, objectType, data) {
  return hubspotRequest(
    'post',
    `/crm/v3/objects/${crmCollection(objectType)}/batch/create`,
    token,
    data,
  );
}

export async function batchUpdateObjects(token, objectType, data) {
  data?.inputs?.forEach((item) => {
    delete item?.properties?.hs_object_id;
  });

  return hubspotRequest(
    'post',
    `/crm/v3/objects/${crmCollection(objectType)}/batch/update`,
    token,
    data,
  );
}

// Search fallback when the tenant's find property is not unique-flagged in
// HubSpot (batch/read rejects it). One IN-filter search per <=100 values,
// paginated. Search is rate-limited (~4 req/s) so callers use narrow waves.
export async function searchObjectsByPropertyIn(token, objectType, propertyName, values, properties = []) {
  const results = [];
  let after;

  do {
    const payload = {
      filterGroups: [
        {
          filters: [
            {
              propertyName,
              operator: 'IN',
              values: values.map((value) => String(value)),
            },
          ],
        },
      ],
      limit: 100,
      ...(after ? { after } : {}),
      ...(Array.isArray(properties) && properties.length > 0 ? { properties } : {}),
    };

    // eslint-disable-next-line no-await-in-loop
    const response = await hubspotRequest(
      'post',
      `/crm/v3/objects/${crmCollection(objectType)}/search`,
      token,
      payload,
    );

    results.push(...(response?.results ?? []));
    after = response?.paging?.next?.after;
  } while (after);

  return results;
}

// Creates default-typed associations for up to 100 pairs per call.
export async function batchAssociateDefault(token, fromObjectType, toObjectType, pairs) {
  return hubspotRequest(
    'post',
    `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/associate/default`,
    token,
    {
      inputs: pairs.map(({ fromId, toId }) => ({
        from: { id: String(fromId) },
        to: { id: String(toId) },
      })),
    },
  );
}
```

- [ ] **Step 2: Create the adapter**

```js
// src/infrastructure/hubspot/hubspot-crm-batch.adapter.js
import {
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchReadObjectsByProperty,
  batchUpdateObjects,
  searchObjectsByPropertyIn,
} from './hubspotClient.js';

export const hubspotCrmBatchAdapter = Object.freeze({
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchReadObjectsByProperty,
  batchUpdateObjects,
  searchObjectsByPropertyIn,
});

export default hubspotCrmBatchAdapter;
```

- [ ] **Step 3: Sanity-check nothing broke**

Run: `npx jest tests/unit/hubspotSyncAdapter.test.js tests/unit/architecture/hexagonalBoundaries.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/hubspot/hubspotClient.js src/infrastructure/hubspot/hubspot-crm-batch.adapter.js
git commit -m "feat: add generic company/contact batch endpoints and v4 batch associations to hubspotClient"
```

---

### Task 3: Bulk registry operations

**Files:**
- Modify: `src/infrastructure/hubspot/associationRegistryService.js`
- Test: `tests/unit/infrastructure/associationRegistryService.test.js` (new)

**Interfaces:**
- Produces:
  - `findHubspotIdsForSapIds(hubspotCredentialId, objectType, sapIds, tenantModels)` → `Map<string sapId, string hubspotId>` (newest record wins, mirroring `findHubspotIdForSapId`'s `sort({ createdAt: -1 })`; never throws — returns empty Map on error)
  - `registerBaseObjectMappings(hubspotCredentialId, objectType, mappings, tenantModels)` — `mappings = [{ sapId, hubspotId }]`; uses `insertMany(docs, { ordered: false })`; never throws.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/infrastructure/associationRegistryService.test.js
import { jest } from '@jest/globals';
import associationRegistryService from '../../../src/infrastructure/hubspot/associationRegistryService.js';

function buildRegistryModel(records = []) {
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockResolvedValue(records),
    }),
    insertMany: jest.fn().mockResolvedValue(records),
  };
}

describe('associationRegistryService bulk operations', () => {
  it('resolves hubspot ids for many sap ids in one query, newest wins', async () => {
    const AssociationRegistry = buildRegistryModel([
      { baseSapId: 'C001', baseHubspotId: 'hs-new' },
      { baseSapId: 'C001', baseHubspotId: 'hs-old' },
      { baseSapId: 'C002', baseHubspotId: 'hs-2' },
    ]);

    const result = await associationRegistryService.findHubspotIdsForSapIds(
      'cred-1',
      'company',
      ['C001', 'C002', 'C404'],
      { AssociationRegistry }
    );

    expect(AssociationRegistry.find).toHaveBeenCalledWith({
      hubspotCredentialId: 'cred-1',
      baseObjectType: 'company',
      baseSapId: { $in: ['C001', 'C002', 'C404'] },
    });
    expect(result.get('C001')).toBe('hs-new');
    expect(result.get('C002')).toBe('hs-2');
    expect(result.has('C404')).toBe(false);
  });

  it('returns an empty map when input is empty or the query fails', async () => {
    const empty = await associationRegistryService.findHubspotIdsForSapIds('cred-1', 'company', [], {});
    expect(empty.size).toBe(0);

    const failing = {
      find: jest.fn(() => { throw new Error('db down'); }),
    };
    const onError = await associationRegistryService.findHubspotIdsForSapIds(
      'cred-1', 'company', ['C001'], { AssociationRegistry: failing }
    );
    expect(onError.size).toBe(0);
  });

  it('registers many base mappings with a single unordered insertMany', async () => {
    const AssociationRegistry = buildRegistryModel();

    await associationRegistryService.registerBaseObjectMappings(
      'cred-1',
      'contact',
      [{ sapId: 'P001', hubspotId: 'hs-1' }, { sapId: '', hubspotId: 'hs-x' }, { sapId: 'P002', hubspotId: '' }],
      { AssociationRegistry }
    );

    expect(AssociationRegistry.insertMany).toHaveBeenCalledTimes(1);
    const [docs, options] = AssociationRegistry.insertMany.mock.calls[0];
    expect(options).toEqual({ ordered: false });
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      hubspotCredentialId: 'cred-1',
      baseObjectType: 'contact',
      baseSapId: 'P001',
      baseHubspotId: 'hs-1',
      associatedObjectType: null,
    });
  });

  it('does not throw when insertMany fails', async () => {
    const AssociationRegistry = {
      insertMany: jest.fn().mockRejectedValue(new Error('dup key')),
    };

    await expect(associationRegistryService.registerBaseObjectMappings(
      'cred-1', 'contact', [{ sapId: 'P001', hubspotId: 'hs-1' }], { AssociationRegistry }
    )).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/infrastructure/associationRegistryService.test.js`
Expected: FAIL — `findHubspotIdsForSapIds is not a function`.

- [ ] **Step 3: Implement**

Add to `src/infrastructure/hubspot/associationRegistryService.js` (before the service object) and export both in `associationRegistryService`:

```js
async function findHubspotIdsForSapIds(hubspotCredentialId, objectType, sapIds, tenantModels) {
  const result = new Map();

  if (!hubspotCredentialId || !objectType || !Array.isArray(sapIds) || sapIds.length === 0) {
    return result;
  }

  try {
    const AssociationRegistry = getTenantAssociationRegistry(tenantModels);
    const records = await AssociationRegistry.find({
      hubspotCredentialId,
      baseObjectType: objectType,
      baseSapId: { $in: sapIds.map((sapId) => String(sapId)) },
    }).sort({ createdAt: -1 });

    for (const record of records ?? []) {
      const key = String(record.baseSapId);
      // Sorted newest-first: the first hit per sapId mirrors findHubspotIdForSapId.
      if (!result.has(key) && record.baseHubspotId) {
        result.set(key, record.baseHubspotId);
      }
    }
  } catch (error) {
    console.error('Failed to bulk-find HubSpot IDs for SAP IDs', {
      hubspotCredentialId,
      objectType,
      error,
    });
  }

  return result;
}

async function registerBaseObjectMappings(hubspotCredentialId, objectType, mappings, tenantModels) {
  const docs = (Array.isArray(mappings) ? mappings : [])
    .filter((mapping) => mapping?.sapId)
    .map(({ sapId, hubspotId }) => ({
      hubspotCredentialId,
      baseObjectType: objectType,
      baseSapId: String(sapId),
      baseHubspotId: hubspotId ?? '',
      associatedObjectType: null,
      associatedSapId: null,
      associatedHubspotId: null,
      quantity: null,
    }));

  if (!hubspotCredentialId || !objectType || docs.length === 0) {
    return [];
  }

  try {
    const AssociationRegistry = getTenantAssociationRegistry(tenantModels);
    return await AssociationRegistry.insertMany(docs, { ordered: false });
  } catch (error) {
    console.error('Failed to bulk-register base object mappings', {
      hubspotCredentialId,
      objectType,
      count: docs.length,
      error,
    });
    return [];
  }
}
```

Note the empty-hubspotId filter difference: `registerBaseObjectMapping` (singular) allows empty `hubspotId` (used for validation-skips) — the bulk version must too, so only `sapId` is required (the test above asserts `{ sapId: 'P002', hubspotId: '' }` IS inserted; the filter drops only missing `sapId`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/infrastructure/associationRegistryService.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/associationRegistryService.js tests/unit/infrastructure/associationRegistryService.test.js
git commit -m "feat: add bulk find/register operations to association registry"
```

---

### Task 4: Handler batch helpers + configured find property

**Files:**
- Modify: `src/infrastructure/hubspot/handlers/utils/searchCriteria.utils.js`
- Modify: `src/infrastructure/hubspot/handlers/company.handler.js`
- Modify: `src/infrastructure/hubspot/handlers/contact.handler.js`
- Test: `tests/unit/companyHandler.test.js`, `tests/unit/contactHandler.test.js` (extend existing files — read them first to match their stubbing style)

**Interfaces:**
- Produces:
  - `getConfiguredFindProperty({ tenantModels, fallbackPropertyName = 'email' })` → `string` (exported from `searchCriteria.utils.js`)
  - On both handlers (added to the default export):
    - `getSearchProperties({ clientConfig, tenantModels })` → `string[]` (wraps `buildMappedSearchProperties` with each handler's defaults)
    - `buildBatchUpdateEntry({ existing, item })` → `{ id, properties } | null` — `null` means "skip, nothing to update", replicating exactly the skip logic inside each handler's `update()` (`buildIdentifierOnlyPayload` + `shouldUpdateByKeyFields` with `nameField` `'name'` for company, `'firstname'` for contact).

- [ ] **Step 1: Refactor `searchCriteria.utils.js`**

```js
// src/infrastructure/hubspot/handlers/utils/searchCriteria.utils.js
import DefaultFindHubspotConfigRepository from '#infrastructure/config/DefaultFindHubspotConfigRepository.js';

const defaultFindHubspotConfigRepository = new DefaultFindHubspotConfigRepository();

function hasSearchValue(value) {
  return value !== undefined && value !== null && value !== '';
}

export async function getConfiguredFindProperty({
  tenantModels,
  fallbackPropertyName = 'email',
}) {
  const configuredPropertyName = await defaultFindHubspotConfigRepository
    .getDefaultFindHubspotProperty({ tenantModels });
  return configuredPropertyName || fallbackPropertyName;
}

export async function buildConfiguredSearchCriteria({
  item,
  tenantModels,
  fallbackPropertyName = 'email',
}) {
  const propertyName = await getConfiguredFindProperty({ tenantModels, fallbackPropertyName });
  const value = item?.properties?.[propertyName];

  if (!hasSearchValue(value)) {
    return null;
  }

  return {
    propertyName,
    value,
  };
}

export default {
  buildConfiguredSearchCriteria,
  getConfiguredFindProperty,
};
```

- [ ] **Step 2: Write failing tests for the handler helpers**

Append to `tests/unit/companyHandler.test.js` (mirror the file's existing setup; if it mocks `hubspotClient`, no new mocking is needed — these helpers are pure except `getSearchProperties`):

```js
import companyHandler from '../../src/infrastructure/hubspot/handlers/company.handler.js';

describe('company.handler buildBatchUpdateEntry', () => {
  it('returns null when the identifier-only payload is empty', () => {
    expect(companyHandler.buildBatchUpdateEntry({
      existing: { id: 'hs-1', properties: { name: 'Acme' } },
      item: { properties: { name: 'Acme' } },
    })).toBeNull();
  });

  it('returns null when key fields are unchanged', () => {
    expect(companyHandler.buildBatchUpdateEntry({
      existing: { id: 'hs-1', properties: { name: 'Acme', phone: '1', idsap: 'C001' } },
      item: { properties: { name: 'Acme', phone: '1', idsap: 'C001' } },
    })).toBeNull();
  });

  it('returns an id + identifier payload when key fields changed', () => {
    expect(companyHandler.buildBatchUpdateEntry({
      existing: { id: 'hs-1', properties: { name: 'Old', idsap: 'C001' } },
      item: { properties: { name: 'New', idsap: 'C001' } },
    })).toEqual({ id: 'hs-1', properties: { idsap: 'C001' } });
  });
});
```

Append the symmetric cases to `tests/unit/contactHandler.test.js` using `firstname` instead of `name` and `internalcode` in the payload assertion:

```js
import contactHandler from '../../src/infrastructure/hubspot/handlers/contact.handler.js';

describe('contact.handler buildBatchUpdateEntry', () => {
  it('returns null when key fields are unchanged', () => {
    expect(contactHandler.buildBatchUpdateEntry({
      existing: { id: 'hs-9', properties: { firstname: 'Ana', phone: '1', idsap: 'P001' } },
      item: { properties: { firstname: 'Ana', phone: '1', idsap: 'P001' } },
    })).toBeNull();
  });

  it('returns an id + identifier payload when key fields changed', () => {
    expect(contactHandler.buildBatchUpdateEntry({
      existing: { id: 'hs-9', properties: { firstname: 'Old', idsap: 'P001' } },
      item: { properties: { firstname: 'New', idsap: 'P001', internalcode: 'IC-1' } },
    })).toEqual({ id: 'hs-9', properties: { idsap: 'P001', internalcode: 'IC-1' } });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest tests/unit/companyHandler.test.js tests/unit/contactHandler.test.js`
Expected: FAIL — `buildBatchUpdateEntry is not a function`.

- [ ] **Step 4: Implement in both handlers**

In `company.handler.js` add and include in the default export:

```js
export async function getSearchProperties({ clientConfig, tenantModels }) {
  return buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'company',
    defaults: COMPANY_SEARCH_PROPERTIES,
  });
}

// Batch analogue of update(): null means "skip". Same identifier-only payload
// and key-field gate, but returns the input for a batch/update call instead of
// performing the PATCH.
export function buildBatchUpdateEntry({ existing, item }) {
  const properties = item?.properties ?? {};
  const payload = buildIdentifierOnlyPayload(properties);

  if (!payload || !existing?.id) {
    return null;
  }

  if (
    !shouldUpdateByKeyFields({
      existingProperties: existing?.properties,
      incomingProperties: properties,
      nameField: 'name',
    })
  ) {
    return null;
  }

  return { id: existing.id, properties: payload.properties };
}

export default {
  find,
  create,
  update,
  getSearchProperties,
  buildBatchUpdateEntry,
};
```

Same in `contact.handler.js` with `objectType: 'contact'`, `defaults: CONTACT_SEARCH_PROPERTIES`, `nameField: 'firstname'`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/unit/companyHandler.test.js tests/unit/contactHandler.test.js`
Expected: PASS (including the pre-existing tests in those files).

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/hubspot/handlers/utils/searchCriteria.utils.js src/infrastructure/hubspot/handlers/company.handler.js src/infrastructure/hubspot/handlers/contact.handler.js tests/unit/companyHandler.test.js tests/unit/contactHandler.test.js
git commit -m "feat: add batch update helpers to company/contact handlers"
```

---

### Task 5: Shared company-contact payload builder

**Files:**
- Create: `src/application/services/companyContactPayload.service.js`
- Modify: `src/application/use-cases/HandleHubspotAssociations.js` (`syncCompanyContacts`, lines ~279–310, and remove the now-unused local `getSapContactEmail`)
- Test: `tests/unit/application/companyContactPayload.test.js` (new)

**Interfaces:**
- Produces: `buildCompanyContactPayload({ mappedContact, sapContact, companyFallbackSourceEmail, fallbackEmailGenerator })` → `{ contactPayload, sapInternalCode }`. Pure function: resolves the contact email (SAP `E_Mail`/`EmailAddress` → mapped email → fallback generator) and the SAP id (`InternalCode` B1 / `BusinessPartner` S/4). Bypass-email handling stays in the callers.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/application/companyContactPayload.test.js
import { buildCompanyContactPayload } from '../../../src/application/services/companyContactPayload.service.js';

describe('buildCompanyContactPayload', () => {
  const fallbackEmailGenerator = (companyEmail, code) => (code ? `bp-${code}@fallback.local` : null);

  it('prefers the SAP contact email (B1 E_Mail)', () => {
    const { contactPayload, sapInternalCode } = buildCompanyContactPayload({
      mappedContact: { properties: { firstname: 'Ana', email: 'mapped@x.com' } },
      sapContact: { InternalCode: 7, E_Mail: ' ana@sap.com ' },
      companyFallbackSourceEmail: 'company@x.com',
      fallbackEmailGenerator,
    });

    expect(contactPayload.properties.email).toBe('ana@sap.com');
    expect(sapInternalCode).toBe(7);
  });

  it('uses the S/4 BusinessPartner id and EmailAddress field', () => {
    const { contactPayload, sapInternalCode } = buildCompanyContactPayload({
      mappedContact: { properties: { firstname: 'Luis' } },
      sapContact: { BusinessPartner: 'BP-9', EmailAddress: 'luis@s4.com' },
      companyFallbackSourceEmail: null,
      fallbackEmailGenerator,
    });

    expect(contactPayload.properties.email).toBe('luis@s4.com');
    expect(sapInternalCode).toBe('BP-9');
  });

  it('falls back to the generated email when no email exists', () => {
    const { contactPayload } = buildCompanyContactPayload({
      mappedContact: { properties: { firstname: 'Eva' } },
      sapContact: { InternalCode: 3 },
      companyFallbackSourceEmail: 'company@x.com',
      fallbackEmailGenerator,
    });

    expect(contactPayload.properties.email).toBe('bp-3@fallback.local');
  });

  it('does not mutate the mapped contact', () => {
    const mappedContact = { properties: { firstname: 'Eva' } };
    buildCompanyContactPayload({
      mappedContact,
      sapContact: { InternalCode: 3, E_Mail: 'e@x.com' },
      companyFallbackSourceEmail: null,
      fallbackEmailGenerator,
    });
    expect(mappedContact.properties.email).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/application/companyContactPayload.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```js
// src/application/services/companyContactPayload.service.js
function getSapContactEmail(sapContact) {
  return String(sapContact?.E_Mail ?? sapContact?.EmailAddress ?? '').trim();
}

// Builds the HubSpot payload for one company child contact. B1 contacts carry
// InternalCode + E_Mail; S/4 person-BPs carry BusinessPartner + EmailAddress.
// Email precedence: SAP contact email > mapped email > generated fallback.
export function buildCompanyContactPayload({
  mappedContact,
  sapContact,
  companyFallbackSourceEmail,
  fallbackEmailGenerator,
}) {
  const sapInternalCode = sapContact?.InternalCode ?? sapContact?.BusinessPartner;
  const contactPayload = {
    ...mappedContact,
    properties: {
      ...(mappedContact?.properties || {}),
    },
  };

  const sapContactEmail = getSapContactEmail(sapContact);

  if (sapContactEmail) {
    contactPayload.properties.email = sapContactEmail;
  }

  if (!contactPayload.properties.email) {
    const fallbackEmail = fallbackEmailGenerator(companyFallbackSourceEmail, sapInternalCode);

    if (fallbackEmail) {
      contactPayload.properties.email = fallbackEmail;
    }
  }

  return { contactPayload, sapInternalCode };
}

export default { buildCompanyContactPayload };
```

- [ ] **Step 4: Refactor `HandleHubspotAssociations.syncCompanyContacts` to use it**

Add the import, delete the local `getSapContactEmail`, and replace the payload-building block inside the `for` loop (currently lines ~283–310, from `const sapInternalCode = ...` through the fallback-email `if`) with:

```js
      const { contactPayload: builtPayload, sapInternalCode } = buildCompanyContactPayload({
        mappedContact,
        sapContact,
        companyFallbackSourceEmail: item?.rawSapData?.EmailAddress,
        fallbackEmailGenerator: this.fallbackEmailGenerator,
      });
```

Keep the surrounding structure intact: the loop still declares `let contactPayload = null;` before the `try` (assign `contactPayload = builtPayload;` right after the call so the `catch` keeps reporting it), and everything from the bypass block onward is unchanged.

- [ ] **Step 5: Run the touched tests**

Run: `npx jest tests/unit/application/companyContactPayload.test.js tests/unit/application/syncCompanyContactsS4.test.js tests/unit/application/handleHubspotAssociations.emailBypass.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/companyContactPayload.service.js src/application/use-cases/HandleHubspotAssociations.js tests/unit/application/companyContactPayload.test.js
git commit -m "refactor: extract company contact payload builder"
```

---

### Task 6: `SyncCompanyContactsInBatches` use case

**Files:**
- Create: `src/application/use-cases/SyncCompanyContactsInBatches.js`
- Test: `tests/unit/application/syncCompanyContactsInBatches.test.js` (new)

**Interfaces:**
- Consumes: `hubspotBatching.utils` (Task 1); `crmBatchClient` = `hubspotCrmBatchAdapter` shape (Task 2); `associationRegistry.findHubspotIdsForSapIds` / `registerBaseObjectMappings` (Task 3); `contactHandler.getSearchProperties` / `buildBatchUpdateEntry` / `find` / `create` / `update` (Task 4); `buildCompanyContactPayload` (Task 5); `findPropertyResolver({ tenantModels })` → string (wired to `getConfiguredFindProperty` in Task 8); `buildContactErrorEntry` (exported by `HandleHubspotAssociations.js`); `applyBypassEmail`/`resolveBypassEmail` from `bypassEmail.service.js`.
- Produces: `execute({ companies, clientConfig, tenantModels, getToken, syncLogId })` → `{ contactErrors }` where `companies = [{ item, hubspotId }]` (only companies that got a HubSpot id). Constructor deps: `{ crmBatchClient, contactHandler, associationRegistry, fieldMappingService, fallbackEmailGenerator, bypassEmailConfigRepository = null, syncWarningRepository = null, findPropertyResolver, logger = console, sleeper }`.

**Behavioral parity notes (versus `syncCompanyContacts`):**
- Contact mappings are fetched **once per run** (today: once per company — 9k Mongo round-trips).
- `fieldMappingService.mapRecords` is called **once** with every SAP contact of the run (it maps records independently).
- Missing-email contacts (not bypassed) are skipped with the same `contactEmailMissingSkipped` warning.
- Child-contact updates are NOT gated by `mainDataInUpdate` (same as today) — only by `buildBatchUpdateEntry`'s key-field check.
- Payloads are deduped by lowercased email before batch create (two companies sharing a contact email would otherwise fail the whole batch); every company still gets its association pair.
- A failed create/update chunk falls back to per-contact sequential `contactHandler` calls so one bad record only produces its own `contactErrors` entry.
- A failed association chunk falls back to per-pair `crmBatchClient.associateObjects`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/application/syncCompanyContactsInBatches.test.js
import { jest } from '@jest/globals';
import SyncCompanyContactsInBatches from '../../../src/application/use-cases/SyncCompanyContactsInBatches.js';

function buildUseCase(overrides = {}) {
  return new SyncCompanyContactsInBatches({
    crmBatchClient: {
      batchReadObjectsByProperty: jest.fn().mockResolvedValue({ results: [] }),
      batchCreateObjects: jest.fn().mockImplementation(async (_t, _o, { inputs }) => ({
        results: inputs.map((input, index) => ({
          id: `hs-c-${index}`,
          properties: { ...input.properties },
        })),
      })),
      batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
      batchAssociateDefault: jest.fn().mockResolvedValue({}),
      associateObjects: jest.fn().mockResolvedValue({}),
      searchObjectsByPropertyIn: jest.fn().mockResolvedValue([]),
    },
    contactHandler: {
      getSearchProperties: jest.fn().mockResolvedValue(['email', 'firstname', 'phone', 'idsap', 'internalcode']),
      buildBatchUpdateEntry: jest.fn().mockReturnValue(null),
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-seq' }),
      update: jest.fn().mockResolvedValue(null),
    },
    associationRegistry: {
      findHubspotIdsForSapIds: jest.fn().mockResolvedValue(new Map()),
      registerBaseObjectMappings: jest.fn().mockResolvedValue([]),
    },
    fieldMappingService: {
      getMappingsByObjectType: jest.fn().mockResolvedValue([{ hubspotField: 'firstname' }]),
      mapRecords: jest.fn().mockImplementation(async (records) => records.map((record) => ({
        properties: { firstname: record.Name ?? record.FirstName ?? 'X' },
      }))),
    },
    fallbackEmailGenerator: (companyEmail, code) => (code ? `bp-${code}@fallback.local` : null),
    findPropertyResolver: jest.fn().mockResolvedValue('email'),
    logger: { warn: jest.fn(), error: jest.fn() },
    sleeper: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

const clientConfig = { hubspotCredentialId: 'cred-1' };
const getToken = jest.fn().mockResolvedValue('token-1');

describe('SyncCompanyContactsInBatches', () => {
  it('maps all contacts in one pass, batch-creates them, registers mappings and associates', async () => {
    const useCase = buildUseCase();
    const companies = [
      {
        hubspotId: 'hs-co-1',
        item: {
          properties: { idsap: 'C001' },
          rawSapData: {
            CardCode: 'C001',
            EmailAddress: 'c1@x.com',
            ContactEmployees: [
              { InternalCode: 1, Name: 'Ana', E_Mail: 'ana@x.com' },
              { InternalCode: 2, Name: 'Luis', E_Mail: 'luis@x.com' },
            ],
          },
        },
      },
      {
        hubspotId: 'hs-co-2',
        item: {
          properties: { idsap: 'BP2' },
          rawSapData: {
            BusinessPartner: 'BP2',
            _s4Contacts: [{ BusinessPartner: 'BP-P1', FirstName: 'Eva', EmailAddress: 'eva@x.com' }],
          },
        },
      },
    ];

    const { contactErrors } = await useCase.execute({
      companies,
      clientConfig,
      tenantModels: {},
      getToken,
      syncLogId: null,
    });

    expect(contactErrors).toEqual([]);
    expect(useCase.fieldMappingService.mapRecords).toHaveBeenCalledTimes(1);
    expect(useCase.fieldMappingService.getMappingsByObjectType).toHaveBeenCalledTimes(1);
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalledTimes(1);
    expect(useCase.associationRegistry.registerBaseObjectMappings).toHaveBeenCalledTimes(1);
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toMatchObject({ fromId: 'hs-co-1' });
  });

  it('dedupes contacts sharing an email but associates every company', async () => {
    const useCase = buildUseCase();
    const shared = { InternalCode: 9, Name: 'Shared', E_Mail: 'shared@x.com' };
    const companies = [
      { hubspotId: 'hs-co-1', item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [shared] } } },
      { hubspotId: 'hs-co-2', item: { properties: {}, rawSapData: { CardCode: 'C2', ContactEmployees: [shared] } } },
    ];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    const createInputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(createInputs).toHaveLength(1);
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs.map((p) => p.fromId).sort()).toEqual(['hs-co-1', 'hs-co-2']);
  });

  it('updates existing contacts only when the handler says key fields changed', async () => {
    const existing = { id: 'hs-old', properties: { email: 'ana@x.com', firstname: 'Old' } };
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({ results: [existing] });
    useCase.contactHandler.buildBatchUpdateEntry.mockReturnValue({ id: 'hs-old', properties: { idsap: 'P1' } });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'ana@x.com' }] } },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchUpdateObjects).toHaveBeenCalledTimes(1);
    const pairs = useCase.crmBatchClient.batchAssociateDefault.mock.calls[0][3];
    expect(pairs).toEqual([{ fromId: 'hs-co-1', toId: 'hs-old' }]);
  });

  it('skips contacts without email (not bypassed) and records a warning', async () => {
    const record = jest.fn().mockResolvedValue(null);
    const useCase = buildUseCase({
      syncWarningRepository: { record },
      fallbackEmailGenerator: () => null,
    });

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, Name: 'NoMail' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: 'log-1' });

    expect(contactErrors).toEqual([]);
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      code: 'contactEmailMissingSkipped',
      syncLogId: 'log-1',
    }));
  });

  it('falls back to per-contact sequential sync when a create chunk fails', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(new Error('batch down'));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(useCase.contactHandler.create).toHaveBeenCalledTimes(1);
    expect(contactErrors).toEqual([]);
  });

  it('collects contactErrors for contacts that fail even in the sequential fallback', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(new Error('batch down'));
    useCase.contactHandler.create.mockRejectedValue(Object.assign(new Error('409'), {
      details: { status: 409, hubspotResponse: { message: 'exists' } },
    }));

    const companies = [{
      hubspotId: 'hs-co-1',
      item: { properties: {}, rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 1, E_Mail: 'a@x.com' }] } },
    }];

    const { contactErrors } = await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    expect(contactErrors).toHaveLength(1);
    expect(contactErrors[0]).toMatchObject({
      errorType: 'contactEmployee',
      sapCompanyId: 'C1',
      hubspotCompanyId: 'hs-co-1',
      status: 409,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/application/syncCompanyContactsInBatches.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use case**

```js
// src/application/use-cases/SyncCompanyContactsInBatches.js
import {
  applyBypassEmail,
  resolveBypassEmail,
} from '#application/services/bypassEmail.service.js';
import { buildCompanyContactPayload } from '#application/services/companyContactPayload.service.js';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  chunkArray,
  retryRequest,
  runInWaves,
} from '#application/services/hubspotBatching.utils.js';
import { buildContactErrorEntry } from '#application/use-cases/HandleHubspotAssociations.js';

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getCompanySapId(item) {
  return item?.rawSapData?.BusinessPartner
    ?? item?.rawSapData?.CardCode
    ?? item?.properties?.idsap
    ?? null;
}

// Batched analogue of HandleHubspotAssociations.syncCompanyContacts: syncs the
// child contacts of every company of a run (B1 ContactEmployees / S/4
// _s4Contacts) with batch read/create/update + v4 default batch associations.
export class SyncCompanyContactsInBatches {
  constructor({
    crmBatchClient,
    contactHandler,
    associationRegistry,
    fieldMappingService,
    fallbackEmailGenerator,
    findPropertyResolver,
    bypassEmailConfigRepository = null,
    syncWarningRepository = null,
    logger = console,
    sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.crmBatchClient = crmBatchClient;
    this.contactHandler = contactHandler;
    this.associationRegistry = associationRegistry;
    this.fieldMappingService = fieldMappingService;
    this.fallbackEmailGenerator = fallbackEmailGenerator;
    this.findPropertyResolver = findPropertyResolver;
    this.bypassEmailConfigRepository = bypassEmailConfigRepository;
    this.syncWarningRepository = syncWarningRepository;
    this.logger = logger;
    this.sleeper = sleeper;
  }

  async recordWarning(payload) {
    if (!this.syncWarningRepository?.record) {
      return null;
    }

    try {
      return await this.syncWarningRepository.record(payload);
    } catch (error) {
      this.logger.error?.('Sync warning record error:', error);
      return null;
    }
  }

  retry(fn) {
    return retryRequest(fn, { sleeper: this.sleeper });
  }

  async execute({ companies, clientConfig, tenantModels, getToken, syncLogId = null }) {
    const contactErrors = [];
    const clientConfigId = clientConfig?.id ?? clientConfig?._id ?? null;
    const withContacts = (Array.isArray(companies) ? companies : [])
      .filter(({ hubspotId }) => hubspotId)
      .map(({ item, hubspotId }) => ({
        item,
        hubspotId,
        sapCompanyId: getCompanySapId(item),
        sapContacts: item?.rawSapData?._s4Contacts ?? item?.rawSapData?.ContactEmployees ?? [],
      }))
      .filter(({ sapContacts }) => Array.isArray(sapContacts) && sapContacts.length > 0);

    if (withContacts.length === 0) {
      return { contactErrors };
    }

    let entries;
    try {
      entries = await this.buildEntries({ withContacts, clientConfig, tenantModels, clientConfigId, syncLogId });
    } catch (setupError) {
      this.logger.error?.('Company contact batch sync error:', setupError);
      contactErrors.push(buildContactErrorEntry({ error: setupError }));
      return { contactErrors };
    }

    if (entries.length === 0) {
      return { contactErrors };
    }

    // Dedupe by find-property value: HubSpot rejects a batch containing two
    // inputs with the same unique value. Every company keeps its association.
    const findProperty = await this.findPropertyResolver({ tenantModels });
    const byKey = new Map();
    for (const entry of entries) {
      const key = normalizeKey(entry.contactPayload?.properties?.[findProperty]);
      entry.key = key;

      if (key && !byKey.has(key)) {
        byKey.set(key, entry);
      } else if (!key) {
        // No find value (e.g. bypassed email with findProperty=email): cannot
        // be matched to an existing record — always created, never deduped.
        entry.alwaysCreate = true;
      }
    }
    const uniqueEntries = [...byKey.values(), ...entries.filter((entry) => entry.alwaysCreate)];

    const existingByKey = await this.readExistingContacts({
      keys: [...byKey.keys()],
      findProperty,
      uniqueEntries,
      clientConfig,
      tenantModels,
      getToken,
    });

    const createEntries = [];
    const updateEntries = [];
    const hubspotIdByKey = new Map();

    for (const entry of uniqueEntries) {
      const existing = entry.key ? existingByKey.get(entry.key) : null;

      if (!existing) {
        createEntries.push(entry);
        continue;
      }

      hubspotIdByKey.set(entry.key, existing.id);
      const updateInput = this.contactHandler.buildBatchUpdateEntry({ existing, item: entry.contactPayload });

      if (updateInput) {
        updateEntries.push({ entry, updateInput });
      }
    }

    await this.createContactBatches({ createEntries, hubspotIdByKey, findProperty, clientConfig, tenantModels, getToken, contactErrors });
    await this.updateContactBatches({ updateEntries, clientConfig, tenantModels, getToken, contactErrors });
    await this.associateContactBatches({ entries, hubspotIdByKey, getToken, contactErrors });

    return { contactErrors };
  }

  // Maps every SAP contact of the run in ONE mapRecords call and applies the
  // same email/bypass/skip rules as the sequential path.
  async buildEntries({ withContacts, clientConfig, tenantModels, clientConfigId, syncLogId }) {
    const flat = [];
    for (const company of withContacts) {
      for (const sapContact of company.sapContacts) {
        flat.push({ company, sapContact });
      }
    }

    const contactMappings = await this.fieldMappingService.getMappingsByObjectType(
      clientConfig.hubspotCredentialId,
      'contact',
      'contactEmployee',
      tenantModels
    );

    if (!Array.isArray(contactMappings) || contactMappings.length === 0) {
      this.logger.warn?.('No contactEmployee mappings found for company contact sync');
    }

    const mappedContacts = await this.fieldMappingService.mapRecords(
      flat.map(({ sapContact }) => sapContact),
      clientConfig.hubspotCredentialId,
      'contact',
      tenantModels,
      'contactEmployee'
    );

    const bypassEmail = await resolveBypassEmail({
      objectType: 'contact',
      tenantModels,
      bypassEmailConfigRepository: this.bypassEmailConfigRepository,
      logger: this.logger,
    });

    const entries = [];

    for (const [index, { company, sapContact }] of flat.entries()) {
      const { contactPayload, sapInternalCode } = buildCompanyContactPayload({
        mappedContact: mappedContacts[index] ?? { properties: {} },
        sapContact,
        companyFallbackSourceEmail: company.item?.rawSapData?.EmailAddress,
        fallbackEmailGenerator: this.fallbackEmailGenerator,
      });

      const bypassWarnings = [];
      const emailWasBypassed = applyBypassEmail({
        objectType: 'contact',
        item: contactPayload,
        bypassEmail,
        logger: this.logger,
        sapId: sapInternalCode ?? null,
        onWarning: (warning) => bypassWarnings.push(warning),
      });

      for (const warning of bypassWarnings) {
        await this.recordWarning({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType: 'contact',
          sapId: warning.sapId ?? sapInternalCode ?? null,
          code: warning.code,
          message: warning.message,
          details: {
            source: 'companyContact',
            sapCompanyId: company.sapCompanyId,
            hubspotCompanyId: company.hubspotId ?? null,
            email: warning.email ?? null,
          },
        });
      }

      if (!contactPayload.properties.email && !emailWasBypassed) {
        this.logger.error?.(
          'Company contact sync error:',
          new Error('Company contact email is required before HubSpot sync')
        );
        await this.recordWarning({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType: 'contact',
          sapId: sapInternalCode ?? null,
          code: 'contactEmailMissingSkipped',
          message: 'Company contact skipped: email is required before HubSpot sync',
          details: {
            source: 'companyContact',
            sapCompanyId: company.sapCompanyId,
            hubspotCompanyId: company.hubspotId ?? null,
          },
        });
        continue;
      }

      entries.push({ company, sapContact, contactPayload, sapInternalCode });
    }

    return entries;
  }

  async readExistingContacts({ keys, findProperty, uniqueEntries, clientConfig, tenantModels, getToken }) {
    const existingByKey = new Map();

    if (keys.length === 0) {
      return existingByKey;
    }

    const searchProperties = await this.contactHandler.getSearchProperties({ clientConfig, tenantModels });
    const propertyNames = [...new Set([
      findProperty,
      ...searchProperties,
      ...uniqueEntries.flatMap((entry) => Object.keys(entry.contactPayload?.properties ?? {})),
    ])].filter((name) => name !== 'hs_object_id');

    const collect = (results) => {
      for (const result of results ?? []) {
        const key = normalizeKey(result?.properties?.[findProperty]);
        if (key && !existingByKey.has(key)) {
          existingByKey.set(key, result);
        }
      }
    };

    try {
      await runInWaves(
        chunkArray(keys, HUBSPOT_BATCH_INPUT_LIMIT),
        BATCH_CONCURRENCY,
        async (keyChunk) => {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchReadObjectsByProperty(token, 'contact', {
              idProperty: findProperty,
              values: keyChunk,
              properties: propertyNames,
            })
          );
          collect(response?.results);
        }
      );
    } catch (error) {
      // idProperty not unique in this portal (or batch read unavailable):
      // fall back to the Search API with IN filters.
      this.logger.error?.('Contact batch read failed, falling back to search:', error);
      existingByKey.clear();
      await runInWaves(
        chunkArray(keys, HUBSPOT_BATCH_INPUT_LIMIT),
        SEARCH_FALLBACK_CONCURRENCY,
        async (keyChunk) => {
          const token = await getToken();
          const results = await this.retry(() =>
            this.crmBatchClient.searchObjectsByPropertyIn(token, 'contact', findProperty, keyChunk, propertyNames)
          );
          collect(results);
        }
      );
    }

    return existingByKey;
  }

  async createContactBatches({ createEntries, hubspotIdByKey, findProperty, clientConfig, tenantModels, getToken, contactErrors }) {
    await runInWaves(
      chunkArray(createEntries, HUBSPOT_BATCH_INPUT_LIMIT),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        try {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchCreateObjects(token, 'contact', {
              inputs: entryChunk.map(({ contactPayload }) => ({ properties: contactPayload.properties })),
            })
          );

          // Batch create results are not guaranteed to preserve input order:
          // match by the find property (fall back to positional index).
          const resultByKey = new Map();
          for (const result of response?.results ?? []) {
            const key = normalizeKey(result?.properties?.[findProperty]);
            if (key) {
              resultByKey.set(key, result);
            }
          }

          const mappings = [];
          for (const [index, entry] of entryChunk.entries()) {
            const created = resultByKey.get(entry.key)
              ?? response?.results?.[index];

            if (created?.id) {
              if (entry.key) {
                hubspotIdByKey.set(entry.key, created.id);
              } else {
                entry.hubspotId = created.id;
              }
              if (entry.sapInternalCode) {
                mappings.push({ sapId: entry.sapInternalCode, hubspotId: created.id });
              }
            }
          }

          if (mappings.length > 0) {
            await this.associationRegistry.registerBaseObjectMappings(
              clientConfig.hubspotCredentialId,
              'contact',
              mappings,
              tenantModels
            );
          }
        } catch (error) {
          this.logger.error?.('Contact batch create failed, falling back per contact:', error);
          await this.sequentialContactFallback({ entryChunk, hubspotIdByKey, clientConfig, tenantModels, getToken, contactErrors });
        }
      }
    );
  }

  async updateContactBatches({ updateEntries, clientConfig, tenantModels, getToken, contactErrors }) {
    await runInWaves(
      chunkArray(updateEntries, HUBSPOT_BATCH_INPUT_LIMIT),
      BATCH_CONCURRENCY,
      async (chunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchUpdateObjects(token, 'contact', {
              inputs: chunk.map(({ updateInput }) => updateInput),
            })
          );
        } catch (error) {
          this.logger.error?.('Contact batch update failed, falling back per contact:', error);
          for (const { entry, updateInput } of chunk) {
            try {
              const token = await getToken();
              await this.contactHandler.update({
                token,
                id: updateInput.id,
                existing: { id: updateInput.id },
                item: entry.contactPayload,
                clientConfig,
                tenantModels,
              });
            } catch (contactSyncError) {
              this.logger.error?.('Company contact sync error:', contactSyncError);
              contactErrors.push(buildContactErrorEntry({
                error: contactSyncError,
                sapContactId: entry.sapInternalCode ?? null,
                sapCompanyId: entry.company.sapCompanyId,
                companyHubspotId: entry.company.hubspotId,
                contactPayload: entry.contactPayload,
              }));
            }
          }
        }
      }
    );
  }

  // Degraded path for a failed create chunk: one contact at a time with the
  // same handler the sequential flow uses, isolating individual failures.
  async sequentialContactFallback({ entryChunk, hubspotIdByKey, clientConfig, tenantModels, getToken, contactErrors }) {
    for (const entry of entryChunk) {
      try {
        const token = await getToken();
        const existingContact = await this.contactHandler.find({
          token,
          item: entry.contactPayload,
          clientConfig,
          tenantModels,
        });

        let contactHubspotId = existingContact?.id;

        if (!existingContact) {
          const createdContact = await this.contactHandler.create({
            token,
            item: entry.contactPayload,
            clientConfig,
            tenantModels,
          });
          contactHubspotId = createdContact?.id;

          if (contactHubspotId && entry.sapInternalCode) {
            await this.associationRegistry.registerBaseObjectMappings(
              clientConfig.hubspotCredentialId,
              'contact',
              [{ sapId: entry.sapInternalCode, hubspotId: contactHubspotId }],
              tenantModels
            );
          }
        }

        if (contactHubspotId) {
          if (entry.key) {
            hubspotIdByKey.set(entry.key, contactHubspotId);
          } else {
            entry.hubspotId = contactHubspotId;
          }
        }
      } catch (contactSyncError) {
        this.logger.error?.('Company contact sync error:', contactSyncError);
        contactErrors.push(buildContactErrorEntry({
          error: contactSyncError,
          sapContactId: entry.sapInternalCode ?? null,
          sapCompanyId: entry.company.sapCompanyId,
          companyHubspotId: entry.company.hubspotId,
          contactPayload: entry.contactPayload,
        }));
      }
    }
  }

  async associateContactBatches({ entries, hubspotIdByKey, getToken, contactErrors }) {
    const pairs = [];
    const seen = new Set();

    for (const entry of entries) {
      const contactHubspotId = entry.key ? hubspotIdByKey.get(entry.key) : entry.hubspotId;

      if (!contactHubspotId) {
        continue;
      }

      const pairKey = `${entry.company.hubspotId}:${contactHubspotId}`;
      if (seen.has(pairKey)) {
        continue;
      }
      seen.add(pairKey);
      pairs.push({ fromId: entry.company.hubspotId, toId: contactHubspotId, entry });
    }

    await runInWaves(
      chunkArray(pairs, HUBSPOT_BATCH_INPUT_LIMIT),
      BATCH_CONCURRENCY,
      async (pairChunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchAssociateDefault(
              token,
              'company',
              'contact',
              pairChunk.map(({ fromId, toId }) => ({ fromId, toId }))
            )
          );
        } catch (error) {
          this.logger.error?.('Batch association failed, falling back per pair:', error);
          for (const { fromId, toId, entry } of pairChunk) {
            try {
              const token = await getToken();
              await this.crmBatchClient.associateObjects(token, 'company', fromId, 'contact', toId);
            } catch (associationError) {
              this.logger.error?.('Company contact sync error:', associationError);
              contactErrors.push(buildContactErrorEntry({
                error: associationError,
                sapContactId: entry.sapInternalCode ?? null,
                sapCompanyId: entry.company.sapCompanyId,
                companyHubspotId: fromId,
                contactPayload: entry.contactPayload,
              }));
            }
          }
        }
      }
    );
  }
}

export default SyncCompanyContactsInBatches;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/application/syncCompanyContactsInBatches.test.js`
Expected: PASS.

- [ ] **Step 5: Check architecture boundaries**

Run: `npx jest tests/unit/architecture/hexagonalBoundaries.test.js`
Expected: PASS (the use case only imports from `#application/...`).

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/SyncCompanyContactsInBatches.js tests/unit/application/syncCompanyContactsInBatches.test.js
git commit -m "feat: add batched company child-contact sync use case"
```

---

### Task 7: `ProcessCrmObjectBatches` use case

**Files:**
- Create: `src/application/use-cases/ProcessCrmObjectBatches.js`
- Test: `tests/unit/application/processCrmObjectBatches.test.js` (new)

**Interfaces:**
- Consumes: `hubspotBatching.utils` (Task 1); `crmBatchClient` (Task 2 shape); `associationRegistry` bulk ops (Task 3); handler helpers `getSearchProperties`/`buildBatchUpdateEntry` (Task 4); `syncCompanyContactsInBatches.execute` (Task 6); `applyBypassEmail` from `bypassEmail.service.js`; `shouldUpdateSapFromHubspot` from `#domain/sync/main-data-in-update.constants.js`.
- Produces: `execute({ mappedItems, objectType, clientConfig, tenantModels, handler, getToken, mainDataInUpdate, bypassEmail, preprocessContext, syncLogId, sequentialFallback })` → `{ ok: true, sent, failed, created, updated, skipped, errors }`. Constructor deps: `{ crmBatchClient, associationRegistry, sapHubspotIdUpdater, validationFailureWriter, findPropertyResolver, fetchFallbackAssociations = null, syncCompanyContactsInBatches = null, syncWarningRepository = null, logger = console, sleeper }`.
  - `sequentialFallback(items)` → same result shape as `processItemsSequentially` (`{ sent, failed, created, updated, errors }`). Provided per-call by `SendMappedItemsToHubspot` (Task 8).
  - `fetchFallbackAssociations({ clientConfig, objectType })` → `{ contacts, companies, products } | null` (wired to `HandleHubspotAssociations.fetchAssociationsIfNeeded` in Task 8).

**Behavioral parity notes (versus `processSingleItem` / `processItemsSequentially`):**
- Items missing `properties.email` (not bypassed) → `validationFailureWriter.write` + registry mapping with empty `hubspotId` + count as `sent` (same as today).
- `mainDataInUpdate === 'SAP'` (i.e. `shouldUpdateSapFromHubspot`): existing records call `sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot` **sequentially** (SAP-side; do not parallelize) and count `updated`.
- `mainDataInUpdate === 'HUBSPOT'`: existing records batch-update via `buildBatchUpdateEntry`; a `null` entry counts `sent + skipped` (the batch flow's more accurate analogue of the sequential `updated: 1` no-op).
- Any other `mainDataInUpdate`: existing records count `sent` only.
- Associations run for every item that ended with a HubSpot id (existing, updated, skipped, or created) — same as today.
- Read failure of BOTH batch read and search fallback → whole run degrades to `sequentialFallback` (exact product-flow behavior). Individual create/update chunk failure → `sequentialFallback(chunkItems)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/application/processCrmObjectBatches.test.js
import { jest } from '@jest/globals';
import ProcessCrmObjectBatches from '../../../src/application/use-cases/ProcessCrmObjectBatches.js';

function buildCompanyHandler() {
  return {
    preprocess: undefined,
    getSearchProperties: jest.fn().mockResolvedValue(['email', 'name', 'phone', 'idsap']),
    buildBatchUpdateEntry: jest.fn().mockReturnValue(null),
  };
}

function buildUseCase(overrides = {}) {
  return new ProcessCrmObjectBatches({
    crmBatchClient: {
      batchReadObjectsByProperty: jest.fn().mockResolvedValue({ results: [] }),
      batchCreateObjects: jest.fn().mockImplementation(async (_t, _o, { inputs }) => ({
        results: inputs.map((input, index) => ({ id: `hs-${index}`, properties: { ...input.properties } })),
      })),
      batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
      batchAssociateDefault: jest.fn().mockResolvedValue({}),
      associateObjects: jest.fn().mockResolvedValue({}),
      searchObjectsByPropertyIn: jest.fn().mockResolvedValue([]),
    },
    associationRegistry: {
      findHubspotIdsForSapIds: jest.fn().mockResolvedValue(new Map()),
      registerBaseObjectMappings: jest.fn().mockResolvedValue([]),
    },
    sapHubspotIdUpdater: {
      updateBusinessPartnerInSapFromHubspot: jest.fn().mockResolvedValue(null),
    },
    validationFailureWriter: { write: jest.fn().mockResolvedValue(null) },
    findPropertyResolver: jest.fn().mockResolvedValue('email'),
    syncCompanyContactsInBatches: { execute: jest.fn().mockResolvedValue({ contactErrors: [] }) },
    logger: { warn: jest.fn(), error: jest.fn() },
    sleeper: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

const clientConfig = { hubspotCredentialId: 'cred-1', hubspotBatchSize: 100 };
const getToken = jest.fn().mockResolvedValue('token-1');

function baseParams(useCaseOverrides = {}) {
  return {
    objectType: 'company',
    clientConfig,
    tenantModels: {},
    handler: buildCompanyHandler(),
    getToken,
    mainDataInUpdate: 'HUBSPOT',
    bypassEmail: false,
    preprocessContext: null,
    syncLogId: null,
    sequentialFallback: jest.fn().mockResolvedValue({ sent: 0, failed: 0, created: 0, updated: 0, errors: [] }),
    ...useCaseOverrides,
  };
}

describe('ProcessCrmObjectBatches', () => {
  it('batch-creates unseen companies, registers mappings and syncs child contacts', async () => {
    const useCase = buildUseCase();
    const params = baseParams();
    const mappedItems = [
      { properties: { email: 'a@x.com', idsap: 'C001', name: 'A' }, rawSapData: { CardCode: 'C001' } },
      { properties: { email: 'b@x.com', idsap: 'C002', name: 'B' }, rawSapData: { CardCode: 'C002' } },
    ];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(result).toMatchObject({ ok: true, sent: 2, created: 2, updated: 0, failed: 0 });
    expect(useCase.crmBatchClient.batchCreateObjects).toHaveBeenCalledTimes(1);
    expect(useCase.associationRegistry.registerBaseObjectMappings).toHaveBeenCalledWith(
      'cred-1',
      'company',
      expect.arrayContaining([expect.objectContaining({ sapId: 'C001' })]),
      {}
    );
    expect(useCase.syncCompanyContactsInBatches.execute).toHaveBeenCalledTimes(1);
    const { companies } = useCase.syncCompanyContactsInBatches.execute.mock.calls[0][0];
    expect(companies).toHaveLength(2);
    expect(companies[0].hubspotId).toBeTruthy();
  });

  it('skips unchanged existing records and batch-updates changed ones', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({
      results: [
        { id: 'hs-1', properties: { email: 'a@x.com', name: 'A' } },
        { id: 'hs-2', properties: { email: 'b@x.com', name: 'Old' } },
      ],
    });
    const params = baseParams();
    params.handler.buildBatchUpdateEntry
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: 'hs-2', properties: { idsap: 'C002' } });

    const mappedItems = [
      { properties: { email: 'a@x.com', idsap: 'C001', name: 'A' }, rawSapData: {} },
      { properties: { email: 'b@x.com', idsap: 'C002', name: 'New' }, rawSapData: {} },
    ];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(result).toMatchObject({ sent: 2, created: 0, updated: 1, skipped: 1, failed: 0 });
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
    expect(useCase.crmBatchClient.batchUpdateObjects).toHaveBeenCalledTimes(1);
  });

  it('updates SAP sequentially when mainDataInUpdate is SAP', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockResolvedValue({
      results: [{ id: 'hs-1', properties: { email: 'a@x.com' } }],
    });
    const params = baseParams({ mainDataInUpdate: 'SAP' });
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(useCase.sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot).toHaveBeenCalledTimes(1);
    expect(useCase.crmBatchClient.batchUpdateObjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 1, updated: 1 });
  });

  it('writes validation failures for items without email and still counts them as sent', async () => {
    const useCase = buildUseCase();
    const params = baseParams();
    const mappedItems = [{ properties: { idsap: 'C001', name: 'NoMail' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(useCase.validationFailureWriter.write).toHaveBeenCalledTimes(1);
    expect(useCase.associationRegistry.registerBaseObjectMappings).toHaveBeenCalledWith(
      'cred-1', 'company', [expect.objectContaining({ sapId: 'C001', hubspotId: '' })], {}
    );
    expect(result).toMatchObject({ sent: 1, created: 0, failed: 0 });
    expect(useCase.crmBatchClient.batchCreateObjects).not.toHaveBeenCalled();
  });

  it('falls back to search IN when batch read rejects, then to sequential when both fail', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchReadObjectsByProperty.mockRejectedValue(new Error('idProperty not unique'));
    useCase.crmBatchClient.searchObjectsByPropertyIn.mockResolvedValue([
      { id: 'hs-1', properties: { email: 'a@x.com', name: 'A' } },
    ]);
    const params = baseParams();
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001', name: 'A' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });
    expect(result).toMatchObject({ sent: 1, created: 0 });
    expect(params.sequentialFallback).not.toHaveBeenCalled();

    // Both read paths fail -> whole run degrades to sequential.
    const useCase2 = buildUseCase();
    useCase2.crmBatchClient.batchReadObjectsByProperty.mockRejectedValue(new Error('read down'));
    useCase2.crmBatchClient.searchObjectsByPropertyIn.mockRejectedValue(new Error('search down'));
    const params2 = baseParams();
    params2.sequentialFallback.mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0, errors: [] });

    const degraded = await useCase2.execute({ mappedItems, ...params2 });
    expect(params2.sequentialFallback).toHaveBeenCalledTimes(1);
    expect(degraded).toMatchObject({ sent: 1, created: 1 });
  });

  it('falls back to sequential for a failed create chunk only', async () => {
    const useCase = buildUseCase();
    useCase.crmBatchClient.batchCreateObjects.mockRejectedValue(new Error('create down'));
    const params = baseParams();
    params.sequentialFallback.mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0, errors: [] });
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(params.sequentialFallback).toHaveBeenCalledWith([mappedItems[0]]);
    expect(result).toMatchObject({ sent: 1, created: 1 });
  });

  it('associates contacts with their companies in batch for contact runs', async () => {
    const useCase = buildUseCase();
    useCase.associationRegistry.findHubspotIdsForSapIds.mockResolvedValue(new Map([['C001', 'hs-co-1']]));
    const params = baseParams({ objectType: 'contact' });
    params.handler = {
      getSearchProperties: jest.fn().mockResolvedValue(['email', 'firstname', 'phone', 'idsap', 'internalcode']),
      buildBatchUpdateEntry: jest.fn().mockReturnValue(null),
    };
    const mappedItems = [{
      properties: {
        email: 'a@x.com',
        idsap: 'P001',
        associations: { companies: ['C001'] },
      },
      rawSapData: {},
    }];

    await useCase.execute({ mappedItems, ...params });

    expect(useCase.associationRegistry.findHubspotIdsForSapIds).toHaveBeenCalledWith(
      'cred-1', 'company', ['C001'], {}
    );
    expect(useCase.crmBatchClient.batchAssociateDefault).toHaveBeenCalledWith(
      'token-1', 'contact', 'company', [{ fromId: 'hs-0', toId: 'hs-co-1' }]
    );
    expect(useCase.syncCompanyContactsInBatches.execute).not.toHaveBeenCalled();
  });

  it('merges contactErrors from the child-contact sync into errors', async () => {
    const useCase = buildUseCase({
      syncCompanyContactsInBatches: {
        execute: jest.fn().mockResolvedValue({
          contactErrors: [{ errorType: 'contactEmployee', sapContactId: 1 }],
        }),
      },
    });
    const params = baseParams();
    const mappedItems = [{ properties: { email: 'a@x.com', idsap: 'C001' }, rawSapData: {} }];

    const result = await useCase.execute({ mappedItems, ...params });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ errorType: 'contactEmployee' });
    expect(result.failed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/application/processCrmObjectBatches.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use case**

```js
// src/application/use-cases/ProcessCrmObjectBatches.js
import { shouldUpdateSapFromHubspot } from '#domain/sync/main-data-in-update.constants.js';
import { applyBypassEmail } from '#application/services/bypassEmail.service.js';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  SEARCH_FALLBACK_CONCURRENCY,
  chunkArray,
  retryRequest,
  runInWaves,
} from '#application/services/hubspotBatching.utils.js';

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getSapId(item) {
  return item?.properties?.idsap ?? null;
}

// Batched company/contact flow: batch read (idProperty) -> diff -> batch
// create/update in waves -> bulk registry -> batch associations. Mirrors
// SendMappedItemsToHubspot.processProductBatches, including its degraded
// sequential fallbacks. Flavor-agnostic: B1 and S/4 feed the same mappedItems.
export class ProcessCrmObjectBatches {
  constructor({
    crmBatchClient,
    associationRegistry,
    sapHubspotIdUpdater,
    validationFailureWriter,
    findPropertyResolver,
    fetchFallbackAssociations = null,
    syncCompanyContactsInBatches = null,
    syncWarningRepository = null,
    logger = console,
    sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.crmBatchClient = crmBatchClient;
    this.associationRegistry = associationRegistry;
    this.sapHubspotIdUpdater = sapHubspotIdUpdater;
    this.validationFailureWriter = validationFailureWriter;
    this.findPropertyResolver = findPropertyResolver;
    this.fetchFallbackAssociations = fetchFallbackAssociations;
    this.syncCompanyContactsInBatches = syncCompanyContactsInBatches;
    this.syncWarningRepository = syncWarningRepository;
    this.logger = logger;
    this.sleeper = sleeper;
  }

  retry(fn) {
    return retryRequest(fn, { sleeper: this.sleeper });
  }

  async recordWarning(payload) {
    if (!this.syncWarningRepository?.record) {
      return null;
    }

    try {
      return await this.syncWarningRepository.record(payload);
    } catch (error) {
      this.logger.error?.('Sync warning record error:', error);
      return null;
    }
  }

  mergeStats(stats, result) {
    stats.sent += result?.sent ?? 0;
    stats.failed += result?.failed ?? 0;
    stats.created += result?.created ?? 0;
    stats.updated += result?.updated ?? 0;
    stats.skipped += result?.skipped ?? 0;
    stats.errors.push(...(result?.errors ?? []));
  }

  async execute({
    mappedItems,
    objectType,
    clientConfig,
    tenantModels,
    handler,
    getToken,
    mainDataInUpdate,
    bypassEmail,
    preprocessContext = null,
    syncLogId = null,
    sequentialFallback,
  }) {
    const stats = { sent: 0, failed: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const clientConfigId = clientConfig?.id ?? clientConfig?._id ?? null;

    const preprocessed = [];
    for (const item of mappedItems ?? []) {
      try {
        if (handler.preprocess) {
          await handler.preprocess({ item, clientConfig, tenantModels, preprocessContext });
        }
        preprocessed.push(item);
      } catch (error) {
        this.logger.error?.('ProcessCrmObjectBatches preprocess error:', error);
        stats.failed += 1;
        stats.errors.push({
          payloadHubspot: item?.properties ?? null,
          responseHubspot: error?.details?.hubspotResponse ?? null,
        });
      }
    }

    // Same email validation as processSingleItem: items without email (and not
    // bypassed) are logged + registered with an empty HubSpot id and counted
    // as sent, never pushed to HubSpot.
    const syncable = [];
    const validationSkips = [];

    for (const item of preprocessed) {
      const bypassWarnings = [];
      const emailWasBypassed = applyBypassEmail({
        objectType,
        item,
        bypassEmail,
        logger: this.logger,
        onWarning: (warning) => bypassWarnings.push(warning),
      });

      for (const warning of bypassWarnings) {
        await this.recordWarning({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType,
          sapId: warning.sapId ?? item?.properties?.idsap ?? null,
          code: warning.code,
          message: warning.message,
          details: {
            source: 'mainRecord',
            email: warning.email ?? null,
          },
        });
      }

      if (!item?.properties?.email && !emailWasBypassed) {
        const identifier = String(item?.properties?.idsap ?? '').trim();
        const email = String(item?.properties?.email ?? '').trim();

        if (identifier) {
          await this.validationFailureWriter.write(`${identifier}, ${email}\n`);
        }
        validationSkips.push({ sapId: item?.properties?.idsap, hubspotId: '' });
        stats.sent += 1;
        continue;
      }

      syncable.push(item);
    }

    if (validationSkips.length > 0) {
      await this.associationRegistry.registerBaseObjectMappings(
        clientConfig.hubspotCredentialId,
        objectType,
        validationSkips.filter(({ sapId }) => sapId),
        tenantModels
      );
    }

    if (syncable.length === 0) {
      return { ok: true, ...stats };
    }

    const findProperty = await this.findPropertyResolver({ tenantModels });
    const withValue = syncable.filter((item) => normalizeKey(item?.properties?.[findProperty]));
    const withoutValue = syncable.filter((item) => !normalizeKey(item?.properties?.[findProperty]));

    let existingByKey;
    try {
      existingByKey = await this.readExisting({
        items: withValue,
        findProperty,
        objectType,
        clientConfig,
        tenantModels,
        handler,
        getToken,
      });
    } catch (error) {
      // Degraded mode: same per-item find/create/update behavior as before batching.
      this.logger.error?.('ProcessCrmObjectBatches read error:', error);
      const fallbackResult = await sequentialFallback(syncable);
      this.mergeStats(stats, fallbackResult);
      return { ok: true, ...stats };
    }

    const createEntries = withoutValue.map((item) => ({ item }));
    const updateEntries = [];
    const sapModeEntries = [];
    // sapId -> hubspotId for every item that ends the run with a HubSpot id;
    // feeds the association phase.
    const processed = [];

    for (const item of withValue) {
      const existing = existingByKey.get(normalizeKey(item.properties[findProperty]));

      if (!existing) {
        createEntries.push({ item });
        continue;
      }

      processed.push({ item, hubspotId: existing.id });

      if (shouldUpdateSapFromHubspot({ mainDataInUpdate, objectType })) {
        sapModeEntries.push({ item, existing });
      } else if (mainDataInUpdate === 'HUBSPOT') {
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

    // SAP is the system of record here: writes go to SAP one by one (SAP
    // Service Layer / Gateway does not offer a safe bulk update for this).
    for (const { item, existing } of sapModeEntries) {
      try {
        await this.sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot({
          clientConfig,
          objectType,
          item,
          existing,
          tenantModels,
        });
        stats.sent += 1;
        stats.updated += 1;
      } catch (error) {
        this.logger.error?.('ProcessCrmObjectBatches SAP update error:', error);
        stats.failed += 1;
        stats.errors.push({
          payloadHubspot: item?.properties ?? null,
          responseHubspot: error?.details?.hubspotResponse ?? null,
        });
      }
    }

    const createResults = await runInWaves(
      chunkArray(createEntries, this.writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        const chunkItems = entryChunk.map(({ item }) => item);

        try {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchCreateObjects(token, objectType, {
              inputs: chunkItems.map((item) => ({ properties: item.properties })),
            })
          );

          const results = Array.isArray(response?.results) ? response.results : [];
          const resultByKey = new Map();
          for (const result of results) {
            const key = normalizeKey(result?.properties?.[findProperty]);
            if (key && !resultByKey.has(key)) {
              resultByKey.set(key, result);
            }
          }

          const mappings = [];
          for (const [index, item] of chunkItems.entries()) {
            const created = resultByKey.get(normalizeKey(item?.properties?.[findProperty]))
              ?? results[index];

            if (created?.id) {
              processed.push({ item, hubspotId: created.id });
              const sapId = getSapId(item);
              if (sapId) {
                mappings.push({ sapId, hubspotId: created.id });
              }
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

          return { sent: chunkItems.length, created: chunkItems.length };
        } catch (error) {
          this.logger.error?.('ProcessCrmObjectBatches create error:', error);
          return sequentialFallback(chunkItems);
        }
      }
    );

    const updateResults = await runInWaves(
      chunkArray(updateEntries, this.writeChunkSize(clientConfig)),
      BATCH_CONCURRENCY,
      async (entryChunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchUpdateObjects(token, objectType, {
              inputs: entryChunk.map(({ updateInput }) => updateInput),
            })
          );

          return { sent: entryChunk.length, updated: entryChunk.length };
        } catch (error) {
          this.logger.error?.('ProcessCrmObjectBatches update error:', error);
          return sequentialFallback(entryChunk.map(({ item }) => item));
        }
      }
    );

    for (const result of [...createResults, ...updateResults]) {
      this.mergeStats(stats, result);
    }

    await this.handleAssociations({
      objectType,
      processed,
      clientConfig,
      tenantModels,
      getToken,
      syncLogId,
      stats,
    });

    return { ok: true, ...stats };
  }

  writeChunkSize(clientConfig) {
    return Math.min(
      Number(clientConfig?.hubspotBatchSize) || HUBSPOT_BATCH_INPUT_LIMIT,
      HUBSPOT_BATCH_INPUT_LIMIT
    );
  }

  // Batch read keyed by the tenant's configured find property; falls back to
  // Search IN when the property is not unique-flagged; rethrows when both fail
  // so the caller can degrade the whole run to the sequential path.
  async readExisting({ items, findProperty, objectType, clientConfig, tenantModels, handler, getToken }) {
    const existingByKey = new Map();
    const values = [...new Set(items.map((item) => String(item.properties[findProperty])))];

    if (values.length === 0) {
      return existingByKey;
    }

    const searchProperties = await handler.getSearchProperties({ clientConfig, tenantModels });
    const propertyNames = [...new Set([
      findProperty,
      ...searchProperties,
      ...items.flatMap((item) => Object.keys(item?.properties ?? {})),
    ])].filter((name) => name !== 'hs_object_id' && name !== 'associations');

    const collect = (results) => {
      for (const result of results ?? []) {
        const key = normalizeKey(result?.properties?.[findProperty]);
        if (key && !existingByKey.has(key)) {
          existingByKey.set(key, result);
        }
      }
    };

    try {
      await runInWaves(
        chunkArray(values, HUBSPOT_BATCH_INPUT_LIMIT),
        BATCH_CONCURRENCY,
        async (valueChunk) => {
          const token = await getToken();
          const response = await this.retry(() =>
            this.crmBatchClient.batchReadObjectsByProperty(token, objectType, {
              idProperty: findProperty,
              values: valueChunk,
              properties: propertyNames,
            })
          );
          collect(response?.results);
        }
      );
      return existingByKey;
    } catch (batchReadError) {
      this.logger.error?.('CRM batch read failed, falling back to search IN:', batchReadError);
    }

    existingByKey.clear();
    await runInWaves(
      chunkArray(values, HUBSPOT_BATCH_INPUT_LIMIT),
      SEARCH_FALLBACK_CONCURRENCY,
      async (valueChunk) => {
        const token = await getToken();
        const results = await this.retry(() =>
          this.crmBatchClient.searchObjectsByPropertyIn(token, objectType, findProperty, valueChunk, propertyNames)
        );
        collect(results);
      }
    );
    return existingByKey;
  }

  async handleAssociations({ objectType, processed, clientConfig, tenantModels, getToken, syncLogId, stats }) {
    if (processed.length === 0) {
      return;
    }

    if (objectType === 'contact') {
      await this.associateWithRegistry({
        processed,
        targetObjectType: 'company',
        pickTargets: (item) => item?.properties?.associations?.companies ?? [],
        fromObjectType: 'contact',
        toObjectType: 'company',
        clientConfig,
        tenantModels,
        getToken,
      });
      return;
    }

    if (objectType === 'company') {
      await this.associateWithRegistry({
        processed,
        targetObjectType: 'contact',
        pickTargets: (item) => item?.properties?.associations?.contacts ?? [],
        fromObjectType: 'company',
        toObjectType: 'contact',
        clientConfig,
        tenantModels,
        getToken,
      });

      if (this.syncCompanyContactsInBatches) {
        const { contactErrors } = await this.syncCompanyContactsInBatches.execute({
          companies: processed,
          clientConfig,
          tenantModels,
          getToken,
          syncLogId,
        });

        if (Array.isArray(contactErrors) && contactErrors.length > 0) {
          stats.errors.push(...contactErrors);
        }
      }
    }
  }

  // Resolves SAP ids to HubSpot ids with ONE registry query and associates in
  // 100-pair batches. Association failures are logged, never fatal (parity
  // with associationService's per-pair behavior).
  async associateWithRegistry({
    processed,
    targetObjectType,
    pickTargets,
    fromObjectType,
    toObjectType,
    clientConfig,
    tenantModels,
    getToken,
  }) {
    let fallbackTargets = null;
    let fallbackFetched = false;

    const wanted = [];
    for (const { item, hubspotId } of processed) {
      let targets = pickTargets(item);

      if ((!Array.isArray(targets) || targets.length === 0) && clientConfig.associationFetchEnabled) {
        // The per-item flow refetches this for every empty item; the batch
        // flow fetches once per run and reuses it (same resulting targets).
        if (!fallbackFetched && this.fetchFallbackAssociations) {
          const aggregated = await this.fetchFallbackAssociations({
            clientConfig,
            objectType: fromObjectType,
          });
          fallbackTargets = aggregated?.[`${targetObjectType === 'company' ? 'companies' : 'contacts'}`] ?? null;
          fallbackFetched = true;
        }
        targets = fallbackTargets ?? [];
      }

      for (const target of targets ?? []) {
        const sapId = target?.sapId ?? target;
        if (sapId) {
          wanted.push({ hubspotId, sapId: String(sapId) });
        }
      }
    }

    if (wanted.length === 0) {
      return;
    }

    const uniqueSapIds = [...new Set(wanted.map(({ sapId }) => sapId))];
    const targetIdBySapId = await this.associationRegistry.findHubspotIdsForSapIds(
      clientConfig.hubspotCredentialId,
      targetObjectType,
      uniqueSapIds,
      tenantModels
    );

    const pairs = [];
    const seen = new Set();
    for (const { hubspotId, sapId } of wanted) {
      const targetHubspotId = targetIdBySapId.get(sapId);
      const pairKey = `${hubspotId}:${targetHubspotId}`;

      if (targetHubspotId && !seen.has(pairKey)) {
        seen.add(pairKey);
        pairs.push({ fromId: hubspotId, toId: targetHubspotId });
      }
    }

    await runInWaves(
      chunkArray(pairs, HUBSPOT_BATCH_INPUT_LIMIT),
      BATCH_CONCURRENCY,
      async (pairChunk) => {
        try {
          const token = await getToken();
          await this.retry(() =>
            this.crmBatchClient.batchAssociateDefault(token, fromObjectType, toObjectType, pairChunk)
          );
        } catch (error) {
          this.logger.error?.('Batch association failed, falling back per pair:', error);
          for (const { fromId, toId } of pairChunk) {
            try {
              const token = await getToken();
              await this.crmBatchClient.associateObjects(token, fromObjectType, fromId, toObjectType, toId);
            } catch (pairError) {
              this.logger.error?.('Failed to associate objects', {
                fromObjectType,
                fromId,
                toObjectType,
                toId,
                error: pairError,
              });
            }
          }
        }
      }
    );
  }
}

export default ProcessCrmObjectBatches;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/application/processCrmObjectBatches.test.js`
Expected: PASS.

- [ ] **Step 5: Check architecture boundaries**

Run: `npx jest tests/unit/architecture/hexagonalBoundaries.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/ProcessCrmObjectBatches.js tests/unit/application/processCrmObjectBatches.test.js
git commit -m "feat: add batched company/contact HubSpot sync use case"
```

---

### Task 8: Gate in `SendMappedItemsToHubspot` + composition wiring

**Files:**
- Modify: `src/application/use-cases/SendMappedItemsToHubspot.js` (constructor + `execute`, insert the gate after the product branch at ~line 143)
- Modify: `src/composition/hubspot-sync.composition.js`
- Test: extend `tests/unit/application/sendMappedItemsToHubspot.test.js`; `tests/unit/composition/sapSyncComposition.test.js` must keep passing.

**Interfaces:**
- Consumes: `ProcessCrmObjectBatches` (Task 7), `SyncCompanyContactsInBatches` (Task 6), `hubspotCrmBatchAdapter` (Task 2), `getConfiguredFindProperty` (Task 4), `HandleHubspotAssociations.fetchAssociationsIfNeeded` (existing).
- Produces: company/contact runs route through `crmBatchProcessor.execute` when `Number(clientConfig.hubspotBatchSize) > 1` AND the processor was injected; otherwise the sequential path runs unchanged (so every existing test without the new dependency keeps its behavior).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/application/sendMappedItemsToHubspot.test.js` (reuse its `buildUseCase` helper):

```js
describe('CRM batch gate', () => {
  it('routes company runs to the crmBatchProcessor when hubspotBatchSize > 1', async () => {
    const crmBatchProcessor = {
      execute: jest.fn().mockResolvedValue({ ok: true, sent: 2, failed: 0, created: 2, updated: 0, skipped: 0, errors: [] }),
    };
    const handler = { find: jest.fn(), create: jest.fn(), update: jest.fn() };
    const useCase = buildUseCase({ handlers: { company: handler }, crmBatchProcessor });

    const result = await useCase.execute({
      mappedItems: [{ properties: { email: 'a@x.com' } }, { properties: { email: 'b@x.com' } }],
      clientConfig: { hubspotCredentialId: 'cred-1', hubspotBatchSize: 100 },
      objectType: 'company',
      tenantModels: {},
      credentials: { _id: 'cred-1' },
    });

    expect(crmBatchProcessor.execute).toHaveBeenCalledTimes(1);
    expect(handler.find).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, sent: 2, created: 2 });
    const callArgs = crmBatchProcessor.execute.mock.calls[0][0];
    expect(typeof callArgs.sequentialFallback).toBe('function');
    expect(callArgs.objectType).toBe('company');
  });

  it('keeps the sequential path when hubspotBatchSize is not set', async () => {
    const crmBatchProcessor = { execute: jest.fn() };
    const handler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-1' }),
      update: jest.fn(),
    };
    const useCase = buildUseCase({ handlers: { company: handler }, crmBatchProcessor });

    await useCase.execute({
      mappedItems: [{ properties: { email: 'a@x.com', idsap: 'C1' } }],
      clientConfig: { hubspotCredentialId: 'cred-1' },
      objectType: 'company',
      tenantModels: {},
      credentials: { _id: 'cred-1' },
    });

    expect(crmBatchProcessor.execute).not.toHaveBeenCalled();
    expect(handler.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the sequential path when no crmBatchProcessor is injected', async () => {
    const handler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-1' }),
      update: jest.fn(),
    };
    const useCase = buildUseCase({ handlers: { contact: handler } });

    await useCase.execute({
      mappedItems: [{ properties: { email: 'a@x.com', idsap: 'P1' } }],
      clientConfig: { hubspotCredentialId: 'cred-1', hubspotBatchSize: 100 },
      objectType: 'contact',
      tenantModels: {},
      credentials: { _id: 'cred-1' },
    });

    expect(handler.create).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx jest tests/unit/application/sendMappedItemsToHubspot.test.js`
Expected: the three new tests FAIL (gate not implemented), pre-existing tests PASS.

- [ ] **Step 3: Implement the gate**

In the constructor, accept and store `crmBatchProcessor = null`. In `execute`, insert after the product branch (after line ~143) :

```js
    if (
      (objectType === 'company' || objectType === 'contact')
      && Number(clientConfig?.hubspotBatchSize) > 1
      && this.crmBatchProcessor
    ) {
      const mainDataInUpdate = await this.getMainDataInUpdate(tenantModels);
      const bypassEmail = await this.getBypassEmail({ objectType, tenantModels });
      const preprocessContext = handler?.buildPreprocessContext
        ? await handler.buildPreprocessContext({ clientConfig, tenantModels })
        : null;

      return this.crmBatchProcessor.execute({
        mappedItems,
        objectType,
        clientConfig,
        tenantModels,
        handler,
        getToken,
        mainDataInUpdate,
        bypassEmail,
        preprocessContext,
        syncLogId,
        sequentialFallback: (items) => this.processItemsSequentially(items, {
          objectType,
          clientConfig,
          tenantModels,
          handler,
          getToken,
          mainDataInUpdate,
          bypassEmail,
          syncLogId,
          preprocessContext,
        }),
      });
    }
```

- [ ] **Step 4: Wire the composition**

In `src/composition/hubspot-sync.composition.js`:

```js
import ProcessCrmObjectBatches from '#application/use-cases/ProcessCrmObjectBatches.js';
import SyncCompanyContactsInBatches from '#application/use-cases/SyncCompanyContactsInBatches.js';
import hubspotCrmBatchAdapter from '#infrastructure/hubspot/hubspot-crm-batch.adapter.js';
import { getConfiguredFindProperty } from '#infrastructure/hubspot/handlers/utils/searchCriteria.utils.js';
import { generateFallbackEmail } from '#infrastructure/hubspot/utils/email.utils.js';
import FieldMappingService from '#application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
```

Inside `buildSendMappedItemsToHubspot()` (before the `return`):

```js
  const findPropertyResolver = ({ tenantModels }) => getConfiguredFindProperty({ tenantModels });

  const syncCompanyContactsInBatches = new SyncCompanyContactsInBatches({
    crmBatchClient: hubspotCrmBatchAdapter,
    contactHandler,
    associationRegistry: associationRegistryService,
    fieldMappingService: new FieldMappingService({
      fieldMappingRepository: new TenantFieldMappingRepository(),
    }),
    fallbackEmailGenerator: generateFallbackEmail,
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
    findPropertyResolver,
    fetchFallbackAssociations: ({ clientConfig, objectType }) =>
      handleHubspotAssociations.fetchAssociationsIfNeeded(clientConfig, objectType),
    syncCompanyContactsInBatches,
    syncWarningRepository: new MongooseSyncWarningRepository(),
    logger,
  });
```

Note: `buildHandleHubspotAssociations()` currently returns the instance used only through the `associationHandler` closure; keep a reference (`const handleHubspotAssociations = buildHandleHubspotAssociations();` already exists at line 37 — reuse that variable) and pass `crmBatchProcessor` into the `SendMappedItemsToHubspot` constructor options.

- [ ] **Step 5: Run the touched tests**

Run: `npx jest tests/unit/application/sendMappedItemsToHubspot.test.js tests/unit/application/sendMappedItemsToHubspot.emailBypass.test.js tests/unit/composition/sapSyncComposition.test.js tests/unit/hubspotSyncAdapter.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/SendMappedItemsToHubspot.js src/composition/hubspot-sync.composition.js tests/unit/application/sendMappedItemsToHubspot.test.js
git commit -m "feat: route company/contact syncs through the batch processor when hubspotBatchSize > 1"
```

---

### Task 9: Final verification (touched files only)

- [ ] **Step 1: Run every test file touched by this plan in one command**

```bash
npx jest tests/unit/application/hubspotBatchingUtils.test.js tests/unit/application/sendMappedItemsToHubspot.test.js tests/unit/application/sendMappedItemsToHubspot.emailBypass.test.js tests/unit/infrastructure/associationRegistryService.test.js tests/unit/companyHandler.test.js tests/unit/contactHandler.test.js tests/unit/application/companyContactPayload.test.js tests/unit/application/syncCompanyContactsS4.test.js tests/unit/application/handleHubspotAssociations.emailBypass.test.js tests/unit/application/syncCompanyContactsInBatches.test.js tests/unit/application/processCrmObjectBatches.test.js tests/unit/architecture/hexagonalBoundaries.test.js tests/unit/composition/sapSyncComposition.test.js tests/unit/hubspotSyncAdapter.test.js
```

Expected: ALL PASS.

- [ ] **Step 2: Commit any leftover changes**

```bash
git status
git add -A docs/superpowers/plans/2026-07-29-hubspot-crm-batch-sync.md
git commit -m "docs: hubspot crm batch sync plan"
```

---

## Rollout & Operational Notes (no code)

- **Enablement per tenant:** the feature turns on with the existing `clientConfig.hubspotBatchSize` (> 1), the same switch products use — no new configuration.
- **Fast path requirement:** batch read needs the tenant's configured find property (`DefaultFindHubspotConfig`, default `email`) to be a **unique-value property** in the HubSpot portal (contacts' `email` qualifies natively; for companies a custom `idsap` property must be created with "unique value" checked). If it is not unique, the flow still works through the Search `IN` fallback — slower (~4 req/s) but still batched, ~100× fewer calls than today.
- **Expected numbers for the 9k-company run:** ~90 batch reads + ~90 batch writes + ~200 contact batch calls + ~200 association batches + a handful of Mongo bulk ops ≈ **600–800 HTTP calls vs ~40,000+ today** → minutes instead of 4 hours.
- **First run after deploy** will look like mostly `skipped` (records already exist and key fields unchanged) — that is correct and fast.
