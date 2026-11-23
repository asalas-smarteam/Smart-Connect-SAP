import { jest } from '@jest/globals';
import SetupStaticHubspotTenant from '../../../src/application/use-cases/SetupStaticHubspotTenant.js';

const TOKEN = 'test-token';
const PORTAL = '12345';

function build({ client, existingConfig = null, existingCreds = null, countsAfter = [1, 4], seedError = null } = {}) {
  const calls = [];
  const track = (name, impl) =>
    jest.fn(async (...args) => {
      calls.push(name);
      return impl ? impl(...args) : undefined;
    });

  const credentials = { _id: 'cred-1', save: track('credentials.save') };
  const clientConfig = { _id: 'cfg-1' };
  const counts = [...countsAfter];
  const tenantModels = {
    ClientConfig: {
      findOne: jest.fn(async () => existingConfig),
      countDocuments: jest.fn(async () => counts.shift() ?? 99),
    },
    HubspotCredentials: { findOne: jest.fn(async () => existingCreds) },
  };
  const tenantRepository = {
    findClientByTenantKey: jest.fn(async () =>
      client === undefined ? { tenantKey: 'acme', hubspot: {}, save: jest.fn() } : client
    ),
    getTenantModels: jest.fn(async () => tenantModels),
    getTenantConnection: jest.fn(async () => ({ conn: true })),
    ensureHubspotCredential: track('ensure', async () => ({ clientConfig, credentials })),
    updateClientHubspotPortal: track('portal'),
  };
  const masterConfigReplicator = { replicate: track('replicate') };
  const tenantHubspotSeeder = {
    seed: track('seed', async () => {
      if (seedError) throw seedError;
    }),
  };
  const sapFlavorResolver = { resolveSapFlavor: jest.fn(async () => 'S4') };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const useCase = new SetupStaticHubspotTenant({
    tenantRepository,
    masterConfigReplicator,
    tenantHubspotSeeder,
    sapFlavorResolver,
    logger,
  });
  return { useCase, calls, credentials, tenantRepository, masterConfigReplicator, tenantHubspotSeeder, logger, tenantModels };
}

const run = (useCase, extra = {}) =>
  useCase.execute({ tenantKey: 'acme', portalId: PORTAL, accessToken: TOKEN, apply: true, ...extra });

describe('SetupStaticHubspotTenant', () => {
  it('writes nothing on a dry run and describes what it would do', async () => {
    const ctx = build();
    const summary = await run(ctx.useCase, { apply: false });

    expect(ctx.calls).toEqual([]);
    expect(ctx.tenantRepository.ensureHubspotCredential).not.toHaveBeenCalled();
    expect(ctx.masterConfigReplicator.replicate).not.toHaveBeenCalled();
    expect(ctx.tenantHubspotSeeder.seed).not.toHaveBeenCalled();
    expect(summary.applied).toBe(false);
    expect(summary.wouldCreateBaseConfig).toBe(true);
    expect(summary.wouldCreateCredentials).toBe(true);
    expect(summary.wouldSetClientPortal).toBe(true);
  });

  it('applies the steps in order', async () => {
    const ctx = build();
    await run(ctx.useCase);

    expect(ctx.calls).toEqual(['ensure', 'credentials.save', 'portal', 'replicate', 'seed']);
    expect(ctx.tenantRepository.ensureHubspotCredential).toHaveBeenCalledWith(
      expect.objectContaining({ portalId: PORTAL })
    );
    expect(ctx.masterConfigReplicator.replicate).toHaveBeenCalledWith(
      expect.objectContaining({ hubspotCredentialId: 'cred-1' })
    );
    expect(ctx.tenantHubspotSeeder.seed).toHaveBeenCalledWith(
      expect.objectContaining({ sapFlavor: 'S4', credentials: ctx.credentials })
    );
  });

  it('stores a static token with a far-future expiry and no refresh token', async () => {
    const ctx = build();
    ctx.credentials.refreshToken = 'old-refresh';
    await run(ctx.useCase);

    expect(ctx.credentials.accessToken).toBe(TOKEN);
    expect(ctx.credentials.portalId).toBe(PORTAL);
    expect(ctx.credentials.refreshToken).toBeUndefined();
    expect(ctx.credentials.expiresAt.getUTCFullYear()).toBe(2099);
  });

  it('never exposes the token in the summary or the logger calls', async () => {
    const ctx = build({ seedError: new Error(`boom ${TOKEN} boom`) });
    const summary = await run(ctx.useCase);

    expect(JSON.stringify(summary)).not.toContain(TOKEN);
    const logged = JSON.stringify([
      ctx.logger.info.mock.calls,
      ctx.logger.warn.mock.calls,
      ctx.logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(TOKEN);
  });

  it('rejects a portal that differs from the one already on the client', async () => {
    const ctx = build({ client: { tenantKey: 'acme', hubspot: { portalId: '999' } } });

    await expect(run(ctx.useCase)).rejects.toThrow(/portal/i);
    expect(ctx.calls).toEqual([]);
  });

  it('rejects a missing client', async () => {
    const ctx = build({ client: null });

    await expect(run(ctx.useCase)).rejects.toThrow(/not found/i);
    expect(ctx.calls).toEqual([]);
  });

  it('reports a seed error instead of throwing it', async () => {
    const ctx = build({ seedError: new Error('seed failed') });
    const summary = await run(ctx.useCase);

    expect(summary.seed).toEqual({ ok: false, error: 'seed failed' });
  });

  it('reports a successful seed', async () => {
    const ctx = build();
    const summary = await run(ctx.useCase);

    expect(summary.seed).toEqual({ ok: true });
    expect(summary.replicatedConfigs).toBe(3);
  });

  it('is idempotent: a second run reuses existing documents and adds nothing', async () => {
    const ctx = build({
      client: { tenantKey: 'acme', hubspot: { portalId: PORTAL } },
      existingConfig: { _id: 'cfg-1' },
      existingCreds: { _id: 'cred-1' },
      countsAfter: [4, 4],
    });
    const summary = await run(ctx.useCase);

    expect(summary.baseConfigCreated).toBe(false);
    expect(summary.credentialsCreated).toBe(false);
    expect(summary.clientPortalSet).toBe(false);
    expect(ctx.tenantRepository.updateClientHubspotPortal).not.toHaveBeenCalled();
    expect(summary.replicatedConfigs).toBe(0);
    expect(summary.warnings).toEqual([]);
  });

  it('warns loudly when replication produces no configs', async () => {
    const ctx = build({ countsAfter: [1, 1] });
    const summary = await run(ctx.useCase);

    expect(summary.replicatedConfigs).toBe(0);
    expect(summary.warnings.join(' ')).toMatch(/master/i);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});
