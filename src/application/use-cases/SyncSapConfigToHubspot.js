import { buildSapFetchOptions } from '../services/sap-sync-options.service.js';

export class SyncSapConfigToHubspot {
  constructor({
    sapDataSource,
    mappingRepository,
    hubspotSyncTarget,
    syncLogRepository,
    dateProvider = () => new Date(),
  }) {
    this.sapDataSource = sapDataSource;
    this.mappingRepository = mappingRepository;
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.syncLogRepository = syncLogRepository;
    this.dateProvider = dateProvider;
  }

  async execute({ config, tenantModels }) {
    const startedAt = this.dateProvider();
    const clientConfigId = config?.id;
    let syncLog = null;

    try {
      syncLog = await this.syncLogRepository.start({
        tenantModels,
        clientConfigId,
        startedAt,
      });

      if (!config) {
        throw new Error('Client configuration not found');
      }

      const credentials = await tenantModels.HubspotCredentials.findById(
        config.hubspotCredentialId
      );

      const fetchOptions = buildSapFetchOptions(config, this.dateProvider);
      const rawData = await this.sapDataSource.fetchData({
        clientConfigId,
        tenantModels,
        fetchOptions,
      });

      if (!credentials) {
        await this.syncLogRepository.finish(syncLog, {
          status: 'errored',
          recordsProcessed: 0,
          sent: 0,
          failed: 0,
          errorMessage: 'No HubSpot credentials assigned to this clientConfig',
          finishedAt: this.dateProvider(),
        });
        return;
      }

      if (!rawData || rawData.length === 0) {
        await this.finishEmptySync({ syncLog, config });
        return;
      }

      const objectType = config.objectType;
      const mappedRecords = await this.mappingRepository.mapRecords({
        sapRecords: rawData,
        hubspotCredentialId: config.hubspotCredentialId,
        objectType,
        tenantModels,
      });
      const mappedRecordsWithRawSap = mappedRecords.map((record, index) => ({
        ...record,
        rawSapData: rawData?.[index] ?? null,
      }));

      let hubspotResult = { sent: 0, failed: 0 };

      try {
        hubspotResult = await this.hubspotSyncTarget.send({
          mappedRecords: mappedRecordsWithRawSap,
          config,
          objectType,
          tenantModels,
          credentials,
        });
      } catch (_error) {
        hubspotResult = { sent: 0, failed: mappedRecordsWithRawSap.length };
      }

      await this.syncLogRepository.finish(syncLog, {
        status: 'completed',
        recordsProcessed: mappedRecordsWithRawSap.length,
        sent: hubspotResult.sent,
        failed: hubspotResult.failed,
        finishedAt: this.dateProvider(),
      });

      config.lastRun = this.dateProvider();
      await config.save();
    } catch (error) {
      await this.syncLogRepository.finish(syncLog, {
        status: 'errored',
        recordsProcessed: 0,
        sent: 0,
        failed: 0,
        errorMessage: error.message,
        finishedAt: this.dateProvider(),
      });

      if (config) {
        config.lastError = error.message;
        await config.save();
      }
    }
  }

  async finishEmptySync({ syncLog, config }) {
    await this.syncLogRepository.finish(syncLog, {
      status: 'completed',
      recordsProcessed: 0,
      sent: 0,
      failed: 0,
      finishedAt: this.dateProvider(),
    });

    config.lastRun = this.dateProvider();
    await config.save();
  }
}

export default SyncSapConfigToHubspot;

