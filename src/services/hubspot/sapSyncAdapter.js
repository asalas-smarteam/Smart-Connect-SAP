import { sapUpdateService } from '../sapUpdateService.js';

export async function updateHubspotIdInSap({
  clientConfig,
  objectType,
  sapRecord,
  hubspotId,
  tenantModels,
}) {
  return sapUpdateService.updateHubspotIdInSap(
    clientConfig,
    objectType,
    sapRecord,
    hubspotId,
    tenantModels
  );
}

export default {
  updateHubspotIdInSap,
};
