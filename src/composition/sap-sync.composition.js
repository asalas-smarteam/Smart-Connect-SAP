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
import ProductSyncStrategyConfigRepository from '#infrastructure/config/ProductSyncStrategyConfigRepository.js';
import MongooseClientConfigRepository from '#infrastructure/database/repositories/MongooseClientConfigRepository.js';
import MongooseHubspotCredentialRepository from '#infrastructure/database/repositories/MongooseHubspotCredentialRepository.js';
import MongooseSapSyncTenantRepository from '#infrastructure/database/repositories/MongooseSapSyncTenantRepository.js';
import MongooseSyncLogRepository from '#infrastructure/database/repositories/MongooseSyncLogRepository.js';
import HubspotSyncAdapter from '#infrastructure/hubspot/HubspotSyncAdapter.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import TenantSapSyncLockAdapter from '#infrastructure/locks/TenantSapSyncLockAdapter.js';
import MappingSyncRepository from '#infrastructure/repositories/MappingSyncRepository.js';
import SapSyncDataAdapter from '#infrastructure/sap/SapSyncDataAdapter.js';
import sapSyncAdminAdapter from '#infrastructure/scheduler/SapSyncAdminAdapter.js';
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

  return new SyncSapConfigToHubspot({
    sapDataSource,
    mappingRepository,
    hubspotSyncTarget,
    syncLogRepository,
    clientConfigRepository,
    hubspotCredentialRepository,
    productSyncConfigRepository,
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
