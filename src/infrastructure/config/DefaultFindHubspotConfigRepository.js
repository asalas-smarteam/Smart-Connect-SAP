export const DEFAULT_FIND_HUBSPOT_CONFIG_KEY = 'defaultFindHubspot';

async function resolveConfiguration(query) {
  if (!query) {
    return null;
  }

  return query.lean
    ? query.lean()
    : query;
}

export class DefaultFindHubspotConfigRepository {
  async getDefaultFindHubspotProperty({ tenantModels }) {
    try {
      const query = tenantModels?.Configuration?.findOne?.({
        key: DEFAULT_FIND_HUBSPOT_CONFIG_KEY,
      });
      const configuration = await resolveConfiguration(query);

      return typeof configuration?.value === 'string' && configuration.value.trim()
        ? configuration.value.trim()
        : null;
    } catch (_error) {
      return null;
    }
  }
}

export default DefaultFindHubspotConfigRepository;
