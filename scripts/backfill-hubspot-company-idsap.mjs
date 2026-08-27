// Copia codigo_de_sn -> idsap en companies del portal del tenant.
// codigo_de_sn NUNCA se toca: solo se escribe idsap.
//
// Uso:
//   node --env-file=.env <ruta>/backfill-distelsa-company-idsap.mjs <tenantDbName> [--apply] [--overwrite]
//
// Dry run por defecto. --overwrite tambien pisa idsap cuando ya trae un valor distinto.
import { MongoClient } from 'mongodb';

const HUBSPOT_API = 'https://api.hubapi.com';
const PAGE_LIMIT = 100;
const BATCH_LIMIT = 100;

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const overwrite = flags.includes('--overwrite');
const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env <script> <tenantDbName> [--apply] [--overwrite]');
  process.exit(1);
}

if (!tenantDb) usage('Missing tenant database name.');
if (!uri) usage('MONGODB_URI is not set.');
if (!clientId || !clientSecret) usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set.');

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

async function hubspotRequest(token, method, path, body = null, { attempt = 1 } = {}) {
  const response = await fetch(`${HUBSPOT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

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
  if (!accessToken) throw new Error('HubSpot token refresh returned no access_token');
  return accessToken;
}

async function listAllCompanies(token) {
  const companies = [];
  let after;
  let pages = 0;

  do {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      properties: 'name,codigo_de_sn,idsap',
      ...(after ? { after } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    const page = await hubspotRequest(token, 'GET', `/crm/v3/objects/companies?${query.toString()}`);
    companies.push(...(page?.results ?? []));
    after = page?.paging?.next?.after;
    pages += 1;
    if (pages % 10 === 0) console.log(`  ...${companies.length} companies leidas`);
  } while (after);

  return companies;
}

const mongo = new MongoClient(uri);

try {
  await mongo.connect();

  const credentials = await mongo
    .db(tenantDb)
    .collection('HubspotCredentials')
    .findOne({ refreshToken: { $nin: [null, ''] } });

  if (!credentials) {
    throw new Error(`No HubspotCredentials document with a refreshToken found in ${tenantDb}`);
  }

  console.log(`${tenantDb}: refrescando token de HubSpot (portal ${credentials.portalId ?? 'unknown'})`);
  const token = await refreshAccessToken(credentials);

  // Confirmar que ambas propiedades existen antes de leer nada.
  const props = await hubspotRequest(token, 'GET', '/crm/v3/properties/companies');
  const byName = new Map((props?.results ?? []).map((p) => [p.name, p]));
  for (const name of ['codigo_de_sn', 'idsap']) {
    const p = byName.get(name);
    if (!p) throw new Error(`La propiedad "${name}" no existe en companies del portal ${credentials.portalId}`);
    console.log(`  propiedad ${name}: type=${p.type} fieldType=${p.fieldType} readOnlyValue=${p.modificationMetadata?.readOnlyValue ?? false}`);
  }

  console.log('Leyendo todas las companies (name, codigo_de_sn, idsap)...');
  const companies = await listAllCompanies(token);

  const withCodigo = companies.filter(({ properties }) => !isEmpty(properties?.codigo_de_sn));
  const idsapEmpty = withCodigo.filter(({ properties }) => isEmpty(properties?.idsap));
  const idsapEqual = withCodigo.filter(({ properties }) =>
    !isEmpty(properties?.idsap) && String(properties.idsap).trim() === String(properties.codigo_de_sn).trim());
  const idsapConflict = withCodigo.filter(({ properties }) =>
    !isEmpty(properties?.idsap) && String(properties.idsap).trim() !== String(properties.codigo_de_sn).trim());

  console.log(`\nCompanies total:                       ${companies.length}`);
  console.log(`  con codigo_de_sn:                    ${withCodigo.length}`);
  console.log(`    idsap vacio (a rellenar):          ${idsapEmpty.length}`);
  console.log(`    idsap ya igual (nada que hacer):   ${idsapEqual.length}`);
  console.log(`    idsap con OTRO valor (conflicto):  ${idsapConflict.length}`);
  console.log(`  sin codigo_de_sn (se ignoran):       ${companies.length - withCodigo.length}`);

  if (idsapConflict.length > 0) {
    console.log('\n  Conflictos (id | name | codigo_de_sn -> idsap actual):');
    idsapConflict.slice(0, 20).forEach(({ id, properties }) => {
      console.log(`    ${id} | ${properties.name ?? ''} | ${properties.codigo_de_sn} -> ${properties.idsap}`);
    });
    if (idsapConflict.length > 20) console.log(`    ...y ${idsapConflict.length - 20} mas`);
  }

  const targets = overwrite ? [...idsapEmpty, ...idsapConflict] : idsapEmpty;

  console.log(`\nA escribir: ${targets.length} company(s)${overwrite ? ' (incluye conflictos, --overwrite)' : ''}`);

  if (targets.length === 0) {
    console.log('Nada que hacer.');
  } else if (!apply) {
    const sample = targets.slice(0, 5)
      .map(({ id, properties }) => `${id} (${properties.name ?? ''}) -> ${properties.codigo_de_sn}`)
      .join('\n  ');
    console.log(`Muestra:\n  ${sample}`);
    console.log('Dry run. Re-ejecutar con --apply para escribir.');
  } else {
    let updated = 0;
    for (let start = 0; start < targets.length; start += BATCH_LIMIT) {
      const chunk = targets.slice(start, start + BATCH_LIMIT);
      // eslint-disable-next-line no-await-in-loop
      const response = await hubspotRequest(token, 'POST', '/crm/v3/objects/companies/batch/update', {
        inputs: chunk.map(({ id, properties }) => ({
          id,
          properties: { idsap: String(properties.codigo_de_sn).trim() },
        })),
      });
      updated += (response?.results ?? []).length;
      console.log(`  ${updated}/${targets.length} actualizadas`);
    }
    console.log(`Actualizadas ${updated} company(s). codigo_de_sn intacto.`);
  }
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
