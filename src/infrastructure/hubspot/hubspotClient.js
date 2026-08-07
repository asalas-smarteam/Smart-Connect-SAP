import axios from 'axios';
import { sendWithRateLimit } from './hubspotTransport.js';
import logger from '../logger/logger.js';

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

// 15s was too tight for a 100-input batch: the timeouts it produced left the
// outcome unknown, and the old code answered by replaying the create.
const DEFAULT_TIMEOUT_MS = Number(process.env.HUBSPOT_REQUEST_TIMEOUT_MS) || 30000;
const BATCH_TIMEOUT_MS = Number(process.env.HUBSPOT_BATCH_TIMEOUT_MS) || 60000;

function timeoutFor(endpoint) {
  return /\/batch\//.test(String(endpoint ?? '')) ? BATCH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function buildErrorDetails(error, endpoint, method) {
  return {
    endpoint,
    method: method.toUpperCase(),
    status: error.response?.status,
    statusText: error.response?.statusText,
    message: error.message,
    hubspotResponse: error.response?.data,
  };
}

// `expectedStatuses` are statuses the caller drives a decision from rather than
// treating as failures (a 409 while bisecting a conflicting chunk). They still
// throw -- only the log level changes, so a healthy run does not report hundreds
// of errors and bury the ones that need a human.
async function hubspotRequest(method, endpoint, token, data, { expectedStatuses = [] } = {}) {
  try {
    // Every call is rate limited and retried here, so no call site can forget
    // to. Logging stays outside: sendWithRateLimit only throws once its retries
    // are spent, so a 429 that resolves on retry no longer logs as a failure.
    return await sendWithRateLimit(async () => {
      const response = await axios({
        method,
        url: `${HUBSPOT_BASE_URL}${endpoint}`,
        data,
        params: method.toLowerCase() === 'get' ? data : undefined,
        timeout: timeoutFor(endpoint),
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      return response.data;
    }, { method, endpoint });
  } catch (error) {
    const errorDetails = buildErrorDetails(error, endpoint, method);
    const expected = expectedStatuses.includes(errorDetails.status);

    // `errorDetails.message` carries axios' own text and wins the spread, so the
    // level plus this flag are what distinguish the two cases in the log.
    logger[expected ? 'warn' : 'error']({
      message: 'HubSpot API request failed',
      ...errorDetails,
      ...(expected ? { expectedStatus: true } : {}),
    });

    const wrappedError = new Error(
      `HubSpot API request failed: ${errorDetails.status ?? 'unknown status'} ${
        errorDetails.statusText ?? ''
      }`.trim(),
    );
    wrappedError.cause = error;
    wrappedError.details = errorDetails;
    // Preserved across the wrap: callers decide between reconciling and
    // replaying based on whether the write may already have landed.
    wrappedError.outcomeUnknown = error?.outcomeUnknown === true;
    throw wrappedError;
  }
}

async function fetchPaginatedResults(token, path) {
  const results = [];
  let after;

  do {
    // eslint-disable-next-line no-await-in-loop
    const response = await hubspotGet(token, path, {
      ...(after ? { after } : {}),
      limit: 100,
    });

    if (Array.isArray(response?.results)) {
      results.push(...response.results);
    }

    after = response?.paging?.next?.after;
  } while (after);

  return results;
}

export async function hubspotGet(token, path, params = {}) {
  return hubspotRequest('get', path, token, params);
}

export async function hubspotPost(token, path, data) {
  return hubspotRequest('post', path, token, data);
}

export async function hubspotPatch(token, path, data) {
  return hubspotRequest('patch', path, token, data);
}

async function searchObject(token, objectType, filters, properties = []) {
  const payload = {
    filterGroups: [
      {
        filters,
      },
    ],
  };

  if (Array.isArray(properties) && properties.length > 0) {
    payload.properties = properties;
  }

  const response = await hubspotRequest(
    'post',
    `/crm/v3/objects/${objectType}/search`,
    token,
    payload,
  );

  return response?.results?.[0] ?? null;
}

export async function findContactByEmail(token, email, options = {}) {
  return findContactByProperty(token, 'email', email, options);
}

export async function findContactByProperty(token, propertyName, value, options = {}) {
  return searchObject(token, 'contacts', [
    {
      propertyName,
      operator: 'EQ',
      value,
    },
  ], options?.properties);
}

export async function createContact(token, data) {
  return hubspotRequest('post', '/crm/v3/objects/contacts', token, data);
}

export async function updateContact(token, id, data) {
  delete data.properties?.hs_object_id; // Prevent updating hs_object_id to avoid conflicts
  return hubspotRequest('patch', `/crm/v3/objects/contacts/${id}`, token, data);
}

export async function findCompanyByEmail(token, email, options = {}) {
  return findCompanyByProperty(token, 'email', email, options);
}

export async function findCompanyByProperty(token, propertyName, value, options = {}) {
  return searchObject(token, 'companies', [
    {
      propertyName,
      operator: 'EQ',
      value,
    },
  ], options?.properties);
}

export async function createCompany(token, data) {
  return hubspotRequest('post', '/crm/v3/objects/companies', token, data);
}

export async function updateCompany(token, id, data) {
  delete data.properties?.hs_object_id; // Prevent updating hs_object_id to avoid conflicts
  return hubspotRequest('patch', `/crm/v3/objects/companies/${id}`, token, data);
}

export async function findDealByName(token, dealName) {
  return searchObject(token, 'deals', [
    {
      propertyName: 'dealname',
      operator: 'EQ',
      value: dealName,
    },
  ]);
}

export async function findDealByProperty(token, propertyName, value, options = {}) {
  return searchObject(token, 'deals', [
    {
      propertyName,
      operator: 'EQ',
      value,
    },
  ], options?.properties);
}

export async function createDeal(token, data) {
  return hubspotRequest('post', '/crm/v3/objects/deals', token, data);
}

export async function updateDeal(token, id, data) {
  delete data.properties?.hs_object_id; // Prevent updating hs_object_id to avoid conflicts
  return hubspotRequest('patch', `/crm/v3/objects/deals/${id}`, token, data);
}

export async function createNote(token, { body, timestamp } = {}) {
  return hubspotRequest('post', '/crm/v3/objects/notes', token, {
    properties: {
      hs_timestamp: timestamp ?? Date.now(),
      hs_note_body: body,
    },
  });
}

export async function findProductBySKU(token, sku) {
  return searchObject(token, 'products', [
    {
      propertyName: 'hs_sku',
      operator: 'EQ',
      value: sku,
    },
  ]);
}

export async function createProduct(token, data) {
  return hubspotRequest('post', '/crm/v3/objects/products', token, data);
}

export async function updateProduct(token, id, data) {
  delete data.properties?.hs_object_id; // Prevent updating hs_object_id to avoid conflicts
  return hubspotRequest('patch', `/crm/v3/objects/products/${id}`, token, data);
}

export async function batchCreateProducts(token, data) {
  return hubspotRequest(
    'post',
    '/crm/v3/objects/products/batch/create',
    token,
    data,
  );
}

export async function batchUpdateProducts(token, data) {
  data?.inputs?.forEach((item) => {
    delete item?.properties?.hs_object_id;
  });

  return hubspotRequest(
    'post',
    '/crm/v3/objects/products/batch/update',
    token,
    data,
  );
}

// Reads up to 100 products keyed by hs_sku. Missing SKUs are reported by HubSpot in
// `errors` (207 Multi-Status), not as a request failure — callers treat absence from
// `results` as "does not exist".
export async function batchReadProductsBySku(token, skus, properties = []) {
  return hubspotRequest(
    'post',
    '/crm/v3/objects/products/batch/read',
    token,
    {
      idProperty: 'hs_sku',
      inputs: skus.map((sku) => ({ id: String(sku) })),
      ...(Array.isArray(properties) && properties.length > 0 ? { properties } : {}),
    },
  );
}

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
    // Retried at the transport layer, per PAGE: a 429 on page 50 of 57 must not
    // discard the 50 pages already fetched and re-issue them, which would both
    // add rate pressure and, after enough restarts, degrade the run to the
    // per-item path the index exists to avoid.
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

  if (after) {
    throw new Error(
      `listAllObjects(${objectType}) stopped at the ${maxPages}-page guard with more pages pending; `
      + 'refusing to return a partial index because missing records would be re-created as duplicates'
    );
  }

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

export async function batchCreateObjects(token, objectType, data, options = {}) {
  return hubspotRequest(
    'post',
    `/crm/v3/objects/${crmCollection(objectType)}/batch/create`,
    token,
    data,
    options,
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

export async function batchCreate(token, dataArray) {
  return hubspotRequest(
    'post',
    '/crm/v3/objects/contacts/batch/create',
    token,
    dataArray,
  );
}

export async function batchUpdate(token, dataArray) {
  return hubspotRequest(
    'post',
    '/crm/v3/objects/contacts/batch/update',
    token,
    dataArray,
  );
}

// Routed through hubspotRequest rather than raw axios so it is rate limited too:
// this is the per-pair fallback of the association batch, so it runs in exactly
// the tight loops that need throttling most.
export async function associateObjects(token, fromType, fromId, toType, toId) {
  return hubspotRequest(
    'put',
    `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`,
    token,
    [],
  );
}

export async function createLineItem(token, properties) {
  return hubspotRequest('post', '/crm/v3/objects/line_items', token, properties);
}

export async function batchUpdateLineItems(token, data) {
  return hubspotRequest(
    'post',
    '/crm/v3/objects/line_items/batch/update',
    token,
    data,
  );
}

export async function fetchDealPipelines(token) {
  const pipelines = await fetchPaginatedResults(token, '/crm/v3/pipelines/deals');

  return pipelines.map((pipeline) => ({
    hubspotPipelineId: String(pipeline.id),
    hubspotPipelineLabel: pipeline.label ?? null,
  }));
}

export async function fetchDealStages(token, pipelineId) {
  const response = await hubspotGet(token, `/crm/v3/pipelines/deals/${pipelineId}`);
  const stages = Array.isArray(response?.stages) ? response.stages : [];

  return stages.map((stage) => ({
    hubspotPipelineId: String(pipelineId),
    hubspotStageId: String(stage.id),
    hubspotStageLabel: stage.label ?? null,
  }));
}

export async function fetchOwners(token) {
  const owners = await fetchPaginatedResults(token, '/crm/v3/owners');

  return owners.map((owner) => ({
    hubspotOwnerId: String(owner.id),
    hubspotOwnerEmail: owner.email ?? null,
    hubspotOwnerName: [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim() || owner.email || null,
  }));
}
