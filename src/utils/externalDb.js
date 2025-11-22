import Sequelize from 'sequelize';

function createExternalConnection(config) {
  const {
    externalDbName,
    externalDbUser,
    externalDbPassword,
    externalDbHost,
    externalDbPort,
    externalDbDialect,
  } = config || {};

  return new Sequelize(externalDbName, externalDbUser, externalDbPassword, {
    host: externalDbHost,
    port: externalDbPort,
    dialect: externalDbDialect,
  });
}

export async function testExternalConnection(config) {
  const externalSequelize = createExternalConnection(config);

  try {
    await externalSequelize.authenticate();
    await externalSequelize.close();
    return { ok: true };
  } catch (error) {
    await externalSequelize.close();
    return { ok: false, error: error.message };
  }
}

export default createExternalConnection;
