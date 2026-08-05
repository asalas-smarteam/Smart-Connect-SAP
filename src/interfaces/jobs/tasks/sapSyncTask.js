import cron from 'node-cron';
import {
  buildSapSyncTenantRepository,
  buildSyncSapConfigToHubspot,
} from '#composition/sap-sync.composition.js';
import { buildSyncDropdownOptionsToHubspot } from '#composition/dropdown-options.composition.js';
import { resolveSyncUseCase } from '#application/services/syncTaskRouter.service.js';
import { listActiveTenants } from '#infrastructure/tenants/tenantSubscriptions.js';

// Manual trigger behind POST /sap-sync/run: runs every active ClientConfig
// in-process, bypassing the queue. It routes on taskType exactly like the
// BullMQ processor does, so leaving a single DROPDOWN_OPTIONS config active is
// enough to test that flow end to end.
export async function runSapSyncOnce({
  tenantRepository = buildSapSyncTenantRepository(),
  syncUseCase = buildSyncSapConfigToHubspot(),
  dropdownUseCase = buildSyncDropdownOptionsToHubspot(),
  tenantProvider = listActiveTenants,
  tenantID = null,
} = {}) {
  const activeTenants = await tenantProvider();

  const targetTenants = tenantID
    ? activeTenants.filter(({ client }) => client.tenantKey === tenantID)
    : activeTenants;

  for (const { client } of targetTenants) {
    const { tenantModels, configs } = await tenantRepository.findActiveConfigs(client.tenantKey);

    for (const config of configs) {
      await resolveSyncUseCase({ config, syncUseCase, dropdownUseCase }).execute({
        config,
        tenantContext: {
          tenantKey: client.tenantKey,
          tenantModels,
        },
      });
    }
  }
}

export default function startSapSync() {
  if (false) { // delete in prod
    const sapSyncJob = cron.schedule('*/1 * * * *', runSapSyncOnce, { scheduled: false });
    return sapSyncJob;
  }
}
