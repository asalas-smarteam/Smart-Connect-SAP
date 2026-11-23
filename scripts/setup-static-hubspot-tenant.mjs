// scripts/setup-static-hubspot-tenant.mjs
//
// Connects an existing tenant to HubSpot with a static private-app token, replacing the
// OAuth init + callback. It links the credentials to a base ClientConfig, records the portal
// on the tenant, replicates the master ClientConfigs and runs the HubSpot seed. The seed
// result is reported, not swallowed. Idempotent: a repeat run creates no duplicates.
//
// The token is read ONLY from the HUBSPOT_STATIC_TOKEN environment variable: it is never an
// argument and is never printed or logged. Dry run by default: without --apply nothing is
// written.
//
// Usage (inside the api container, where the production env is available):
//   docker compose exec -T -e HUBSPOT_STATIC_TOKEN="$(cat token-file)" api \
//     node scripts/setup-static-hubspot-tenant.mjs <tenantKey> <portalId> --apply
//
// Dry run:
//   docker compose exec -T api node scripts/setup-static-hubspot-tenant.mjs <tenantKey> <portalId>
import dotenv from 'dotenv';
import SetupStaticHubspotTenant from '../src/application/use-cases/SetupStaticHubspotTenant.js';
import OAuthTenantRepository from '../src/infrastructure/database/repositories/OAuthTenantRepository.js';
import {
  MasterConfigReplicatorAdapter,
  TenantHubspotSeederAdapter,
} from '../src/infrastructure/hubspot/TenantHubspotSeederAdapter.js';
import SapFlavorConfigRepository from '../src/infrastructure/config/SapFlavorConfigRepository.js';
import logger from '../src/infrastructure/logger/logger.js';
import db, { SaaSClient } from '../src/infrastructure/database/master/master-db.js';
import { disconnectTenantConnections } from '../src/infrastructure/database/tenant/tenant-db.js';

dotenv.config();

const [, , tenantKey, portalId, ...flags] = process.argv;
const apply = flags.includes('--apply');
const accessToken = process.env.HUBSPOT_STATIC_TOKEN;

function usage(message) {
  console.error(message);
  console.error(
    'Usage: HUBSPOT_STATIC_TOKEN=<token> node scripts/setup-static-hubspot-tenant.mjs <tenantKey> <portalId> [--apply]'
  );
  process.exit(1);
}

if (!tenantKey || !portalId) {
  usage('Missing tenantKey or portalId.');
}
if (apply && !accessToken) {
  usage('HUBSPOT_STATIC_TOKEN is not set; refusing to apply without it.');
}

// OAuthTenantRepository only looks clients up by id; the tenant key is what an operator has.
class StaticSetupTenantRepository extends OAuthTenantRepository {
  async findClientByTenantKey(key) {
    return SaaSClient.findOne({ tenantKey: key });
  }
}

let exitCode = 0;
try {
  await db.connect();
  const useCase = new SetupStaticHubspotTenant({
    tenantRepository: new StaticSetupTenantRepository(),
    masterConfigReplicator: new MasterConfigReplicatorAdapter(),
    tenantHubspotSeeder: new TenantHubspotSeederAdapter(),
    sapFlavorResolver: new SapFlavorConfigRepository(),
    logger,
  });
  const summary = await useCase.execute({ tenantKey, portalId, accessToken, apply });
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log('Dry run: nothing was written. Re-run with --apply to write.');
  }
  if (summary.seed && !summary.seed.ok) {
    exitCode = 2;
  }
} catch (error) {
  console.error(`Failed: ${error.message}`);
  exitCode = 1;
} finally {
  await disconnectTenantConnections().catch(() => {});
  await db.disconnect().catch(() => {});
}
process.exit(exitCode);
