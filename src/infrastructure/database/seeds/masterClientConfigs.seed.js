import logger from '#infrastructure/logger/logger.js';
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { createMasterClientConfigModel } from '../models/master/ClientConfig.js';

const BASE_MASTER_CLIENT_CONFIGS = [
  {
    clientName: 'Obtener Productos',
    objectType: 'product',
    mode: 'FULL',
    executionTime: '01:00',
    intervalMinutes: null,
    serviceLayerPath: '/Items',
    hubspotBatchSize: 100,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.B1,
  },
  {
    clientName: 'Obtener contactos',
    objectType: 'contact',
    mode: 'FULL',
    executionTime: '02:00',
    intervalMinutes: null,
    serviceLayerPath: '/BusinessPartners',
    hubspotBatchSize: 1,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.B1,
  },
  {
    clientName: 'Obtener Empresas',
    objectType: 'company',
    mode: 'FULL',
    executionTime: '03:00',
    intervalMinutes: null,
    serviceLayerPath: '/BusinessPartners',
    hubspotBatchSize: 1,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.B1,
  },
  {
    clientName: 'Obtener Negocios',
    objectType: 'deal',
    mode: 'INCREMENTAL',
    executionTime: null,
    intervalMinutes: 2,
    serviceLayerPath: '/Orders',
    hubspotBatchSize: 30,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.B1,
  },
  // --- SAP S/4HANA -------------------------------------------------------
  // Entity paths are the Gateway service + entity set. Contacts are the
  // person-BPs reached via to_BusinessPartnerContact; the structure is seeded
  // for every S/4 tenant (even B2B ones like Multiquimica that won't use it),
  // but the runtime extraction is not yet implemented.
  {
    clientName: 'Obtener Productos S4',
    objectType: 'product',
    mode: 'FULL',
    executionTime: '01:00',
    intervalMinutes: null,
    serviceLayerPath: '/API_PRODUCT_SRV/A_Product',
    hubspotBatchSize: 100,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.S4,
  },
  {
    clientName: 'Obtener contactos S4',
    objectType: 'contact',
    mode: 'FULL',
    executionTime: '02:00',
    intervalMinutes: null,
    serviceLayerPath: '/API_BUSINESS_PARTNER/A_BusinessPartner',
    hubspotBatchSize: 1,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.S4,
  },
  {
    clientName: 'Obtener Empresas S4',
    objectType: 'company',
    mode: 'FULL',
    executionTime: '03:00',
    intervalMinutes: null,
    serviceLayerPath: '/API_BUSINESS_PARTNER/A_BusinessPartner',
    hubspotBatchSize: 1,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.S4,
  },
  {
    clientName: 'Obtener Negocios S4',
    objectType: 'deal',
    mode: 'INCREMENTAL',
    executionTime: null,
    intervalMinutes: 2,
    serviceLayerPath: '/API_SALES_ORDER_SRV/A_SalesOrder',
    hubspotBatchSize: 30,
    active: false,
    syncInTenant: true,
    sapFlavor: SAP_FLAVORS.S4,
  },
];

export async function seedMasterClientConfigs(masterConnection) {
  try {
    const MasterClientConfig = createMasterClientConfigModel(masterConnection);

    for (const config of BASE_MASTER_CLIENT_CONFIGS) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await MasterClientConfig.findOne({ clientName: config.clientName })
        .select('_id')
        .lean();

      if (existing) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await MasterClientConfig.create(config);
    }

    logger.info('Master ClientConfigs seed completed');
  } catch (error) {
    logger.error({
      msg: 'Error seeding master ClientConfigs',
      error,
    });
    throw error;
  }
}

export default seedMasterClientConfigs;
