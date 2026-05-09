import SyncSapConfigToHubspot from '#application/use-cases/SyncSapConfigToHubspot.js';
import ProductSyncStrategyFactory from '#domain/products/product-sync-strategy.factory.js';
import OneToManyProductStrategy from '#domain/products/strategies/one-to-many-product.strategy.js';
import OneToOneProductStrategy from '#domain/products/strategies/one-to-one-product.strategy.js';
import ProductSyncStrategyConfigRepository from '#infrastructure/config/ProductSyncStrategyConfigRepository.js';
import MongooseSapSyncTenantRepository from '#infrastructure/database/repositories/MongooseSapSyncTenantRepository.js';
import MongooseSyncLogRepository from '#infrastructure/database/repositories/MongooseSyncLogRepository.js';
import HubspotSyncAdapter from '#infrastructure/hubspot/HubspotSyncAdapter.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import TenantSapSyncLockAdapter from '#infrastructure/locks/TenantSapSyncLockAdapter.js';
import MappingSyncRepository from '#infrastructure/repositories/MappingSyncRepository.js';
import SapSyncDataAdapter from '#infrastructure/sap/SapSyncDataAdapter.js';
import sapSyncAdminAdapter from '#infrastructure/scheduler/SapSyncAdminAdapter.js';

export function buildSyncSapConfigToHubspot() {
  const hubspotSyncTarget = new HubspotSyncAdapter();
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

  return new SyncSapConfigToHubspot({
    sapDataSource: new SapSyncDataAdapter(),
    mappingRepository: new MappingSyncRepository(),
    hubspotSyncTarget,
    syncLogRepository: new MongooseSyncLogRepository(),
    productSyncConfigRepository: new ProductSyncStrategyConfigRepository(),
    productSyncStrategyFactory,
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
