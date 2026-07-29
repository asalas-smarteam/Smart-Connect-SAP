import { createDefaultSapFilterModel } from '../models/master/defaultSapFilter.model.js';
import { DEFAULT_SAP_FLAVOR, SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
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
    objectType: 'invoice',
    property: 'UpdateDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    dynamicType: 'date',
    active: true,
  },
  {
    objectType: 'invoice',
    property: 'UpdateTime',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    dynamicType: 'time',
    active: true,
  },
  // --- SAP S/4HANA -------------------------------------------------------
  // Validated against a live Gateway: `Customer ne ''` isolates the customer
  // role (8.300 of 14.394 business partners have no customer role) and the
  // ZC01/ZC02 grouping split is local vs foreign customer.
  {
    objectType: 'company',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'Customer',
    operator: 'ne',
    value: '',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'company',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'BusinessPartnerGrouping',
    operator: 'in',
    value: ['ZC01', 'ZC02'],
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'company',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'LastChangeDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    dynamicType: 'datetime',
    active: true,
  },
  {
    objectType: 'contact',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'BusinessPartnerCategory',
    operator: 'eq',
    value: '1',
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'contact',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'LastChangeDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    dynamicType: 'datetime',
    active: true,
  },
  {
    objectType: 'product',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'IsMarkedForDeletion',
    operator: 'eq',
    value: false,
    isDefault: true,
    isDynamic: false,
    active: true,
  },
  {
    objectType: 'product',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'LastChangeDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    dynamicType: 'datetime',
    active: true,
  },
  {
    objectType: 'deal',
    sapFlavor: SAP_FLAVORS.S4,
    property: 'LastChangeDate',
    operator: 'ge',
    value: null,
    isDefault: true,
    isDynamic: true,
    dynamicType: 'datetime',
    active: true,
  },
];

export async function seedDefaultSapFilters(masterConnection) {
  try {
    const DefaultSapFilter = createDefaultSapFilterModel(masterConnection);

    // Seed per (flavor, objectType) so new object types AND new SAP flavors
    // are added to installations seeded before they existed, while staying
    // idempotent. Documents predating sapFlavor count as B1.
    const seeded = await DefaultSapFilter
      .find({ active: true }, { objectType: 1, sapFlavor: 1 })
      .lean();
    const seededSet = new Set(
      seeded.map((filter) => `${filter.sapFlavor || DEFAULT_SAP_FLAVOR}|${filter.objectType}`)
    );

    const missingFilters = BASE_DEFAULT_SAP_FILTERS.filter(
      (filter) => !seededSet.has(`${filter.sapFlavor || DEFAULT_SAP_FLAVOR}|${filter.objectType}`)
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
