import * as hubspotClient from '../hubspotClient.js';
import {
  buildUpdatePayload,
  resolveHubspotUpdateFields,
  shouldUpdateByKeyFields,
} from './utils/updateDecision.utils.js';
import { buildMappedSearchProperties } from './utils/searchProperties.utils.js';
import { buildConfiguredSearchCriteria } from './utils/searchCriteria.utils.js';

const COMPANY_SEARCH_PROPERTIES = [
  'email',
  'name',
  'phone',
  'idsap',
  'idSap',
];

export async function find({ token, item, clientConfig, tenantModels }) {
  const searchCriteria = await buildConfiguredSearchCriteria({ item, tenantModels });

  if (!searchCriteria) {
    return null;
  }

  const properties = await buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'company',
    defaults: COMPANY_SEARCH_PROPERTIES,
  });

  if (searchCriteria.propertyName === 'email') {
    return hubspotClient.findCompanyByEmail(token, searchCriteria.value, {
      properties,
    });
  }

  return hubspotClient.findCompanyByProperty(
    token,
    searchCriteria.propertyName,
    searchCriteria.value,
    { properties }
  );
}

export async function create({ token, item }) {
  return hubspotClient.createCompany(token, item);
}

export async function update({ token, id, item, existing, tenantModels, updateFields }) {
  const properties = item?.properties ?? {};
  const fields = await resolveHubspotUpdateFields({
    tenantModels,
    objectType: 'company',
    updateFields,
  });
  const payload = buildUpdatePayload(properties, fields);

  if (!payload) {
    return existing ?? null;
  }

  if (
    existing
    && !shouldUpdateByKeyFields({
      existingProperties: existing?.properties,
      incomingProperties: properties,
      nameField: 'name',
      updateFields: fields,
    })
  ) {
    return existing;
  }

  return hubspotClient.updateCompany(token, id, payload);
}

export async function getSearchProperties({ clientConfig, tenantModels }) {
  return buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'company',
    defaults: COMPANY_SEARCH_PROPERTIES,
  });
}

// Para que los casos de uso lean `hubspotUpdateFields` UNA vez por corrida y la
// bajen a cada item. Está acá y no en la capa de aplicación porque leer una
// config es infraestructura; el caso de uso solo llama al método del handler.
export async function getUpdateFields({ tenantModels }) {
  return resolveHubspotUpdateFields({ tenantModels, objectType: 'company' });
}

// Batch analogue of update(): null means "skip". Same identifier-only payload
// and key-field gate, but returns the input for a batch/update call instead of
// performing the PATCH.
export function buildBatchUpdateEntry({ existing, item, updateFields = [] }) {
  const properties = item?.properties ?? {};
  const payload = buildUpdatePayload(properties, updateFields);

  if (!payload || !existing?.id) {
    return null;
  }

  if (
    !shouldUpdateByKeyFields({
      existingProperties: existing?.properties,
      incomingProperties: properties,
      nameField: 'name',
      updateFields,
    })
  ) {
    return null;
  }

  return { id: existing.id, properties: payload.properties };
}

export default {
  find,
  create,
  update,
  getSearchProperties,
  getUpdateFields,
  buildBatchUpdateEntry,
};
