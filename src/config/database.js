import Sequelize, { DataTypes } from 'sequelize';
import env from './env.js';
import defineIntegrationMode from '../db/models/IntegrationMode.js';
import defineClientConfig from '../db/models/ClientConfig.js';
import defineFieldMapping from '../db/models/FieldMapping.js';
import defineLogEntry from '../db/models/LogEntry.js';
import defineSyncLog from '../db/models/SyncLog.js';
import defineHubspotCredentials from '../db/models/HubspotCredentials.js';
import defineDealPipelineMapping from '../db/models/DealPipelineMapping.js';
import defineDealStageMapping from '../db/models/DealStageMapping.js';
import defineDealOwnerMapping from '../db/models/DealOwnerMapping.js';
import defineAssociationConfig from '../db/models/AssociationConfig.js';

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
const SyncLog = defineSyncLog({ sequelize }, DataTypes);
const HubspotCredentials = defineHubspotCredentials({ sequelize }, DataTypes);
const DealPipelineMapping = defineDealPipelineMapping({ sequelize }, DataTypes);
const DealStageMapping = defineDealStageMapping({ sequelize }, DataTypes);
const DealOwnerMapping = defineDealOwnerMapping({ sequelize }, DataTypes);
const AssociationConfig = defineAssociationConfig({ sequelize }, DataTypes);

ClientConfig.belongsTo(IntegrationMode, { foreignKey: 'integrationModeId' });
FieldMapping.belongsTo(ClientConfig, { foreignKey: 'clientConfigId' });
DealPipelineMapping.hasMany(DealStageMapping, {
  foreignKey: 'hubspotPipelineId',
  sourceKey: 'hubspotPipelineId',
});
DealStageMapping.belongsTo(DealPipelineMapping, {
  foreignKey: 'hubspotPipelineId',
  targetKey: 'hubspotPipelineId',
});

async function connect() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });
    console.info('Database connected');
  } catch (error) {
    console.error('Error connecting to the database:', error);
  }
}

export {
  sequelize,
  IntegrationMode,
  ClientConfig,
  FieldMapping,
  LogEntry,
  SyncLog,
  HubspotCredentials,
  DealPipelineMapping,
  DealStageMapping,
  DealOwnerMapping,
  AssociationConfig
};

export default {
  sequelize,
  connect,
  IntegrationMode,
  ClientConfig,
  FieldMapping,
  LogEntry,
  SyncLog,
  HubspotCredentials,
  DealPipelineMapping,
  DealStageMapping,
  DealOwnerMapping,
  AssociationConfig
};
