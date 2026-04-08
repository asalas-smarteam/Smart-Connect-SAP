import * as hubspotClient from '../../hubspotClient.js';

export async function find({ token, item }) {
  const email = item?.properties?.email;

  if (!email) {
    return null;
  }

  return hubspotClient.findContactByEmail(token, email);
}

export async function create({ token, item }) {
  return hubspotClient.createContact(token, item);
}

export async function update({ token, id, item }) {
  return hubspotClient.updateContact(token, id, item);
}

export default {
  find,
  create,
  update,
};
