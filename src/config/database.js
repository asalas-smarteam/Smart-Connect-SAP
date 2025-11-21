import Sequelize, { DataTypes } from 'sequelize';
import env from './env.js';
import defineIntegrationMode from '../db/models/IntegrationMode.js';
import defineClientConfig from '../db/models/ClientConfig.js';
import defineFieldMapping from '../db/models/FieldMapping.js';
import defineLogEntry from '../db/models/LogEntry.js';

const {
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT
} = env;

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: 'mysql',
});

const IntegrationMode = defineIntegrationMode({ sequelize }, DataTypes);
const ClientConfig = defineClientConfig({ sequelize }, DataTypes);
const FieldMapping = defineFieldMapping({ sequelize }, DataTypes);
const LogEntry = defineLogEntry({ sequelize }, DataTypes);

ClientConfig.belongsTo(IntegrationMode, { foreignKey: 'integrationModeId' });
FieldMapping.belongsTo(ClientConfig, { foreignKey: 'clientConfigId' });

async function connect() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });
    console.info('Database connected');
  } catch (error) {
    console.error('Error connecting to the database:', error);
  }
}

export { sequelize, IntegrationMode, ClientConfig, FieldMapping, LogEntry };

export default { sequelize, connect, IntegrationMode, ClientConfig, FieldMapping, LogEntry };
