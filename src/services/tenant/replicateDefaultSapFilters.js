import logger from '../../core/logger.js';
import { createDefaultSapFilterModel } from '../../../models/master/defaultSapFilter.model.js';
import { createSapFilterModel } from '../../../models/tenant/sapFilter.model.js';

function buildFilterKey(filter) {
  return [
    filter.objectType,
    filter.property,
    filter.operator,
    filter.value || '',
    String(Boolean(filter.isDefault)),
    String(Boolean(filter.isDynamic)),
  ].join('|');
}

export async function replicateDefaultSapFilters({ masterConnection, tenantConnection }) {
  try {
    const DefaultSapFilter = createDefaultSapFilterModel(masterConnection);
    const SapFilter = createSapFilterModel(tenantConnection);

    const masterFilters = await DefaultSapFilter.find({ active: true }).lean();

    if (!masterFilters.length) {
      logger.warn({ msg: 'No active default SAP filters found in master database' });
      logger.info({ msg: 'No SAP filters to replicate for tenant' });
      return;
    }

    const tenantFilters = await SapFilter.find({}).lean();
    const tenantKeys = new Set(tenantFilters.map(buildFilterKey));

    const missingFilters = masterFilters
      .filter((filter) => !tenantKeys.has(buildFilterKey(filter)))
      .map((filter) => ({
        objectType: filter.objectType,
        property: filter.property,
        operator: filter.operator,
        value: filter.value,
        isDefault: filter.isDefault,
        isDynamic: filter.isDynamic,
        active: filter.active,
      }));

    if (!missingFilters.length) {
      logger.info({ msg: 'Tenant SAP filters are already up to date' });
      return;
    }

    await SapFilter.insertMany(missingFilters);
    logger.info({
      msg: 'Replicated SAP default filters to tenant database',
      insertedCount: missingFilters.length,
    });
  } catch (error) {
    logger.error({
      msg: 'Failed to replicate default SAP filters to tenant database',
      error,
    });
    throw error;
  }
}

export default replicateDefaultSapFilters;
