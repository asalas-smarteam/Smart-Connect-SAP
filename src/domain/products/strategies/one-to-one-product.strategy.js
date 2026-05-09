import {
  PRODUCT_SYNC_STRATEGIES,
} from '../product-sync-strategy.constants.js';

export class OneToOneProductStrategy {
  constructor({ hubspotSyncTarget, logger = console }) {
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.logger = logger;
  }

  async execute({
    mappedRecords,
    config,
    objectType,
    tenantModels,
    credentials,
    tenantId,
  }) {
    const totalProducts = Array.isArray(mappedRecords) ? mappedRecords.length : 0;

    this.logger.info?.({
      msg: 'Starting product sync strategy',
      tenantId,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
      totalProducts,
    });

    try {
      const result = await this.hubspotSyncTarget.send({
        mappedRecords,
        config,
        objectType,
        tenantModels,
        credentials,
      });

      this.logger.info?.({
        msg: 'Finished product sync strategy',
        tenantId,
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
        totalProducts,
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
      });

      return {
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
        created: result?.created ?? 0,
        updated: result?.updated ?? Math.max((result?.sent ?? 0) - (result?.created ?? 0), 0),
        recordsProcessed: totalProducts,
      };
    } catch (error) {
      this.logger.error?.({
        msg: 'Product sync strategy failed',
        tenantId,
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
        totalProducts,
        error: error.message,
      });

      return {
        sent: 0,
        failed: totalProducts,
        created: 0,
        updated: 0,
        recordsProcessed: totalProducts,
      };
    }
  }
}

export default OneToOneProductStrategy;
