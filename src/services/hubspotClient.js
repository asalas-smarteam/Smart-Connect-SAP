import axios from 'axios';
import logger from '../core/logger.js';

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

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

async function hubspotRequest(method, endpoint, token, data) {
  try {
    const response = await axios({
      method,
      url: `${HUBSPOT_BASE_URL}${endpoint}`,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  } catch (error) {
    const errorDetails = buildErrorDetails(error, endpoint, method);

    logger.error({
      message: 'HubSpot API request failed',
      ...errorDetails,
    });

    const wrappedError = new Error(
      `HubSpot API request failed: ${errorDetails.status ?? 'unknown status'} ${
        errorDetails.statusText ?? ''
      }`.trim(),
    );
    wrappedError.cause = error;
    wrappedError.details = errorDetails;
    throw wrappedError;
  }
}

async function searchObject(token, objectType, filters) {
  const response = await hubspotRequest(
    'post',
    `/crm/v3/objects/${objectType}/search`,
    token,
    {
      filterGroups: [
        {
          filters,
        },
      ],
    },
  );

  return response?.results?.[0] ?? null;
}

export async function findContactByEmail(token, email) {
  return searchObject(token, 'contacts', [
    {
      propertyName: 'email',
      operator: 'EQ',
      value: email,
    },
  ]);
}

export async function createContact(token, data) {
  return hubspotRequest('post', '/crm/v3/objects/contacts', token, data);
}

export async function updateContact(token, id, data) {
  return hubspotRequest('patch', `/crm/v3/objects/contacts/${id}`, token, data);
}

export async function findCompanyByDomain(token, domain) {
  return searchObject(token, 'companies', [
    {
      propertyName: 'domain',
      operator: 'EQ',
      value: domain,
    },
  ]);
}

export async function createCompany(token, data) {
  return hubspotRequest('post', '/crm/v3/objects/companies', token, data);
}

export async function updateCompany(token, id, data) {
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

export async function createDeal(token, data) {
  return hubspotRequest('post', '/crm/v3/objects/deals', token, data);
}

export async function updateDeal(token, id, data) {
  return hubspotRequest('patch', `/crm/v3/objects/deals/${id}`, token, data);
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
