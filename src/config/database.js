import { MongoClient, ObjectId } from 'mongodb';
import env from './env.js';

const { MONGODB_URI } = env;

let client;
let database;
let connecting;

const isValidObjectId = (value) =>
  typeof value === 'string' && ObjectId.isValid(value);

const toObjectId = (value) => (isValidObjectId(value) ? new ObjectId(value) : value);

const normalizeDocument = (collection, doc) => {
  if (!doc) {
    return null;
  }

  return {
    ...doc,
    id: doc._id ? doc._id.toString() : doc.id,
    update: async (changes) => {
      if (!doc._id) {
        return null;
      }
      await collection.updateOne({ _id: doc._id }, { $set: changes });
      const updated = await collection.findOne({ _id: doc._id });
      return normalizeDocument(collection, updated);
    },
  };
};

const buildFilter = (where = {}) => {
  const filter = { ...where };
  if ('id' in filter) {
    filter._id = toObjectId(filter.id);
    delete filter.id;
  }
  if ('_id' in filter) {
    filter._id = toObjectId(filter._id);
  }
  return filter;
};

async function connect() {
  if (database) {
    return database;
  }
  if (connecting) {
    await connecting;
    return database;
  }
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined');
  }

  client = new MongoClient(MONGODB_URI);
  connecting = client.connect();
  await connecting;
  database = client.db();
  connecting = null;
  console.info('Database connected');
  return database;
}

async function disconnect() {
  if (!client) {
    return;
  }
  await client.close();
  client = undefined;
  database = undefined;
}

const createCollectionModel = (collectionName) => ({
  collectionName,
  async findByPk(id, options = {}) {
    await connect();
    const collection = database.collection(collectionName);
    const filter = buildFilter({ _id: id });
    const doc = await collection.findOne(filter, options);
    return normalizeDocument(collection, doc);
  },
  async findOne(options = {}) {
    await connect();
    const collection = database.collection(collectionName);
    const filter = buildFilter(options.where);
    const doc = await collection.findOne(filter);
    return normalizeDocument(collection, doc);
  },
  async findAll(options = {}) {
    await connect();
    const collection = database.collection(collectionName);
    const filter = buildFilter(options.where);
    const cursor = collection.find(filter);
    const docs = await cursor.toArray();
    return docs.map((doc) => normalizeDocument(collection, doc));
  },
  async create(payload) {
    await connect();
    const collection = database.collection(collectionName);
    const { insertedId } = await collection.insertOne(payload);
    const doc = await collection.findOne({ _id: insertedId });
    return normalizeDocument(collection, doc);
  },
  belongsTo() {},
  hasMany() {},
});

const IntegrationMode = createCollectionModel('IntegrationModes');
const ClientConfig = createCollectionModel('ClientConfigs');
const FieldMapping = createCollectionModel('FieldMappings');
const LogEntry = createCollectionModel('LogEntries');
const SyncLog = createCollectionModel('SyncLogs');
const HubspotCredentials = createCollectionModel('HubspotCredentials');
const DealPipelineMapping = createCollectionModel('DealPipelineMappings');
const DealStageMapping = createCollectionModel('DealStageMappings');
const DealOwnerMapping = createCollectionModel('DealOwnerMappings');
const AssociationRegistry = createCollectionModel('AssociationRegistries');

ClientConfig.belongsTo(IntegrationMode);
FieldMapping.belongsTo(ClientConfig);
DealPipelineMapping.hasMany(DealStageMapping);
DealStageMapping.belongsTo(DealPipelineMapping);

export {
  client,
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
  client,
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
