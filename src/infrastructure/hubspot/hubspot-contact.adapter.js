import { createContact, findContactByEmail, updateContact } from '../../services/hubspotClient.js';

export const hubspotContactAdapter = Object.freeze({
  createContact,
  findContactByEmail,
  updateContact,
});

export default hubspotContactAdapter;

