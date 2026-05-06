import { sapUpdateService } from '../sap/sapUpdateService.js';

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
