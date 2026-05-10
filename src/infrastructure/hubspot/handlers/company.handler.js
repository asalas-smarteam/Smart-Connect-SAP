import * as hubspotClient from '../hubspotClient.js';
import {
  buildIdentifierOnlyPayload,
  shouldUpdateByKeyFields,
} from './utils/updateDecision.utils.js';
import { buildMappedSearchProperties } from './utils/searchProperties.utils.js';

const COMPANY_SEARCH_PROPERTIES = [
  'email',
  'name',
  'phone',
  'idsap',
  'idSap',
];

export async function find({ token, item, clientConfig, tenantModels }) {
  const email = item?.properties?.email;

  if (!email) {
    return null;
  }

  const properties = await buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'company',
    defaults: COMPANY_SEARCH_PROPERTIES,
  });

  return hubspotClient.findCompanyByEmail(token, email, {
    properties,
  });
}

export async function create({ token, item }) {
  return hubspotClient.createCompany(token, item);
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
      nameField: 'name',
    })
  ) {
    return existing;
  }

  return hubspotClient.updateCompany(token, id, payload);
}

export default {
  find,
  create,
  update,
};
