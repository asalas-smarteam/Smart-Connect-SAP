import sapService from '../integrations/sap/sapService.js';
import mappingService from './mapping.service.js';
import hubspotService from '../services/hubspotService.js';
import { finishSyncLog, startSyncLog } from './syncLog.service.js';

function normalizeMode(mode) {
  const value = String(mode || 'INCREMENTAL').trim().toUpperCase();
  return value === 'FULL' ? 'FULL' : 'INCREMENTAL';
}

function hasDynamicFilters(config) {
  if (!Array.isArray(config?.filters)) {
    return false;
  }

  return config.filters.some((filter) => filter?.isDynamic === true);
}

function buildSapFetchOptions(config) {
  const mode = normalizeMode(config?.mode);
  const now = new Date();

  if (mode === 'FULL') {
    return {
      mode,
      now,
      skipDynamicFilters: true,
      controlledFilter: null,
      dynamicIntervalMinutes: null,
    };
  }

  const intervalMinutes = Number(config?.intervalMinutes);
  const hasDynamic = hasDynamicFilters(config);
  const hasValidInterval = Number.isFinite(intervalMinutes) && intervalMinutes > 0;
  const controlledFilter = hasDynamic
    ? null
    : (hasValidInterval
      ? `UpdateDate ge ${new Date(now.getTime() - intervalMinutes * 60000).toISOString().split('.')[0]}`
      : null);

  return {
    mode,
    now,
    skipDynamicFilters: false,
    dynamicIntervalMinutes: hasValidInterval ? intervalMinutes : null,
    controlledFilter,
  };
}

const syncService = {
  async run(config, tenantModels) {
    const startedAt = new Date();
    const clientConfigId = config?.id;
    let syncLog = null;

    try {
      const { HubspotCredentials, SyncLog } = tenantModels;
      syncLog = await startSyncLog({
        tenantModels: { SyncLog },
        clientConfigId,
        startedAt,
      });

      if (!config) {
        throw new Error('Client configuration not found');
      }

      const credentials = await HubspotCredentials.findById(
        config.hubspotCredentialId
      );

      const fetchOptions = buildSapFetchOptions(config);
      //delete fetchOptions.controlledFilter 
      const rawData = await sapService.fetchData(clientConfigId, tenantModels, fetchOptions);

      if (!credentials) {
        await finishSyncLog(syncLog, {
          status: 'errored',
          recordsProcessed: 0,
          sent: 0,
          failed: 0,
          errorMessage: 'No HubSpot credentials assigned to this clientConfig',
          finishedAt: new Date(),
        });
        return;
      }

      if (!rawData || rawData.length === 0) {
        await finishSyncLog(syncLog, {
          status: 'completed',
          recordsProcessed: 0,
          sent: 0,
          failed: 0,
          finishedAt: new Date(),
        });

        config.lastRun = new Date();
        await config.save();
        return;
      }

      const objectType = config.objectType;
      const sapRecords = rawData;

      const mappedRecords = await mappingService.mapRecords(
        sapRecords,
        config.hubspotCredentialId,
        objectType,
        tenantModels
      );

      const mappedRecordsWithRawSap = mappedRecords.map((record, index) => ({
        ...record,
        rawSapData: sapRecords?.[index] ?? null,
      }));

      let hubspotResult = { sent: 0, failed: 0 };

      try {
        hubspotResult = await hubspotService.sendToHubSpot(
          mappedRecordsWithRawSap,
          config,
          objectType,
          tenantModels,
          credentials
        );
      } catch (error) {
        hubspotResult = { sent: 0, failed: mappedRecordsWithRawSap.length };
      }

      const recordsProcessed = mappedRecordsWithRawSap.length;

      await finishSyncLog(syncLog, {
        status: 'completed',
        recordsProcessed,
        sent: hubspotResult.sent,
        failed: hubspotResult.failed,
        finishedAt: new Date(),
      });

      config.lastRun = new Date();
      await config.save();
    } catch (error) {
      await finishSyncLog(syncLog, {
        status: 'errored',
        recordsProcessed: 0,
        sent: 0,
        failed: 0,
        errorMessage: error.message,
        finishedAt: new Date(),
      });

      if (config) {
        config.lastError = error.message;
        await config.save();
      }
    }
  },
};

export default syncService;
