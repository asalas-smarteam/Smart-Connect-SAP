import Sequelize from 'sequelize';

const pools = {};
// Aquí se almacenarán las conexiones por clientConfigId

export function getConnection(config) {
  const key = config?.id;
  if (!key) {
    throw new Error('config.id is required to establish a connection');
  }

  if (pools[key]) {
    return pools[key];
  }

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
