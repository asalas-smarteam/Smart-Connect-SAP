import axios from 'axios';

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

function buildHubspotError(error, operation) {
  const status = error.response?.status;
  const statusText = error.response?.statusText;
  const message = `HubSpot ${operation} request failed: ${status ?? 'unknown'} ${statusText ?? ''}`.trim();

  const wrappedError = new Error(message);
  wrappedError.cause = error;
  wrappedError.details = {
    operation,
    status,
    statusText,
    response: error.response?.data ?? null,
  };

  return wrappedError;
}

async function hubspotGet(accessToken, path, params = {}) {
  try {
    const response = await axios.get(`${HUBSPOT_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params,
    });

    return response.data;
  } catch (error) {
    throw buildHubspotError(error, `GET ${path}`);
  }
}

async function hubspotPost(accessToken, path, data) {
  try {
    const response = await axios.post(`${HUBSPOT_BASE_URL}${path}`, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return response.data;
  } catch (error) {
    throw buildHubspotError(error, `POST ${path}`);
  }
}

async function fetchPaginatedResults(accessToken, path) {
  const results = [];
  let after = undefined;

  do {
    const response = await hubspotGet(accessToken, path, {
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

export async function fetchDealPipelines(accessToken) {
  const pipelines = await fetchPaginatedResults(accessToken, '/crm/v3/pipelines/deals');

  return pipelines.map((pipeline) => ({
    hubspotPipelineId: String(pipeline.id),
    hubspotPipelineLabel: pipeline.label ?? null,
  }));
}

export async function fetchDealStages(accessToken, pipelineId) {
  const response = await hubspotGet(accessToken, `/crm/v3/pipelines/deals/${pipelineId}`);
  const stages = Array.isArray(response?.stages) ? response.stages : [];

  return stages.map((stage) => ({
    hubspotPipelineId: String(pipelineId),
    hubspotStageId: String(stage.id),
    hubspotStageLabel: stage.label ?? null,
  }));
}

export async function fetchOwners(accessToken) {
  const owners = await fetchPaginatedResults(accessToken, '/crm/v3/owners');

  return owners.map((owner) => ({
    hubspotOwnerId: String(owner.id),
    hubspotOwnerEmail: owner.email ?? null,
    hubspotOwnerName: [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim() || owner.email || null,
  }));
}

export async function ensureObjectProperty(accessToken, {
  objectType,
  name,
  label,
  type = 'string',
  fieldType = 'text',
  groupName,
}) {
  const groupByObjectType = {
    contacts: 'contactinformation',
    companies: 'companyinformation',
  };

  try {
    const existing = await hubspotGet(accessToken, `/crm/v3/properties/${objectType}/${name}`);
    return {
      created: false,
      objectType,
      name,
      property: existing,
    };
  } catch (error) {
    if (error?.details?.status !== 404) {
      throw error;
    }
  }

  const created = await hubspotPost(accessToken, `/crm/v3/properties/${objectType}`, {
    name,
    label,
    type,
    fieldType,
    groupName: groupName || groupByObjectType[objectType] || 'contactinformation',
  });

  return {
    created: true,
    objectType,
    name,
    property: created,
  };
}
