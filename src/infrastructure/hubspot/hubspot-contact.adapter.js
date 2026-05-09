import { createContact, findContactByEmail, updateContact } from './hubspotClient.js';

export const hubspotContactAdapter = Object.freeze({
  createContact,
  findContactByEmail,
  updateContact,
});

export default hubspotContactAdapter;

