import {
  fetchDealPipelines as fetchDealPipelinesClient,
  fetchDealStages as fetchDealStagesClient,
  fetchOwners as fetchOwnersClient,
  hubspotGet,
  hubspotPost,
} from '../hubspotClient.js';

export async function fetchDealPipelines(accessToken) {
  return fetchDealPipelinesClient(accessToken);
}

export async function fetchDealStages(accessToken, pipelineId) {
  return fetchDealStagesClient(accessToken, pipelineId);
}

export async function fetchOwners(accessToken) {
  return fetchOwnersClient(accessToken);
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
