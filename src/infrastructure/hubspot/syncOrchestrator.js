import buildSendMappedItemsToHubspot from '#composition/hubspot-sync.composition.js';

export async function sendToHubSpot(
  mappedItems,
  clientConfig,
  objectType,
  tenantModels,
  credentials
) {
  return buildSendMappedItemsToHubspot().execute({
    mappedItems,
    clientConfig,
    objectType,
    tenantModels,
    credentials,
  });
}

export default {
  sendToHubSpot,
};
