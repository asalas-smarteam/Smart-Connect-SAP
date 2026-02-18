import { createRequire } from 'module';
import logger from '../core/logger.js';
import { SaaSClient } from '../config/database.js';
import { getTenantModels } from '../config/tenantDatabase.js';

const pools = {};
// Aquí se almacenarán las conexiones por clientConfigId
// Nota: este módulo solo aplica a bases externas SQL y queda fuera de la migración principal a MongoDB.

const require = createRequire(import.meta.url);

function loadSequelize() {
  try {
    const sequelizeModule = require('sequelize');
    return sequelizeModule?.default ?? sequelizeModule?.Sequelize ?? sequelizeModule;
  } catch (error) {
    throw new Error(
      'External SQL connections are not part of the MongoDB migration. Install sequelize/mysql2 to enable this module.'
    );
  }
}

export function getConnection(config) {
  const key = config?.id;
  if (!key) {
    throw new Error('config.id is required to establish a connection');
  }

  if (pools[key]) {
    return pools[key];
  }

  const Sequelize = loadSequelize();
  const connection = new Sequelize(
    config.externalDbName,
    config.externalDbUser,
    config.externalDbPassword,
    {
      host: config.externalDbHost,
      port: config.externalDbPort,
      dialect: config.externalDbDialect,
      pool: {
        max: 5,
        min: 1,
        acquire: 30000,
        idle: 10000,
      },
      logging: false,
    }
  );

  pools[key] = connection;
  return connection;
}

export async function testExternalConnection(config) {
  const connection = getConnection(config);
  try {
    await connection.authenticate();
    return { ok: true };
  } catch (error) {
    await closeConnection(config.id);
    return { ok: false, error: error.message };
  }
}

export async function closeConnection(clientConfigId) {
  if (pools[clientConfigId]) {
    await pools[clientConfigId].close();
    delete pools[clientConfigId];
  }
}

export async function closeAllConnections() {
  const keys = Object.keys(pools);
  for (const key of keys) {
    await pools[key].close();
    delete pools[key];
  }
}

export async function initializeExternalConnections() {
  const activeClients = await SaaSClient.find({ status: 'active' });

  for (const client of activeClients) {
    const tenantModels = await getTenantModels(client.tenantKey);
    const { ClientConfig } = tenantModels;
    const activeConfigs = await ClientConfig.find({ active: true });

    for (const config of activeConfigs) {
      try {
        await getConnection(config);
        logger.info(`External database connection initialized for client config ${config.id}`);
      } catch (error) {
        logger.error('Error initializing external database connection', {
          clientConfigId: config.id,
          error,
        });
      }
    }
  }
}
