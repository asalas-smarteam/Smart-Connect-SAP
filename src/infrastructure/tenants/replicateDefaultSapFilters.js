import logger from '../logger/logger.js';
import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
  normalizeSapFlavor,
} from '#domain/sap/sap-flavor.constants.js';
import { createDefaultSapFilterModel } from '../database/models/master/defaultSapFilter.model.js';
import { createSapFilterModel } from '../database/models/tenant/sapFilter.model.js';

function serializeFilterValue(value) {
  // 'in' filters carry arrays, so the key must be stable for them too.
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(',');
  }
  return value === null || typeof value === 'undefined' ? '' : String(value);
}

function buildFilterKey(filter) {
  return [
    filter.objectType,
    filter.property,
    filter.operator,
    serializeFilterValue(filter.value),
    String(Boolean(filter.isDefault)),
    String(Boolean(filter.isDynamic)),
    filter.dynamicType || 'datetime',
  ].join('|');
}

// Only the defaults matching the tenant's SAP flavor are replicated. Master
// documents predating the sapFlavor field are treated as B1, so existing
// installations keep replicating exactly what they replicate today.
function buildMasterFilterQuery(sapFlavor) {
  if (sapFlavor === SAP_FLAVORS.S4) {
    return { active: true, sapFlavor: SAP_FLAVORS.S4 };
  }

  return {
    active: true,
    $or: [
      { sapFlavor: SAP_FLAVORS.B1 },
      { sapFlavor: { $exists: false } },
      { sapFlavor: null },
    ],
  };
}

export async function replicateDefaultSapFilters({
  masterConnection,
  tenantConnection,
  sapFlavor = DEFAULT_SAP_FLAVOR,
}) {
  try {
    const DefaultSapFilter = createDefaultSapFilterModel(masterConnection);
    const SapFilter = createSapFilterModel(tenantConnection);

    const resolvedFlavor = normalizeSapFlavor(sapFlavor) || DEFAULT_SAP_FLAVOR;
    const masterFilters = await DefaultSapFilter
      .find(buildMasterFilterQuery(resolvedFlavor))
      .lean();

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
        dynamicType: filter.dynamicType || 'datetime',
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
