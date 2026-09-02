import {
  HUBSPOT_UPDATE_FIELDS_CONFIG_KEY,
  resolveHubspotUpdateFieldsFor,
} from '#domain/sync/hubspot-update-fields.constants.js';

export { HUBSPOT_UPDATE_FIELDS_CONFIG_KEY };

async function resolveConfiguration(query) {
  if (!query) {
    return null;
  }

  return query.lean ? query.lean() : query;
}

export class HubspotUpdateFieldsConfigRepository {
  // Nunca lanza: si la config no se puede leer, el update sigue mandando solo
  // los identificadores, que es la conducta previa a esta clave. Lee con findOne
  // directo, sin el upsert de tenantConfiguration.service.js, para no crearle
  // documentos vacíos a un tenant que nunca configuró esto.
  async getHubspotUpdateFields({ tenantModels, objectType }) {
    try {
      const query = tenantModels?.Configuration?.findOne?.({
        key: HUBSPOT_UPDATE_FIELDS_CONFIG_KEY,
      });
      const configuration = await resolveConfiguration(query);

      return resolveHubspotUpdateFieldsFor(configuration?.value, objectType);
    } catch (_error) {
      return [];
    }
  }
}

export default HubspotUpdateFieldsConfigRepository;
