import mongoose from 'mongoose';
import env from '../../src/config/env.js';

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || env.MONGODB_URI;
const TENANT_DB_PREFIX = env.TENANT_DB_PREFIX || process.env.TENANT_DB_PREFIX || 'sap_integration';

const PIPELINE_COLLECTION = 'DealPipelineMappings';
const STAGE_COLLECTION = 'DealStageMappings';
const TENANTS_COLLECTION = 'SaaSClients';

function buildTenantDatabaseName(tenantKey) {
  if (!tenantKey) {
    return null;
  }

  if (tenantKey.startsWith(`${TENANT_DB_PREFIX}_`)) {
    return tenantKey;
  }

  return `${TENANT_DB_PREFIX}_${tenantKey}`;
}

function indexMatchesKey(index, key) {
  const indexKey = JSON.stringify(index.key || {});
  return indexKey === JSON.stringify(key);
}

async function dropIndexByNameOrKey(collection, { name, key }) {
  let indexes;

  try {
    indexes = await collection.indexes();
  } catch (error) {
    if (error?.codeName === 'NamespaceNotFound') {
      console.info(`  - Collection not found (skip drop index): ${collection.collectionName}`);
      return;
    }
    throw error;
  }
  const existing = indexes.find((index) => index.name === name || indexMatchesKey(index, key));

  if (!existing) {
    console.info(`  - Index not found (skip): ${name}`);
    return;
  }

  await collection.dropIndex(existing.name);
  console.info(`  - Dropped index: ${existing.name}`);
}

async function ensureIndexes(connection) {
  const pipelineCollection = connection.collection(PIPELINE_COLLECTION);
  const stageCollection = connection.collection(STAGE_COLLECTION);

  await dropIndexByNameOrKey(pipelineCollection, {
    name: 'idx_unique_pipeline_mapping',
    key: { hubspotCredentialId: 1, sapPipelineKey: 1 },
  });

  await dropIndexByNameOrKey(stageCollection, {
    name: 'idx_unique_stage_mapping',
    key: { hubspotCredentialId: 1, sapStageKey: 1, hubspotPipelineId: 1 },
  });

  await pipelineCollection.createIndexes([
    {
      key: { hubspotCredentialId: 1, hubspotPipelineId: 1 },
      name: 'uniq_hubspot_pipeline_mapping',
      unique: true,
    },
    {
      key: { hubspotCredentialId: 1, sapPipelineKey: 1 },
      name: 'uniq_sap_pipeline_mapping_partial',
      unique: true,
      partialFilterExpression: { sapPipelineKey: { $type: 'string' } },
    },
  ]);

  await stageCollection.createIndexes([
    {
      key: { hubspotCredentialId: 1, hubspotPipelineId: 1, hubspotStageId: 1 },
      name: 'uniq_hubspot_stage_mapping',
      unique: true,
    },
    {
      key: { hubspotCredentialId: 1, hubspotPipelineId: 1, sapStageKey: 1 },
      name: 'uniq_sap_stage_mapping_partial',
      unique: true,
      partialFilterExpression: { sapStageKey: { $type: 'string' } },
    },
  ]);

  console.info('  - Indexes ensured for pipeline/stage mappings');
}

async function run() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI or MONGODB_URI is required');
  }

  await mongoose.connect(MONGO_URI);
  console.info('Connected to MongoDB');

  const globalDb = mongoose.connection.db;
  const tenants = await globalDb.collection(TENANTS_COLLECTION).find({}, { projection: { tenantKey: 1 } }).toArray();

  if (tenants.length === 0) {
    console.info('No tenants found. Nothing to migrate.');
    return;
  }

  for (const tenant of tenants) {
    const tenantDbName = buildTenantDatabaseName(tenant.tenantKey);

    if (!tenantDbName) {
      console.warn(`Skipping tenant with invalid tenantKey: ${tenant?._id || 'unknown'}`);
      continue;
    }

    const tenantConnection = await mongoose.createConnection(MONGO_URI, {
      dbName: tenantDbName,
    }).asPromise();

    try {
      console.info(`Processing tenant DB: ${tenantDbName}`);
      await ensureIndexes(tenantConnection);
      console.info(`Finished tenant DB: ${tenantDbName}`);
    } finally {
      await tenantConnection.close();
    }
  }

  console.info('Migration completed for all tenants');
}

run()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
