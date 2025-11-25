import axios from 'axios';

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

export async function createContact(token, data) {
  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts`,
    data,
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
