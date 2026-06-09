function resolveTenantModels(tenantContext) {
  const tenantModels = tenantContext?.tenantModels;

  if (!tenantModels?.ClientConfig) {
    throw new Error('Tenant context with ClientConfig model is required');
  }

  return tenantModels;
}

function normalizeConfig(config) {
  return config ?? null;
}

export class MongooseClientConfigRepository {
  async findById({ tenantContext, configId }) {
    if (!configId) {
      throw new Error('configId is required to find a client configuration');
    }

    const { ClientConfig } = resolveTenantModels(tenantContext);
    const query = ClientConfig.findById(configId);

    if (typeof query?.populate === 'function') {
      return normalizeConfig(await query.populate({
        path: 'integrationModeId',
        select: 'name',
      }));
    }

    return normalizeConfig(await query);
  }

  async markSyncSucceeded({ tenantContext, configId, lastRun }) {
    if (!configId) {
      throw new Error('configId is required to mark SAP sync success');
    }

    const { ClientConfig } = resolveTenantModels(tenantContext);
    await ClientConfig.updateOne(
      { _id: configId },
      { $set: { lastRun, lastError: null } }
    );

    return { id: configId, lastRun, lastError: null };
  }

  async markSyncFailed({ tenantContext, configId, errorMessage }) {
    if (!configId) {
      throw new Error('configId is required to mark SAP sync failure');
    }

    const { ClientConfig } = resolveTenantModels(tenantContext);
    await ClientConfig.updateOne(
      { _id: configId },
      { $set: { lastError: errorMessage } }
    );

    return { id: configId, lastError: errorMessage };
  }
}

export default MongooseClientConfigRepository;
