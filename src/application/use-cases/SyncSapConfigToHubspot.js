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
        const metrics = {
          recordsProcessed: 0,
          hubspotSent: 0,
          hubspotFailed: 0,
          hubspotCreated: 0,
          hubspotUpdated: 0,
        };
        await this.syncLogRepository.finish(syncLog, {
          status: 'errored',
          recordsProcessed: metrics.recordsProcessed,
          sent: metrics.hubspotSent,
          failed: metrics.hubspotFailed,
          errorMessage: 'No HubSpot credentials assigned to this clientConfig',
          finishedAt: this.dateProvider(),
        });
        return {
          ok: false,
          status: 'errored',
          metrics,
        };
      }

      if (!rawData || rawData.length === 0) {
        return this.finishEmptySync({ syncLog, config });
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
      const metrics = this.buildMetrics({
        sapRecords: rawData,
        mappedRecords: mappedRecordsWithRawSap,
        hubspotResult,
      });

      await this.syncLogRepository.finish(syncLog, {
        status: 'completed',
        recordsProcessed: metrics.recordsProcessed,
        sent: metrics.hubspotSent,
        failed: metrics.hubspotFailed,
        finishedAt: this.dateProvider(),
      });

      config.lastRun = this.dateProvider();
      await config.save();
      return {
        ok: true,
        status: 'completed',
        metrics,
      };
    } catch (error) {
      const metrics = {
        recordsProcessed: 0,
        hubspotSent: 0,
        hubspotFailed: 0,
        hubspotCreated: 0,
        hubspotUpdated: 0,
      };
      await this.syncLogRepository.finish(syncLog, {
        status: 'errored',
        recordsProcessed: metrics.recordsProcessed,
        sent: metrics.hubspotSent,
        failed: metrics.hubspotFailed,
        errorMessage: error.message,
        finishedAt: this.dateProvider(),
      });

      if (config) {
        config.lastError = error.message;
        await config.save();
      }

      return {
        ok: false,
        status: 'errored',
        error: error.message,
        metrics,
      };
    }
  }

  buildMetrics({ sapRecords, mappedRecords, hubspotResult }) {
    const recordsProcessed = hubspotResult?.recordsProcessed
      ?? mappedRecords?.length
      ?? sapRecords?.length
      ?? 0;
    const hubspotSent = hubspotResult?.sent ?? 0;
    const hubspotFailed = hubspotResult?.failed ?? 0;
    const hubspotCreated = hubspotResult?.created ?? 0;
    const hubspotUpdated = hubspotResult?.updated ?? Math.max(hubspotSent - hubspotCreated, 0);

    return {
      recordsProcessed,
      hubspotSent,
      hubspotFailed,
      hubspotCreated,
      hubspotUpdated,
    };
  }

  async finishEmptySync({ syncLog, config }) {
    const metrics = {
      recordsProcessed: 0,
      hubspotSent: 0,
      hubspotFailed: 0,
      hubspotCreated: 0,
      hubspotUpdated: 0,
    };
    await this.syncLogRepository.finish(syncLog, {
      status: 'completed',
      recordsProcessed: metrics.recordsProcessed,
      sent: metrics.hubspotSent,
      failed: metrics.hubspotFailed,
      finishedAt: this.dateProvider(),
    });

    config.lastRun = this.dateProvider();
    await config.save();
    return {
      ok: true,
      status: 'completed',
      metrics,
    };
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
        created: result?.created ?? 0,
        updated: result?.updated ?? Math.max((result?.sent ?? 0) - (result?.created ?? 0), 0),
        recordsProcessed: mappedRecords.length,
      };
    } catch (_error) {
      return {
        sent: 0,
        failed: mappedRecords.length,
        created: 0,
        updated: 0,
        recordsProcessed: mappedRecords.length,
      };
    }
  }
}

export default SyncSapConfigToHubspot;
