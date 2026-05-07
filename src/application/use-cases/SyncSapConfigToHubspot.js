import { buildSapFetchOptions } from '../services/sap-sync-options.service.js';

export class SyncSapConfigToHubspot {
  constructor({
    sapDataSource,
    mappingRepository,
    hubspotSyncTarget,
    syncLogRepository,
    productSyncConfigRepository = null,
    productSyncStrategyFactory = null,
    dateProvider = () => new Date(),
  }) {
    this.sapDataSource = sapDataSource;
    this.mappingRepository = mappingRepository;
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.syncLogRepository = syncLogRepository;
    this.productSyncConfigRepository = productSyncConfigRepository;
    this.productSyncStrategyFactory = productSyncStrategyFactory;
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
        objectType: config?.objectType,
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

      const hubspotResult = await this.sendMappedRecords({
        mappedRecords: mappedRecordsWithRawSap,
        config,
        objectType,
        tenantModels,
        credentials,
      });

      await this.syncLogRepository.finish(syncLog, {
        status: 'completed',
        recordsProcessed: hubspotResult.recordsProcessed ?? mappedRecordsWithRawSap.length,
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

  async sendMappedRecords({
    mappedRecords,
    config,
    objectType,
    tenantModels,
    credentials,
  }) {
    if (objectType === 'product' && this.productSyncConfigRepository && this.productSyncStrategyFactory) {
      const strategyConfig = await this.productSyncConfigRepository.getProductSyncStrategyConfig({
        tenantModels,
      });
      const strategy = this.productSyncStrategyFactory.getStrategy(strategyConfig.strategy);

      return strategy.execute({
        mappedRecords,
        config,
        objectType,
        tenantModels,
        credentials,
        tenantId: config?.tenantId ?? config?.tenantKey ?? null,
        tenantKey: config?.tenantKey ?? null,
        strategyConfig,
      });
    }

    try {
      const result = await this.hubspotSyncTarget.send({
        mappedRecords,
        config,
        objectType,
        tenantModels,
        credentials,
      });

      return {
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
        recordsProcessed: mappedRecords.length,
      };
    } catch (_error) {
      return {
        sent: 0,
        failed: mappedRecords.length,
        recordsProcessed: mappedRecords.length,
      };
    }
  }
}

export default SyncSapConfigToHubspot;
