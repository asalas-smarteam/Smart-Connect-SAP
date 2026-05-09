import HandleHubspotAssociations, {
  ASSOCIATION_MAP,
} from '#application/use-cases/HandleHubspotAssociations.js';
import buildHandleHubspotAssociations from '#composition/hubspot-associations.composition.js';

export async function handleAssociations({
  objectType,
  token,
  item,
  clientConfig,
  tenantModels,
  hubspotId,
}) {
  return buildHandleHubspotAssociations().execute({
    objectType,
    token,
    item,
    clientConfig,
    tenantModels,
    hubspotId,
  });
}

export { ASSOCIATION_MAP };

export default {
  ASSOCIATION_MAP,
  handleAssociations,
};
