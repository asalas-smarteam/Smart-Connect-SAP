function resolveTenantModels(tenantContext) {
  const tenantModels = tenantContext?.tenantModels;

  if (!tenantModels?.HubspotCredentials) {
    throw new Error('Tenant context with HubspotCredentials model is required');
  }

  return tenantModels;
}

async function resolveQuery(query) {
  if (typeof query?.lean === 'function') {
    return query.lean();
  }

  return query;
}

export class MongooseHubspotCredentialRepository {
  async findByClientConfig({ tenantContext, clientConfig }) {
    const credentialId = clientConfig?.hubspotCredentialId;

    if (!credentialId) {
      return null;
    }

    return this.findById({ tenantContext, credentialId });
  }

  async findById({ tenantContext, credentialId }) {
    if (!credentialId) {
      throw new Error('credentialId is required to find HubSpot credentials');
    }

    const { HubspotCredentials } = resolveTenantModels(tenantContext);
    return resolveQuery(HubspotCredentials.findById(credentialId));
  }
}

export default MongooseHubspotCredentialRepository;
