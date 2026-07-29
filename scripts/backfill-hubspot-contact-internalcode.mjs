// scripts/backfill-hubspot-contact-internalcode.mjs
//
// One-off backfill that completes the S/4 contact-identity migration.
//
// migrate-s4-contact-internalcode.mjs moves the MAPPING (BusinessPartner now
// targets `internalcode` instead of `idsap`), so from then on payloads carry
// `internalcode`. But the contacts ALREADY in HubSpot still carry the value in
// `idsap` with `internalcode` empty, so the identity tier misses forever: email
// resolves them, and shouldUpdateByKeyFields' resolveSapIdentifier reads
// `idsap ?? idSap ?? internalcode` on BOTH sides, so the two values compare
// equal and no update is ever emitted. `internalcode` would never be written and
// the whole S/4 contact base would stay permanently on the fallback tier.
//
// This script copies idsap -> internalcode for every contact that has the first
// and not the second.
//
// Usage:
//   node --env-file=.env scripts/backfill-hubspot-contact-internalcode.mjs <tenantDbName> [--apply]
//
// Dry run by default: without --apply nothing is written.
import { MongoClient } from 'mongodb';

const HUBSPOT_API = 'https://api.hubapi.com';
const PAGE_LIMIT = 100;
const BATCH_LIMIT = 100;

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/backfill-hubspot-contact-internalcode.mjs <tenantDbName> [--apply]');
  process.exit(1);
}

if (!tenantDb) {
  usage('Missing tenant database name.');
}

// No localhost default: silently pointing at an empty local Mongo would make a
// bare --apply report a reassuring "0 contacts" while the tenant stays broken.
if (!uri) {
  usage('MONGODB_URI is not set. Export it or run with `node --env-file=.env`.');
}

if (!clientId || !clientSecret) {
  usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set to refresh the tenant token.');
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

async function hubspotRequest(token, method, path, body = null, { attempt = 1 } = {}) {
  const response = await fetch(`${HUBSPOT_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // The list sweep is dozens of pages; a single 429 must not lose the run.
  if (response.status === 429 && attempt <= 5) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    return hubspotRequest(token, method, path, body, { attempt: attempt + 1 });
  }

  if (!response.ok) {
    throw new Error(`HubSpot ${method} ${path} -> ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function refreshAccessToken(credentials) {
  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: credentials.refreshToken,
    ...(process.env.HUBSPOT_REDIRECT_URI ? { redirect_uri: process.env.HUBSPOT_REDIRECT_URI } : {}),
  });

  const response = await fetch(`${HUBSPOT_API}/oauth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload.toString(),
  });

  if (!response.ok) {
    throw new Error(`HubSpot token refresh failed: ${response.status} ${await response.text()}`);
  }

  const { access_token: accessToken } = await response.json();

  if (!accessToken) {
    throw new Error('HubSpot token refresh returned no access_token');
  }

  return accessToken;
}

async function listAllContacts(token) {
  const contacts = [];
  let after;
  let pages = 0;

  do {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      properties: 'idsap,internalcode',
      ...(after ? { after } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    const page = await hubspotRequest(token, 'GET', `/crm/v3/objects/contacts?${query.toString()}`);

    contacts.push(...(page?.results ?? []));
    after = page?.paging?.next?.after;
    pages += 1;

    if (pages % 10 === 0) {
      console.log(`  ...${contacts.length} contacts read`);
    }
  } while (after);

  return contacts;
}

const mongo = new MongoClient(uri);

try {
  // Inside the try: an unreachable Mongo must print one clear line, not an
  // unhandled-rejection stack.
  await mongo.connect();

  const credentials = await mongo
    .db(tenantDb)
    .collection('HubspotCredentials')
    .findOne({ refreshToken: { $nin: [null, ''] } });

  if (!credentials) {
    throw new Error(`No HubspotCredentials document with a refreshToken found in ${tenantDb}`);
  }

  console.log(`${tenantDb}: refreshing HubSpot token (portal ${credentials.portalId ?? 'unknown'})`);
  const token = await refreshAccessToken(credentials);

  console.log('Reading all contacts (idsap, internalcode)...');
  const contacts = await listAllContacts(token);

  const needsBackfill = contacts.filter(({ properties }) =>
    !isEmpty(properties?.idsap) && isEmpty(properties?.internalcode));
  const alreadySet = contacts.filter(({ properties }) => !isEmpty(properties?.internalcode)).length;
  const noIdsap = contacts.filter(({ properties }) => isEmpty(properties?.idsap)).length;

  console.log(`Contacts total:            ${contacts.length}`);
  console.log(`  internalcode already set:${String(alreadySet).padStart(7)}`);
  console.log(`  no idsap (nothing to copy):${String(noIdsap).padStart(5)}`);
  console.log(`  to backfill idsap -> internalcode: ${needsBackfill.length}`);

  if (needsBackfill.length === 0) {
    console.log('Nothing to do.');
  } else if (!apply) {
    const sample = needsBackfill.slice(0, 5)
      .map(({ id, properties }) => `${id} -> ${properties.idsap}`)
      .join(', ');
    console.log(`Sample: ${sample}`);
    console.log('Dry run. Re-run with --apply to write.');
  } else {
    let updated = 0;

    for (let start = 0; start < needsBackfill.length; start += BATCH_LIMIT) {
      const chunk = needsBackfill.slice(start, start + BATCH_LIMIT);
      // eslint-disable-next-line no-await-in-loop
      const response = await hubspotRequest(token, 'POST', '/crm/v3/objects/contacts/batch/update', {
        inputs: chunk.map(({ id, properties }) => ({
          id,
          properties: { internalcode: String(properties.idsap) },
        })),
      });

      updated += (response?.results ?? []).length;
      console.log(`  ${updated}/${needsBackfill.length} updated`);
    }

    console.log(`Updated ${updated} contact(s).`);
  }
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
