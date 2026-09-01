import {
  FeatureFlags,
  GlobalAuditLog,
  PaymentStatus,
  SaaSClient,
  Subscription,
} from '../database/master/database.js';
import { buildTenantDatabaseName, getTenantConnection } from '../database/tenant/tenantDatabase.js';
import { registerTenantModels } from '../database/models/tenant/index.js';
import { BYPASS_EMAIL_CONFIG_KEY } from '#infrastructure/config/BypassEmailConfigRepository.js';
import { DEFAULT_FIND_HUBSPOT_CONFIG_KEY } from '#infrastructure/config/DefaultFindHubspotConfigRepository.js';
import {
  UPDATE_DEAL_STAGE_CONFIG_KEY,
  DEFAULT_UPDATE_DEAL_STAGE_CONFIG,
} from '#infrastructure/config/updateDealStage.config.js';
import {
  UPSERT_DATA_SAP_CONFIG_KEY,
  DEFAULT_UPSERT_DATA_SAP_CONFIG,
} from '#infrastructure/config/upsertDataSap.config.js';
import { sanitizeMongoCollectionName } from '#shared/utils/provisioningValidation.js';
import {
  DEFAULT_SAP_FLAVOR,
  normalizeSapFlavor,
} from '#domain/sap/sap-flavor.constants.js';
import { SAP_FLAVOR_CONFIG_KEY } from '#infrastructure/config/SapFlavorConfigRepository.js';
import {
  DYNAMIC_DESCRIPTION_CONFIG_KEY,
  DEFAULT_DYNAMIC_DESCRIPTION_CONFIG,
} from '#domain/sync/dynamic-description.constants.js';
import { replicateDefaultSapFilters } from './replicateDefaultSapFilters.js';
import {
  BUSINESS_PARTNER_CREATION_CONFIG_KEY,
  PROPERTIES_FLAGS_CONFIG_KEY,
} from '#domain/business-partners/business-partner-creation.constants.js';
import { REQUIRE_ADDRESS_CONFIG_KEY } from '#infrastructure/config/AddressSyncConfigRepository.js';
import {
  DEFAULT_B1_AVAILABLE_FORMULA,
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';

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
  {
    name: 'S4_ODATA',
    description: 'Integración mediante SAP S/4HANA Gateway OData',
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

export async function ensureTenantConfigurations({ Configuration }, { sapFlavor = DEFAULT_SAP_FLAVOR } = {}) {
  if (typeof Configuration?.updateOne !== 'function') {
    return;
  }

  await Configuration.updateOne(
    { key: SAP_FLAVOR_CONFIG_KEY },
    {
      $setOnInsert: {
        key: SAP_FLAVOR_CONFIG_KEY,
        userUpdated: 'admin',
        value: sapFlavor,
      },
    },
    { upsert: true }
  );
  await Configuration.updateOne(
    { key: BYPASS_EMAIL_CONFIG_KEY },
    {
      $setOnInsert: {
        key: BYPASS_EMAIL_CONFIG_KEY,
        userUpdated: 'admin',
        value: false,
      },
    },
    { upsert: true }
  );
  await Configuration.updateOne(
    { key: DEFAULT_FIND_HUBSPOT_CONFIG_KEY },
    {
      $setOnInsert: {
        key: DEFAULT_FIND_HUBSPOT_CONFIG_KEY,
        userUpdated: 'admin',
        value: 'idsap',
      },
    },
    { upsert: true }
  );
  // Seeded disabled so the document is discoverable in the admin UI; a tenant
  // turns it on by setting isRequired and filling in the template.
  await Configuration.updateOne(
    { key: DYNAMIC_DESCRIPTION_CONFIG_KEY },
    {
      $setOnInsert: {
        key: DYNAMIC_DESCRIPTION_CONFIG_KEY,
        userUpdated: 'admin',
        value: { ...DEFAULT_DYNAMIC_DESCRIPTION_CONFIG },
      },
    },
    { upsert: true }
  );
  await Configuration.updateOne(
    { key: UPDATE_DEAL_STAGE_CONFIG_KEY },
    {
      $setOnInsert: {
        key: UPDATE_DEAL_STAGE_CONFIG_KEY,
        userUpdated: 'admin',
        value: { ...DEFAULT_UPDATE_DEAL_STAGE_CONFIG, dealstage: 'closedwon' },
      },
    },
    { upsert: true }
  );
  // Seeded disabled (required: false) so the document is discoverable in the admin
  // UI without changing behavior for any existing tenant.
  await Configuration.updateOne(
    { key: UPSERT_DATA_SAP_CONFIG_KEY },
    {
      $setOnInsert: {
        key: UPSERT_DATA_SAP_CONFIG_KEY,
        userUpdated: 'admin',
        value: { ...DEFAULT_UPSERT_DATA_SAP_CONFIG },
      },
    },
    { upsert: true }
  );
  // Sembradas apagadas (legacyWhitelist / none) para que el documento sea
  // visible en el admin sin cambiar la conducta de ningún tenant. Un cliente
  // las activa cambiando payloadStrategy y llenando addresses.byName.
  await Configuration.updateOne(
    { key: BUSINESS_PARTNER_CREATION_CONFIG_KEY },
    {
      $setOnInsert: {
        key: BUSINESS_PARTNER_CREATION_CONFIG_KEY,
        userUpdated: 'admin',
        value: {
          payloadStrategy: 'legacyWhitelist',
          contactEmployeeSource: 'dealContact',
          defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
          addresses: { strategy: 'none', byName: {}, required: [] },
        },
      },
    },
    { upsert: true }
  );
  await Configuration.updateOne(
    { key: PROPERTIES_FLAGS_CONFIG_KEY },
    {
      $setOnInsert: {
        key: PROPERTIES_FLAGS_CONFIG_KEY,
        userUpdated: 'admin',
        value: {
          strategy: 'none',
          hubspotProperty: null,
          min: 1,
          max: 64,
          trueValue: 'tYES',
        },
      },
    },
    { upsert: true }
  );
  // Sembrada apagada: la sincronización de direcciones SAP -> HubSpot no está
  // implementada todavía. El documento existe para que sea visible en el admin.
  await Configuration.updateOne(
    { key: REQUIRE_ADDRESS_CONFIG_KEY },
    {
      $setOnInsert: {
        key: REQUIRE_ADDRESS_CONFIG_KEY,
        userUpdated: 'admin',
        value: { required: false },
      },
    },
    { upsert: true }
  );
  // Sembrada con el calculo historico de disponible por bodega en B1
  // (InStock - Committed + Ordered). Se cambia editando el documento; nunca hay
  // que crear la clave a mano. Se copian los arrays porque la constante esta
  // congelada y un Object.freeze dentro de un $setOnInsert es un bug dificil
  // de ver si Mongoose intenta mutarlo.
  await Configuration.updateOne(
    { key: WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY },
    {
      $setOnInsert: {
        key: WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
        userUpdated: 'admin',
        value: {
          add: [...DEFAULT_B1_AVAILABLE_FORMULA.add],
          subtract: [...DEFAULT_B1_AVAILABLE_FORMULA.subtract],
        },
      },
    },
    { upsert: true }
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
  sapFlavor = DEFAULT_SAP_FLAVOR,
}) {
  const slug = slugifyCompanyName(companyName);
  const tenantKey = buildTenantDatabaseName(slug);
  // Defensive normalization: invalid/absent values resolve to B1 so callers
  // that predate this field keep provisioning tenants exactly as before.
  const resolvedSapFlavor = normalizeSapFlavor(sapFlavor) || DEFAULT_SAP_FLAVOR;

  try {
    await ensureGlobalDocuments({ planId });

    const client = await SaaSClient.create({
      companyName,
      tenantKey,
      status: 'active',
      billingEmail,
      hubspot,
      sapFlavor: resolvedSapFlavor,
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
    await ensureTenantConfigurations(tenantModels, { sapFlavor: resolvedSapFlavor });
    await replicateDefaultSapFilters({
      masterConnection: FeatureFlags.db,
      tenantConnection,
      sapFlavor: resolvedSapFlavor,
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
        sapFlavor: resolvedSapFlavor,
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
          sapFlavor: resolvedSapFlavor,
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
