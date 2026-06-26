import { createDefaultSapFilterModel } from '../models/master/defaultSapFilter.model.js';
import logger from '#infrastructure/logger/logger.js';

const BASE_DEFAULT_SAP_FILTERS = [
  {
    objectType: 'contact',
    property: 'CardType',
    operator: 'eq',
    value: 'C',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'contact',
    property: 'CompanyPrivate',
    operator: 'eq',
    value: 'I',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'contact',
    property: 'FederalTaxID',
    operator: 'not_startswith',
    value: 'J',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'contact',
    property: 'UpdateDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    active: true,
  },
  {
    objectType: 'company',
    property: 'CardType',
    operator: 'eq',
    value: 'C',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'company',
    property: 'CompanyPrivate',
    operator: 'eq',
    value: 'C',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'company',
    property: 'FederalTaxID',
    operator: 'startswith',
    value: 'J',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'company',
    property: 'UpdateDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    active: true,
  },
  {
    objectType: 'deal',
    property: 'DocumentStatus',
    operator: 'eq',
    value: 'C',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'deal',
    property: 'UpdateDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    active: true,
  },
];

export async function seedDefaultSapFilters(masterConnection) {
  try {
    const DefaultSapFilter = createDefaultSapFilterModel(masterConnection);

    // Seed per objectType so that new object types (e.g. 'deal') are added to
    // installations that were seeded before they existed, while staying idempotent.
    const seededObjectTypes = await DefaultSapFilter.distinct('objectType', { active: true });
    const seededSet = new Set(seededObjectTypes.map((type) => String(type)));

    const missingFilters = BASE_DEFAULT_SAP_FILTERS.filter(
      (filter) => !seededSet.has(filter.objectType)
    );

    if (missingFilters.length === 0) {
      logger.info('Default SAP filters already seeded');
      return;
    }

    await DefaultSapFilter.insertMany(missingFilters, { ordered: false });
    logger.info({
      msg: 'Default SAP filters seeded successfully',
      objectTypes: [...new Set(missingFilters.map((filter) => filter.objectType))],
    });
  } catch (error) {
    logger.error({
      msg: 'Error seeding default SAP filters',
      error,
    });
    throw error;
  }
}

export default seedDefaultSapFilters;
