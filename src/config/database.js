import mongoose from 'mongoose';
import env from './env.js';
import AssociationRegistry from '../db/models/AssociationRegistry.js';
import ClientConfig from '../db/models/ClientConfig.js';
import DealOwnerMapping from '../db/models/DealOwnerMapping.js';
import DealPipelineMapping from '../db/models/DealPipelineMapping.js';
import DealStageMapping from '../db/models/DealStageMapping.js';
import FieldMapping from '../db/models/FieldMapping.js';
import HubspotCredentials from '../db/models/HubspotCredentials.js';
import IntegrationMode from '../db/models/IntegrationMode.js';
import LogEntry from '../db/models/LogEntry.js';
import SyncLog from '../db/models/SyncLog.js';

const { MONGODB_URI } = env;

let connecting;

async function connect() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connecting) {
    await connecting;
    return mongoose.connection;
  }

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined');
  }

  connecting = mongoose.connect(MONGODB_URI);
  await connecting;
  connecting = undefined;
  console.info('Database connected');
  return mongoose.connection;
}

async function disconnect() {
  if (mongoose.connection.readyState === 0) {
    return;
  }
  await mongoose.disconnect();
}

const database = mongoose.connection;

export {
  database,
  connect,
  disconnect,
  IntegrationMode,
  ClientConfig,
  FieldMapping,
  LogEntry,
  SyncLog,
  HubspotCredentials,
  DealPipelineMapping,
  DealStageMapping,
  DealOwnerMapping,
  AssociationRegistry,
};

export default {
  database,
  connect,
  disconnect,
  IntegrationMode,
  ClientConfig,
  FieldMapping,
  LogEntry,
  SyncLog,
  HubspotCredentials,
  DealPipelineMapping,
  DealStageMapping,
  DealOwnerMapping,
  AssociationRegistry,
};
