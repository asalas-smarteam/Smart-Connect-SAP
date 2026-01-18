import {
  FeatureFlags,
  GlobalAuditLog,
  PaymentStatus,
  SaaSClient,
  Subscription,
} from '../config/database.js';
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

async function ensureGlobalDocuments({ planId }) {
  const paymentStatuses = [
    {
      code: 'paid',
      label: 'Paid',
      description: 'Payment completed successfully',
    },
    {
      code: 'unpaid',
      label: 'Unpaid',
      description: 'Payment not received',
    },
    {
      code: 'pending',
      label: 'Pending',
      description: 'Payment is awaiting confirmation',
    },
  ];

  const featureFlags = [
    {
      key: 'sap_sync',
      description: 'Enable SAP synchronization features',
      enabled: true,
    },
  ];

  await Promise.all([
    ...paymentStatuses.map((status) => PaymentStatus.updateOne(
      { code: status.code },
      { $setOnInsert: status },
      { upsert: true }
    )),
    ...featureFlags.map((flag) => FeatureFlags.updateOne(
      { key: flag.key },
      {
        $setOnInsert: {
          ...flag,
          allowedPlanIds: [planId],
        },
        $addToSet: {
          allowedPlanIds: planId,
        },
      },
      { upsert: true }
    )),
  ]);
}

export async function provisionTenant({
  companyName,
  planId,
  billingEmail = null,
  hubspot = null,
}) {
  const slug = slugifyCompanyName(companyName);
  const tenantKey = buildTenantDatabaseName(slug);

  try {
    await ensureGlobalDocuments({ planId });

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
    // Strategy: only create collections during provisioning; tests/fixtures must insert data as needed.

    await GlobalAuditLog.create({
      action: 'tenant.provisioned',
      tenantKey,
      resourceType: 'SaaSClient',
      resourceId: client._id.toString(),
      payload: {
        companyName,
        planId,
        billingEmail,
        hubspot,
        subscriptionId: subscription._id.toString(),
      },
    });

    return {
      client,
      subscription,
      tenantKey,
    };
  } catch (error) {
    try {
      await GlobalAuditLog.create({
        action: 'tenant.provisioning_failed',
        tenantKey,
        payload: {
          companyName,
          planId,
          billingEmail,
          hubspot,
          error: {
            message: error?.message ?? 'Unknown error',
            stack: error?.stack ?? null,
          },
        },
      });
    } catch (logError) {
      console.error('Failed to record provisioning error audit log', logError);
    }
    throw error;
  }
}
