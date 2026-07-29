import DefaultFindHubspotConfigRepository from '#infrastructure/config/DefaultFindHubspotConfigRepository.js';

const defaultFindHubspotConfigRepository = new DefaultFindHubspotConfigRepository();

function hasSearchValue(value) {
  return value !== undefined && value !== null && value !== '';
}

export async function getConfiguredFindProperty({
  tenantModels,
  fallbackPropertyName = 'email',
}) {
  const configuredPropertyName = await defaultFindHubspotConfigRepository
    .getDefaultFindHubspotProperty({ tenantModels });
  return configuredPropertyName || fallbackPropertyName;
}

export async function buildConfiguredSearchCriteria({
  item,
  tenantModels,
  fallbackPropertyName = 'email',
}) {
  const propertyName = await getConfiguredFindProperty({ tenantModels, fallbackPropertyName });
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
  getConfiguredFindProperty,
};
