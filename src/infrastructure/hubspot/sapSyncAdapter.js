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

export async function updateBusinessPartnerInSapFromHubspot({
  clientConfig,
  objectType,
  item,
  existing,
  tenantModels,
}) {
  return sapUpdateService.updateBusinessPartnerInSapFromHubspot(
    clientConfig,
    objectType,
    item,
    existing,
    tenantModels
  );
}

export default {
  updateHubspotIdInSap,
  updateBusinessPartnerInSapFromHubspot,
};
