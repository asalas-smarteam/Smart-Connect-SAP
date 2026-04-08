import * as hubspotClient from '../../hubspotClient.js';

export async function find({ token, item }) {
  const email = item?.properties?.email;

  if (!email) {
    return null;
  }

  return hubspotClient.findCompanyByEmail(token, email);
}

export async function create({ token, item }) {
  return hubspotClient.createCompany(token, item);
}

export async function update({ token, id, item }) {
  return hubspotClient.updateCompany(token, id, item);
}

export default {
  find,
  create,
  update,
};
