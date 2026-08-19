import { buildSapFetchOptions } from '../services/sap-sync-options.service.js';
import { resolveDiscount } from '#domain/products/discount-resolver.service.js';
import { withDynamicDescriptionSelectFields } from '#domain/sync/dynamic-description.service.js';
import { withPropertiesFlagsSelectFields } from '#domain/business-partners/sap-properties-flags.service.js';
import { withContactEmployeesSelectField } from '#domain/business-partners/contact-employees-select.service.js';
import { ADDRESS_SYNC_NOT_IMPLEMENTED } from '#domain/business-partners/address-sync.constants.js';

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
    sapDiscountClient = null,
    discountConfigRepository = null,
    s4ContactEnricher = null,
    warehouseStockEnricher = null,
    propertiesFlagsEnricher = null,
    batchExpiryEnricher = null,
    businessPartnerCreationConfigRepository = null,
    addressSyncConfigRepository = null,
    // Este constructor no tenía logger. Las tareas 6 y 9 registran warnings, así
    // que se agrega ahora con default console, igual que HandleHubspotAssociations.
    logger = console,
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
    this.sapDiscountClient = sapDiscountClient;
    this.discountConfigRepository = discountConfigRepository;
    this.s4ContactEnricher = s4ContactEnricher;
    this.warehouseStockEnricher = warehouseStockEnricher;
    this.propertiesFlagsEnricher = propertiesFlagsEnricher;
    this.batchExpiryEnricher = batchExpiryEnricher;
    this.businessPartnerCreationConfigRepository = businessPartnerCreationConfigRepository;
    this.addressSyncConfigRepository = addressSyncConfigRepository;
    this.logger = logger;
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

      // A composed-description template may reference a SAP field that has no
      // mapping row of its own; without this the field would never reach the
      // $select and the template would silently render empty.
      const dynamicDescriptionConfig = typeof this.mappingRepository.getDynamicDescriptionConfig === 'function'
        ? await this.mappingRepository.getDynamicDescriptionConfig({ tenantContext })
        : null;

      // Properties1..64 y ContactEmployees no pueden tener filas de FieldMapping
      // propias, así que se inyectan como mappings sintéticos. Solo afectan el
      // $select del request a SAP: mapRecords vuelve a consultar los mappings
      // desde Mongo y nunca ve estos.
      const propertiesFlagsConfig = this.businessPartnerCreationConfigRepository
        ? await this.businessPartnerCreationConfigRepository.getPropertiesFlagsConfig({
          tenantModels: tenantContext?.tenantModels,
        })
        : null;

      const fetchOptions = {
        ...buildSapFetchOptions(activeConfig, this.dateProvider),
        mappings: withContactEmployeesSelectField(
          withPropertiesFlagsSelectFields(
            withDynamicDescriptionSelectFields(sapMappings, dynamicDescriptionConfig, {
              objectType: activeConfig.objectType,
              sourceContext,
            }),
            propertiesFlagsConfig,
            { objectType: activeConfig.objectType, sourceContext }
          ),
          { objectType: activeConfig.objectType, sourceContext }
        ),
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

      // La sincronización de direcciones SAP -> HubSpot no está implementada: el
      // destino correcto es un custom object de HubSpot (spec aparte). Si un
      // tenant la activó, que quede constancia en vez de fallar en silencio.
      if (this.addressSyncConfigRepository && (objectType === 'company' || objectType === 'contact')) {
        const { required } = await this.addressSyncConfigRepository.getAddressSyncConfig({
          tenantModels: tenantContext?.tenantModels,
        });

        if (required) {
          this.logger?.warn?.({
            msg: 'requireAddress esta activo pero la sincronizacion de direcciones no esta implementada',
            code: ADDRESS_SYNC_NOT_IMPLEMENTED,
            objectType,
          });
        }
      }

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

      await this.enrichRecordsWithDiscounts({
        mappedRecords: mappedRecordsWithRawSap,
        objectType,
        config: activeConfig,
        tenantContext,
      });

      // Attaches each company's contact persons to rawSapData for the
      // association step (S/4 only; a no-op otherwise).
      if (this.s4ContactEnricher) {
        await this.s4ContactEnricher.enrich({
          mappedRecords: mappedRecordsWithRawSap,
          objectType,
          tenantModels: tenantContext?.tenantModels,
        });
      }

      // Attaches each product's resolved warehouse-stock HubSpot properties
      // (a no-op for non-product syncs). Runs after mapRecords because it
      // needs rawSapData, and before sendMappedRecords so product.handler.js
      // finds it already resolved.
      if (this.warehouseStockEnricher) {
        await this.warehouseStockEnricher.enrich({
          mappedRecords: mappedRecordsWithRawSap,
          objectType,
          tenantModels: tenantContext?.tenantModels,
        });
      }

      // Adjunta los lotes y sus fechas de caducidad (no-op salvo en tenants con
      // batchExpiryStrategy configurada). Va despues del de stock porque ambos
      // leen rawSapData y son independientes, y antes de sendMappedRecords para
      // que product.handler.js encuentre la clave ya resuelta.
      if (this.batchExpiryEnricher) {
        await this.batchExpiryEnricher.enrich({
          mappedRecords: mappedRecordsWithRawSap,
          objectType,
          tenantModels: tenantContext?.tenantModels,
        });
      }

      // Traduce las banderas PropertiesN de SAP a la propiedad multi-select de
      // HubSpot (no-op para product/deal y para tenants S/4). Corre después de
      // mapRecords porque necesita rawSapData, y antes de sendMappedRecords para
      // que sanitizeProperties vea el valor ya resuelto.
      if (this.propertiesFlagsEnricher) {
        await this.propertiesFlagsEnricher.enrich({
          mappedRecords: mappedRecordsWithRawSap,
          objectType,
          tenantModels: tenantContext?.tenantModels,
        });
      }

      const hubspotResult = await this.sendMappedRecords({
        mappedRecords: mappedRecordsWithRawSap,
        config: activeConfig,
        objectType,
        tenantContext,
        credentials,
        syncLogId: syncLog?.id ?? syncLog?._id ?? null,
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
        errors: metrics.hubspotErrors,
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
    const hubspotErrors = Array.isArray(hubspotResult?.errors) ? hubspotResult.errors : [];

    return {
      recordsProcessed,
      hubspotSent,
      hubspotFailed,
      hubspotCreated,
      hubspotUpdated,
      hubspotErrors,
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

  async enrichRecordsWithDiscounts({
    mappedRecords,
    objectType,
    config,
    tenantContext,
  }) {
    if (objectType !== 'product' || !this.sapDiscountClient || !this.discountConfigRepository) {
      return;
    }

    const discountConfig = await this.discountConfigRepository.resolveDiscountConfig({
      tenantModels: tenantContext?.tenantModels,
    });

    if (!discountConfig?.isRequired) {
      return;
    }

    const { SapCredentials } = tenantContext?.tenantModels ?? {};
    const sapCredentialsList = typeof SapCredentials?.find === 'function'
      ? await SapCredentials.find().lean()
      : [];
    const [sapCredentials] = sapCredentialsList;

    if (!sapCredentials) {
      return;
    }

    const discountGroups = await this.sapDiscountClient.fetchActiveDiscountGroups({
      sapConfig: sapCredentials,
      tenantKey: config?.tenantKey ?? config?.tenantId ?? null,
    });
    const hsField = discountConfig.fieldMappings?.Discount ?? null;
    const currentDate = this.dateProvider();

    mappedRecords.forEach((record) => {
      if (!record.rawSapData) {
        return;
      }

      const discount = resolveDiscount(discountGroups, {
        itemCode: record.rawSapData.ItemCode,
        itemsGroupCode: record.rawSapData.ItemsGroupCode,
        currentDate,
      });

      // `null` de resolveDiscount significa "los grupos se leyeron y ninguno
      // aplica a este artículo", o sea 0. Dejarlo en null hacía que
      // product.handler no escribiera nada y HubSpot conservara un descuento
      // viejo para siempre: así quedaron 129 productos del tenant noelito con un
      // 10% que SAP ya no tiene en ningún grupo activo.
      //
      // El caso "no pudimos evaluar" sigue distinguiéndose por AUSENCIA de la
      // clave: los early returns de arriba no la escriben, y un fallo de lectura
      // de los grupos revienta el sync antes de llegar acá. Esa es la misma
      // convención que usa el enricher de lotes.
      record.rawSapData._resolvedDiscount = discount ?? 0;
      record.rawSapData._discountHsProperty = hsField;
    });
  }

  async sendMappedRecords({
    mappedRecords,
    config,
    objectType,
    tenantContext,
    credentials,
    syncLogId = null,
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
        syncLogId,
      });

      return {
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
        created: result?.created ?? 0,
        updated: result?.updated ?? Math.max((result?.sent ?? 0) - (result?.created ?? 0), 0),
        errors: Array.isArray(result?.errors) ? result.errors : [],
        recordsProcessed: mappedRecords.length,
      };
    } catch (_error) {
      return {
        sent: 0,
        failed: mappedRecords.length,
        created: 0,
        updated: 0,
        errors: [],
        recordsProcessed: mappedRecords.length,
      };
    }
  }
}

export default SyncSapConfigToHubspot;
