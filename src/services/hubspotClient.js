import axios from 'axios';

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

async function searchObject(token, objectType, filters) {
  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/${objectType}/search`,
    {
      filterGroups: [
        {
          filters,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data?.results?.[0] ?? null;
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

export async function createContact(token, properties) {
  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts`,
    {properties},
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
}

export async function updateContact(token, id, data) {
  const response = await axios.patch(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${id}`,
    data,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
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
  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/companies`,
    data,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
}

export async function updateCompany(token, id, data) {
  const response = await axios.patch(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/companies/${id}`,
    data,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
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
  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/deals`,
    data,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
}

export async function updateDeal(token, id, data) {
  const response = await axios.patch(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/deals/${id}`,
    data,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
}

export async function batchCreate(token, dataArray) {
  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/batch/create`,
    dataArray,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
}

export async function batchUpdate(token, dataArray) {
  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/batch/update`,
    dataArray,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
}
