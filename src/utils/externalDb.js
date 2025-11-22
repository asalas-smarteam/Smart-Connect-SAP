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

export default createExternalConnection;
