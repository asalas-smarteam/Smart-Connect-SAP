import SyncSapConfigToHubspot from '#application/use-cases/SyncSapConfigToHubspot.js';
import { ClientConfigRepositoryPort } from '#application/ports/database/client-config-repository.port.js';
import { FieldMappingRepositoryPort } from '#application/ports/database/field-mapping-repository.port.js';
import { ProductSyncStrategyConfigPort } from '#application/ports/database/product-sync-strategy-config.port.js';
import { SyncLogRepositoryPort } from '#application/ports/database/sync-log-repository.port.js';
import { HubspotCredentialRepositoryPort } from '#application/ports/hubspot/hubspot-credential-repository.port.js';
import { HubspotSyncTargetPort } from '#application/ports/hubspot/hubspot-sync-target.port.js';
import { assertPort } from '#application/ports/port-validator.js';
import { SapDataSourcePort } from '#application/ports/sap/sap-data-source.port.js';
import ProductSyncStrategyFactory from '#domain/products/product-sync-strategy.factory.js';
import OneToManyProductStrategy from '#domain/products/strategies/one-to-many-product.strategy.js';
import OneToOneProductStrategy from '#domain/products/strategies/one-to-one-product.strategy.js';
import WarehouseStockStrategyFactory from '#domain/warehouses/warehouse-stock-strategy.factory.js';
import B1ItemWarehouseStrategy from '#domain/warehouses/strategies/b1-item-warehouse.strategy.js';
import S4PlantStorageLocationStrategy from '#domain/warehouses/strategies/s4-plant-storage-location.strategy.js';
import { SapRecordEnricherPort } from '#application/ports/sap/sap-record-enricher.port.js';
import AddressSyncConfigRepository from '#infrastructure/config/AddressSyncConfigRepository.js';
import BusinessPartnerCreationConfigRepository from '#infrastructure/config/BusinessPartnerCreationConfigRepository.js';
import ProductSyncStrategyConfigRepository from '#infrastructure/config/ProductSyncStrategyConfigRepository.js';
import WarehouseStockConfigRepository from '#infrastructure/config/WarehouseStockConfigRepository.js';
import MongooseClientConfigRepository from '#infrastructure/database/repositories/MongooseClientConfigRepository.js';
import MongooseHubspotCredentialRepository from '#infrastructure/database/repositories/MongooseHubspotCredentialRepository.js';
import MongooseSapSyncTenantRepository from '#infrastructure/database/repositories/MongooseSapSyncTenantRepository.js';
import MongooseSyncLogRepository from '#infrastructure/database/repositories/MongooseSyncLogRepository.js';
import HubspotSyncAdapter from '#infrastructure/hubspot/HubspotSyncAdapter.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import TenantSapSyncLockAdapter from '#infrastructure/locks/TenantSapSyncLockAdapter.js';
import MappingSyncRepository from '#infrastructure/repositories/MappingSyncRepository.js';
import SapSyncDataAdapter from '#infrastructure/sap/SapSyncDataAdapter.js';
import S4ContactEnrichmentAdapter from '#infrastructure/sap/customers/S4ContactEnrichmentAdapter.js';
import PropertiesFlagsEnrichmentAdapter from '#infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js';
import WarehouseStockEnrichmentAdapter from '#infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js';
import sapSyncAdminAdapter from '#infrastructure/scheduler/SapSyncAdminAdapter.js';
import SapDiscountClient from '#infrastructure/external-services/SapDiscountClient.js';
import TenantLineItemPriceConfigRepository from '#infrastructure/repositories/TenantLineItemPriceConfigRepository.js';
import { buildSendMappedItemsToHubspot } from './hubspot-sync.composition.js';

export function buildSyncSapConfigToHubspot() {
  const sapDataSource = assertPort(new SapSyncDataAdapter(), SapDataSourcePort);
  const mappingRepository = assertPort(new MappingSyncRepository(), FieldMappingRepositoryPort);
  const syncLogRepository = assertPort(new MongooseSyncLogRepository(), SyncLogRepositoryPort);
  const clientConfigRepository = assertPort(
    new MongooseClientConfigRepository(),
    ClientConfigRepositoryPort
  );
  const hubspotCredentialRepository = assertPort(
    new MongooseHubspotCredentialRepository(),
    HubspotCredentialRepositoryPort
  );
  const hubspotSyncTarget = assertPort(
    new HubspotSyncAdapter({
      sendMappedItemsToHubspot: buildSendMappedItemsToHubspot(),
    }),
    HubspotSyncTargetPort
  );
  const productSyncConfigRepository = assertPort(
    new ProductSyncStrategyConfigRepository(),
    ProductSyncStrategyConfigPort
  );
  const productSyncStrategyFactory = new ProductSyncStrategyFactory({
    oneToOneProductStrategy: new OneToOneProductStrategy({
      hubspotSyncTarget,
      logger,
    }),
    oneToManyProductStrategy: new OneToManyProductStrategy({
      hubspotSyncTarget,
      logger,
    }),
    logger,
  });

  const warehouseStockStrategyFactory = new WarehouseStockStrategyFactory({
    b1ItemWarehouseStrategy: new B1ItemWarehouseStrategy(),
    s4PlantStorageLocationStrategy: new S4PlantStorageLocationStrategy(),
    logger,
  });

  // Misma instancia inyectada dos veces abajo: el use-case la usa suelta para
  // inyectar Properties1..64/ContactEmployees en el $select, y el enricher la
  // usa para resolver el valor ya mapeado. No hay memoización en el
  // repositorio, así que esto ahorra una allocation, no una lectura de Mongo
  // duplicada; cada consumidor sigue leyendo la config una vez por su cuenta.
  const businessPartnerCreationConfigRepository = new BusinessPartnerCreationConfigRepository();

  return new SyncSapConfigToHubspot({
    sapDataSource,
    mappingRepository,
    hubspotSyncTarget,
    syncLogRepository,
    clientConfigRepository,
    hubspotCredentialRepository,
    productSyncConfigRepository,
    productSyncStrategyFactory,
    sapDiscountClient: new SapDiscountClient(),
    discountConfigRepository: new TenantLineItemPriceConfigRepository(),
    s4ContactEnricher: assertPort(
      new S4ContactEnrichmentAdapter({ logger }),
      SapRecordEnricherPort
    ),
    warehouseStockEnricher: assertPort(
      new WarehouseStockEnrichmentAdapter({
        strategyFactory: warehouseStockStrategyFactory,
        configRepository: new WarehouseStockConfigRepository(),
        logger,
      }),
      SapRecordEnricherPort
    ),
    businessPartnerCreationConfigRepository,
    propertiesFlagsEnricher: assertPort(
      new PropertiesFlagsEnrichmentAdapter({
        configRepository: businessPartnerCreationConfigRepository,
        logger,
      }),
      SapRecordEnricherPort
    ),
    addressSyncConfigRepository: new AddressSyncConfigRepository(),
    // El constructor defaultea `logger` a `console`. Sin esta línea los warnings
    // de las tareas 6 y 9 (PropertiesN sin flavor B1, ADDRESS_SYNC_NOT_IMPLEMENTED)
    // salen por stdout crudo en vez del logger winston que revisan los operadores.
    logger,
  });
}

export function buildSapSyncTenantRepository() {
  return new MongooseSapSyncTenantRepository();
}

export function buildTenantSapSyncLockAdapter() {
  return new TenantSapSyncLockAdapter();
}

export function buildSapSyncAdmin() {
  return sapSyncAdminAdapter;
}

export default buildSyncSapConfigToHubspot;
