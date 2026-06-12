import DefaultFindHubspotConfigRepository from '#infrastructure/config/DefaultFindHubspotConfigRepository.js';

const defaultFindHubspotConfigRepository = new DefaultFindHubspotConfigRepository();

function hasSearchValue(value) {
  return value !== undefined && value !== null && value !== '';
}

export async function buildConfiguredSearchCriteria({
  item,
  tenantModels,
  fallbackPropertyName = 'email',
}) {
  const configuredPropertyName = await defaultFindHubspotConfigRepository
    .getDefaultFindHubspotProperty({ tenantModels });
  const propertyName = configuredPropertyName || fallbackPropertyName;
  const value = item?.properties?.[propertyName];

  if (!hasSearchValue(value)) {
    return null;
  }

  return {
    propertyName,
    value,
  };
}

export default {
  buildConfiguredSearchCriteria,
};
