import * as hubspotClient from '../hubspotClient.js';
import {
  buildIdentifierOnlyPayload,
  shouldUpdateByKeyFields,
} from './utils/updateDecision.utils.js';
import { buildMappedSearchProperties } from './utils/searchProperties.utils.js';

const CONTACT_SEARCH_PROPERTIES = [
  'email',
  'firstname',
  'phone',
  'idsap',
  'idSap',
  'internalcode',
];

export async function find({ token, item, clientConfig, tenantModels }) {
  const email = item?.properties?.email;

  if (!email) {
    return null;
  }

  const properties = await buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'contact',
    defaults: CONTACT_SEARCH_PROPERTIES,
  });

  return hubspotClient.findContactByEmail(token, email, {
    properties,
  });
}

export async function create({ token, item }) {
  return hubspotClient.createContact(token, item);
}

export async function update({ token, id, item, existing }) {
  const properties = item?.properties ?? {};
  const payload = buildIdentifierOnlyPayload(properties);

  if (!payload) {
    return existing ?? null;
  }

  if (
    existing
    && !shouldUpdateByKeyFields({
      existingProperties: existing?.properties,
      incomingProperties: properties,
      nameField: 'firstname',
    })
  ) {
    return existing;
  }

  return hubspotClient.updateContact(token, id, payload);
}

export default {
  find,
  create,
  update,
};
