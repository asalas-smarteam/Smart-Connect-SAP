import * as hubspotClient from '../hubspotClient.js';
import {
  buildUpdatePayload,
  resolveHubspotUpdateFields,
  shouldUpdateByKeyFields,
} from './utils/updateDecision.utils.js';
import { buildMappedSearchProperties } from './utils/searchProperties.utils.js';
import { buildConfiguredSearchCriteria } from './utils/searchCriteria.utils.js';

const CONTACT_SEARCH_PROPERTIES = [
  'email',
  'firstname',
  'phone',
  'idsap',
  'idSap',
  'internalcode',
];

export async function find({ token, item, clientConfig, tenantModels }) {
  const searchCriteria = await buildConfiguredSearchCriteria({ item, tenantModels });

  if (!searchCriteria) {
    return null;
  }

  const properties = await buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'contact',
    defaults: CONTACT_SEARCH_PROPERTIES,
  });

  if (searchCriteria.propertyName === 'email') {
    return hubspotClient.findContactByEmail(token, searchCriteria.value, {
      properties,
    });
  }

  return hubspotClient.findContactByProperty(
    token,
    searchCriteria.propertyName,
    searchCriteria.value,
    { properties }
  );
}

// Find de ContactEmployees con orden FIJO: internalcode primero (la llave
// real de un CE), email al final. No usa defaultFindHubspot a propósito: esa
// config identifica BPs (idsap), que los CE no traen — con ella el find
// devolvía null siempre y cada corrida intentaba un create.
export async function findContactEmployee({ token, internalcode, email, clientConfig, tenantModels }) {
  const properties = await buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'contact',
    defaults: CONTACT_SEARCH_PROPERTIES,
  });

  const code = String(internalcode ?? '').trim();

  if (code) {
    const byCode = await hubspotClient.findContactByProperty(token, 'internalcode', code, { properties });

    if (byCode) {
      return byCode;
    }
  }

  if (email) {
    return hubspotClient.findContactByEmail(token, email, { properties });
  }

  return null;
}

export async function create({ token, item }) {
  return hubspotClient.createContact(token, item);
}

export async function update({ token, id, item, existing, tenantModels, updateFields }) {
  const properties = item?.properties ?? {};
  const fields = await resolveHubspotUpdateFields({
    tenantModels,
    objectType: 'contact',
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
      nameField: 'firstname',
      updateFields: fields,
    })
  ) {
    return existing;
  }

  return hubspotClient.updateContact(token, id, payload);
}

export async function getSearchProperties({ clientConfig, tenantModels }) {
  return buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'contact',
    defaults: CONTACT_SEARCH_PROPERTIES,
  });
}

// Para que los casos de uso lean `hubspotUpdateFields` UNA vez por corrida y la
// bajen a cada item. Está acá y no en la capa de aplicación porque leer una
// config es infraestructura; el caso de uso solo llama al método del handler.
export async function getUpdateFields({ tenantModels }) {
  return resolveHubspotUpdateFields({ tenantModels, objectType: 'contact' });
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
      nameField: 'firstname',
      updateFields,
    })
  ) {
    return null;
  }

  return { id: existing.id, properties: payload.properties };
}

export default {
  find,
  findContactEmployee,
  create,
  update,
  getSearchProperties,
  getUpdateFields,
  buildBatchUpdateEntry,
};
