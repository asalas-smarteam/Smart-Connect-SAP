import {
  FeatureFlags,
  GlobalAuditLog,
  PaymentStatus,
  SaaSClient,
  Subscription,
} from '../config/database.js';
import { buildTenantDatabaseName, getTenantConnection } from '../config/tenantDatabase.js';
import { registerTenantModels } from '../db/models/tenant/index.js';
import { sanitizeMongoCollectionName } from '../utils/provisioningValidation.js';
import { replicateDefaultSapFilters } from './tenant/replicateDefaultSapFilters.js';

function slugifyCompanyName(companyName) {
  return sanitizeMongoCollectionName(companyName);
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

const defaultIntegrationModes = [
  {
    name: 'API',
    description: 'Integración mediante API del cliente',
  },
  {
    name: 'STORE_PROCEDURE',
    description: 'Integración mediante stored procedure',
  },
  {
    name: 'SQL_SCRIPT',
    description: 'Integración mediante script SQL',
  },
  {
    name: 'SERVICE_LAYER',
    description: 'Integración mediante SAP Business One Service Layer',
  },
];

async function ensureIntegrationModes({ IntegrationMode }) {
  await Promise.all(
    defaultIntegrationModes.map((mode) => IntegrationMode.updateOne(
      { name: mode.name },
      { $setOnInsert: mode },
      { upsert: true }
    ))
  );
}

async function resolveHubspotCredential({ hubspot, tenantModels }) {
  if (!hubspot || !tenantModels?.HubspotCredentials) {
    return null;
  }

  if (hubspot.hubspotCredentialId) {
    return tenantModels.HubspotCredentials.findById(hubspot.hubspotCredentialId);
  }

  if (!hubspot.accessToken) {
    return null;
  }

  return tenantModels.HubspotCredentials.create({
    portalId: hubspot.portalId ?? null,
    accessToken: hubspot.accessToken,
    refreshToken: hubspot.refreshToken ?? null,
    expiresAt: hubspot.expiresAt ?? null,
    scope: hubspot.scope ?? null,
  });
}


async function ensureGlobalDocuments({ planId }) {
  const featureFlags = [
    {
      key: 'sap_sync',
      description: 'Enable SAP synchronization features',
      enabled: true,
    },
  ];

  for (const flag of featureFlags) {
    // Paso 1: crear documento si no existe
    await FeatureFlags.updateOne(
      { key: flag.key },
      {
        $setOnInsert: {
          ...flag,
          allowedPlanIds: [],
        },
      },
      { upsert: true }
    );

    // Paso 2: agregar el plan (idempotente)
    await FeatureFlags.updateOne(
      { key: flag.key },
      {
        $addToSet: { allowedPlanIds: planId },
      }
    );
  }
}

/*
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
}*/

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
    await ensureIntegrationModes(tenantModels);
    await replicateDefaultSapFilters({
      masterConnection: FeatureFlags.db,
      tenantConnection,
    });

    await resolveHubspotCredential({
      hubspot,
      tenantModels,
    });
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
