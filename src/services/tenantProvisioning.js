import { SaaSClient, Subscription } from '../config/database.js';
import { buildTenantDatabaseName, getTenantConnection } from '../config/tenantDatabase.js';
import { registerTenantModels } from '../db/models/tenant/index.js';

function slugifyCompanyName(companyName) {
  return companyName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function ensureTenantCollections(connection, models) {
  const existingCollections = await connection.db.listCollections().toArray();
  const existingNames = new Set(existingCollections.map((collection) => collection.name));

  await Promise.all(
    Object.values(models).map(async (model) => {
      const collectionName = model.collection.name;
      if (!existingNames.has(collectionName)) {
        await connection.createCollection(collectionName);
      }
    })
  );
}

async function seedTenantDocuments(models) {
  const seedTasks = [];

  if (!await models.IntegrationMode.exists({ name: 'default' })) {
    seedTasks.push(
      models.IntegrationMode.create({
        name: 'default',
        description: 'Default integration mode',
      })
    );
  }

  if (!await models.ClientConfig.exists({})) {
    seedTasks.push(models.ClientConfig.create({ active: true }));
  }

  await Promise.all(seedTasks);
}

export async function provisionTenant({
  companyName,
  planId,
  billingEmail = null,
  hubspot = null,
}) {
  const slug = slugifyCompanyName(companyName);
  const tenantKey = buildTenantDatabaseName(slug);

  const client = await SaaSClient.create({
    companyName,
    tenantKey,
    status: 'active',
    billingEmail,
    hubspot,
  });

  const subscription = await Subscription.create({
    clientId: client._id,
    planId,
    status: 'active',
    paymentStatus: 'paid',
  });

  const tenantConnection = await getTenantConnection(tenantKey);
  const tenantModels = registerTenantModels(tenantConnection);

  await ensureTenantCollections(tenantConnection, tenantModels);
  await seedTenantDocuments(tenantModels);

  return {
    client,
    subscription,
    tenantKey,
  };
}
