import { createDefaultSapFilterModel } from '../../models/master/defaultSapFilter.model.js';
import logger from '../../src/core/logger.js';

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
];

export async function seedDefaultSapFilters(masterConnection) {
  try {
    const DefaultSapFilter = createDefaultSapFilterModel(masterConnection);
    const activeFiltersCount = await DefaultSapFilter.countDocuments({ active: true });

    if (activeFiltersCount > 0) {
      logger.info('Default SAP filters already seeded');
      return;
    }

    await DefaultSapFilter.insertMany(BASE_DEFAULT_SAP_FILTERS);
    logger.info('Default SAP filters seeded successfully');
  } catch (error) {
    logger.error({
      msg: 'Error seeding default SAP filters',
      error,
    });
    throw error;
  }
}

export default seedDefaultSapFilters;
