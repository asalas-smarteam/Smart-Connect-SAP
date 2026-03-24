import logger from '../../src/core/logger.js';
import { createMasterClientConfigModel } from '../../models/master/ClientConfig.js';

const BASE_MASTER_CLIENT_CONFIGS = [
  {
    clientName: 'Obtener Productos',
    objectType: 'product',
    // Ejecuta una vez cada 24h; la ejecución diaria a las 3:00 AM depende del scheduler global del sistema.
    intervalMinutes: 1440,
    serviceLayerPath: '/Items',
    active: false,
    syncInTenant: true,
  },
  {
    clientName: 'Obtener contactos',
    objectType: 'contact',
    intervalMinutes: 1440,
    serviceLayerPath: '/BusinessPartners',
    active: false,
    syncInTenant: true,
  },
  {
    clientName: 'Obtener Empresas',
    objectType: 'company',
    intervalMinutes: 1440,
    serviceLayerPath: '/BusinessPartners',
    active: false,
    syncInTenant: true,
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
