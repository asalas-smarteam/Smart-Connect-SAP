// Connects a tenant to HubSpot with a static private-app token instead of the OAuth flow.
//
// With a static token neither the OAuth init nor the callback runs, and they are the only
// place that links the credentials to a base ClientConfig, records the portal on the client,
// replicates the master ClientConfigs and seeds the HubSpot portal. This use case runs those
// same steps through the same collaborators.
//
// The token is never returned, logged or included in a reported error.

// hubspotAuthService.getAccessToken uses a stored token as is while expiresAt is in the
// future, so a static token needs a far-future expiry and no refresh token.
const STATIC_TOKEN_EXPIRES_AT = new Date('2099-12-31T00:00:00.000Z');

function redact(message, secret) {
  const text = String(message ?? '');
  return secret ? text.split(secret).join('[redacted]') : text;
}

export class SetupStaticHubspotTenant {
  constructor({
    tenantRepository,
    masterConfigReplicator,
    tenantHubspotSeeder,
    sapFlavorResolver = null,
    logger = console,
  }) {
    this.tenantRepository = tenantRepository;
    this.masterConfigReplicator = masterConfigReplicator;
    this.tenantHubspotSeeder = tenantHubspotSeeder;
    this.sapFlavorResolver = sapFlavorResolver;
    this.logger = logger;
  }

  async execute({ tenantKey, portalId, accessToken, apply = false }) {
    if (!tenantKey || !portalId) {
      throw new Error('tenantKey and portalId are required');
    }
    if (apply && !accessToken) {
      throw new Error('accessToken is required to apply');
    }
    const portal = String(portalId);

    const client = await this.tenantRepository.findClientByTenantKey(tenantKey);
    if (!client) {
      throw new Error(`Tenant not found: ${tenantKey}`);
    }
    const clientPortal = client.hubspot?.portalId;
    if (clientPortal && String(clientPortal) !== portal) {
      throw new Error(
        `Portal mismatch: the tenant is registered with portal ${clientPortal}, not ${portal}`
      );
    }

    const tenantModels = await this.tenantRepository.getTenantModels(client.tenantKey ?? tenantKey);
    const { ClientConfig, HubspotCredentials } = tenantModels;

    const existingConfig = await ClientConfig.findOne();
    const existingCredentials = existingConfig
      ? await HubspotCredentials.findOne({ clientConfigId: existingConfig._id })
      : null;
    const clientPortalMissing = !clientPortal;
    const configsBefore = await ClientConfig.countDocuments({});

    if (!apply) {
      return {
        applied: false,
        tenantKey,
        portalId: portal,
        wouldCreateBaseConfig: !existingConfig,
        wouldCreateCredentials: !existingCredentials,
        wouldSetClientPortal: clientPortalMissing,
        wouldReplicateMasterConfigs: true,
        wouldRunSeed: true,
        existingConfigs: configsBefore,
        warnings: [],
      };
    }

    const { clientConfig, credentials } = await this.tenantRepository.ensureHubspotCredential({
      tenantModels,
      client,
      portalId: portal,
    });

    credentials.accessToken = accessToken;
    credentials.portalId = portal;
    credentials.expiresAt = STATIC_TOKEN_EXPIRES_AT;
    credentials.refreshToken = undefined;
    await credentials.save();

    if (clientPortalMissing) {
      await this.tenantRepository.updateClientHubspotPortal({ client, portalId: portal });
    }

    await this.masterConfigReplicator.replicate({
      tenantModels,
      hubspotCredentialId: credentials._id,
    });
    const configsAfter = await ClientConfig.countDocuments({});
    const replicatedConfigs = Math.max(0, configsAfter - configsBefore);

    // A repeat run legitimately replicates nothing, so only warn when no replicated
    // config exists at all (just the base one), which points at missing master templates.
    const warnings = [];
    if (replicatedConfigs === 0 && configsAfter <= 1) {
      const warning =
        'No master ClientConfigs were replicated; the master templates may be missing for this SAP flavor';
      warnings.push(warning);
      this.logger.warn?.({ msg: warning, tenantKey });
    }

    const seed = await this.#seed({ tenantKey, credentials, secret: accessToken });

    return {
      applied: true,
      tenantKey,
      portalId: portal,
      clientConfigId: String(clientConfig._id),
      credentialsId: String(credentials._id),
      baseConfigCreated: !existingConfig,
      credentialsCreated: !existingCredentials,
      clientPortalSet: clientPortalMissing,
      replicatedConfigs,
      totalConfigs: configsAfter,
      seed,
      warnings,
    };
  }

  async #seed({ tenantKey, credentials, secret }) {
    try {
      const tenantConnection = await this.tenantRepository.getTenantConnection(tenantKey);
      const tenantModels = await this.tenantRepository.getTenantModels(tenantKey);
      const sapFlavor = await this.sapFlavorResolver?.resolveSapFlavor({ tenantModels });
      await this.tenantHubspotSeeder.seed({ tenantConnection, credentials, sapFlavor });
      return { ok: true };
    } catch (error) {
      const message = redact(error?.message, secret);
      this.logger.error?.({ msg: 'HubSpot tenant seed failed', tenantKey, error: message });
      return { ok: false, error: message };
    }
  }
}

export default SetupStaticHubspotTenant;
