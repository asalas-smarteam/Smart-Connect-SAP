import { buildSapFetchOptions } from '../services/sap-sync-options.service.js';

export class SyncSapConfigToHubspot {
  constructor({
    sapDataSource,
    mappingRepository,
    hubspotSyncTarget,
    syncLogRepository,
    clientConfigRepository,
    hubspotCredentialRepository,
    productSyncConfigRepository = null,
    productSyncStrategyFactory = null,
    dateProvider = () => new Date(),
  }) {
    this.sapDataSource = sapDataSource;
    this.mappingRepository = mappingRepository;
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.syncLogRepository = syncLogRepository;
    this.clientConfigRepository = clientConfigRepository;
    this.hubspotCredentialRepository = hubspotCredentialRepository;
    this.productSyncConfigRepository = productSyncConfigRepository;
    this.productSyncStrategyFactory = productSyncStrategyFactory;
    this.dateProvider = dateProvider;
  }

  async execute({ config = null, configId = null, tenantContext }) {
    const startedAt = this.dateProvider();
    let activeConfig = config;
    const clientConfigId = configId ?? activeConfig?.id ?? activeConfig?._id ?? null;
    let syncLog = null;

    try {
      if (!activeConfig && clientConfigId) {
        activeConfig = await this.clientConfigRepository.findById({
          tenantContext,
          configId: clientConfigId,
        });
      }

      syncLog = await this.syncLogRepository.start({
        tenantContext,
        clientConfigId,
        objectType: activeConfig?.objectType,
        startedAt,
      });

      if (!activeConfig) {
        throw new Error('Client configuration not found');
      }

      const credentials = await this.hubspotCredentialRepository.findByClientConfig({
        tenantContext,
        clientConfig: activeConfig,
      });

      await this.mappingRepository.ensureDefaultMappings({
        tenantContext,
        hubspotCredentialId: activeConfig.hubspotCredentialId,
        objectType: activeConfig.objectType,
        clientConfig: activeConfig,
      });

      const sourceContext = activeConfig.objectType === 'product' ? 'product' : 'businessPartner';
      const sapMappings = await this.mappingRepository.findMappings({
        tenantContext,
        hubspotCredentialId: activeConfig.hubspotCredentialId,
        objectType: activeConfig.objectType,
        sourceContext,
      });

      const fetchOptions = {
        ...buildSapFetchOptions(activeConfig, this.dateProvider),
        mappings: sapMappings,
      };
      const rawData = await this.sapDataSource.fetchData({
        clientConfigId,
        clientConfig: activeConfig,
        tenantContext,
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
        return this.finishEmptySync({ syncLog, config: activeConfig, tenantContext });
      }

      const objectType = activeConfig.objectType;
      const mappedRecords = await this.mappingRepository.mapRecords({
        sapRecords: rawData,
        hubspotCredentialId: activeConfig.hubspotCredentialId,
        objectType,
        tenantContext,
      });
      const mappedRecordsWithRawSap = mappedRecords.map((record, index) => ({
        ...record,
        rawSapData: rawData?.[index] ?? null,
      }));

      const hubspotResult = await this.sendMappedRecords({
        mappedRecords: mappedRecordsWithRawSap,
        config: activeConfig,
        objectType,
        tenantContext,
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

      await this.clientConfigRepository.markSyncSucceeded({
        tenantContext,
        configId: activeConfig.id ?? activeConfig._id,
        lastRun: this.dateProvider(),
      });
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

      if (activeConfig) {
        await this.clientConfigRepository.markSyncFailed({
          tenantContext,
          configId: activeConfig.id ?? activeConfig._id,
          errorMessage: error.message,
        });
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

  async finishEmptySync({ syncLog, config, tenantContext }) {
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

    await this.clientConfigRepository.markSyncSucceeded({
      tenantContext,
      configId: config.id ?? config._id,
      lastRun: this.dateProvider(),
    });
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
    tenantContext,
    credentials,
  }) {
    if (objectType === 'product' && this.productSyncConfigRepository && this.productSyncStrategyFactory) {
      const strategyConfig = await this.productSyncConfigRepository.getProductSyncStrategyConfig({
        tenantContext,
      });
      const strategy = this.productSyncStrategyFactory.getStrategy(strategyConfig.strategy);

      return strategy.execute({
        mappedRecords,
        config,
        objectType,
        tenantContext,
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
        tenantContext,
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
