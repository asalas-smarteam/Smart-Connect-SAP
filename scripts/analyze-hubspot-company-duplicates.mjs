// Clasifica los grupos de companies duplicadas por nombre que NO tienen idsap
// (caso 3 de la auditoria) segun la evidencia disponible, y emite un plan de
// merge en JSON para scripts/merge-hubspot-company-duplicates.mjs --plan.
//
// SOLO LECTURA. No fusiona nada.
//
// Uso:
//   node --env-file=.env scripts/analyze-hubspot-company-duplicates.mjs <tenantDb> [--plan <salida.json>] [--tiers A,B]
//
// Tiers:
//   A  RUC identico y no vacio en todos los registros        -> duplicado confirmado
//   B  RUC presente en algunos, vacio en el resto, sin       -> muy probable
//      conflicto entre los presentes
//   C  sin RUC en ninguno, pero comparten dominio, telefono  -> probable
//      o al menos un contacto asociado
//   D  sin RUC y sin ninguna otra senal: solo coincide       -> revisar a mano
//      el nombre
//   X  RUCs distintos entre si                               -> NO fusionar
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const HUBSPOT_API = 'https://api.hubapi.com';
const PAGE_LIMIT = 100;

const [, , tenantDb, ...flags] = process.argv;
const planIdx = flags.indexOf('--plan');
const planPath = planIdx >= 0 ? flags[planIdx + 1] : null;
const tiersIdx = flags.indexOf('--tiers');
const tiersWanted = (tiersIdx >= 0 ? flags[tiersIdx + 1] : 'A,B').split(',').map((t) => t.trim().toUpperCase());

const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/analyze-hubspot-company-duplicates.mjs <tenantDb> [--plan <salida.json>] [--tiers A,B]');
  process.exit(1);
}
if (!tenantDb) usage('Missing tenant database name.');
if (!uri) usage('MONGODB_URI is not set.');
if (!clientId || !clientSecret) usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set.');

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
const clean = (v) => (isEmpty(v) ? null : String(v).trim());
// Telefonos y RUC se comparan sin separadores para que "2222-3333" == "22223333".
const digits = (v) => (isEmpty(v) ? null : String(v).replace(/[^0-9A-Za-z]/g, '').toUpperCase() || null);

function normalizeName(raw) {
  return String(raw ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function hubspotRequest(token, method, path, body = null, { attempt = 1, allow404 = false } = {}) {
  const response = await fetch(`${HUBSPOT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 429 && attempt <= 5) {
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return hubspotRequest(token, method, path, body, { attempt: attempt + 1, allow404 });
  }
  if (response.status === 404 && allow404) return null;
  if (!response.ok) throw new Error(`HubSpot ${method} ${path} -> ${response.status} ${await response.text()}`);
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
  if (!response.ok) throw new Error(`HubSpot token refresh failed: ${response.status} ${await response.text()}`);
  const { access_token: accessToken } = await response.json();
  if (!accessToken) throw new Error('HubSpot token refresh returned no access_token');
  return accessToken;
}

const PROPS = [
  'name', 'idsap', 'codigo_de_sn', 'ruc', 'razon_social', 'domain', 'website',
  'phone', 'address', 'city', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate',
  'num_associated_contacts',
];

async function listAllCompanies(token) {
  const out = [];
  let after;
  do {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      properties: PROPS.join(','),
      ...(after ? { after } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    const page = await hubspotRequest(token, 'GET', `/crm/v3/objects/companies?${query.toString()}`);
    out.push(...(page?.results ?? []));
    after = page?.paging?.next?.after;
  } while (after);
  return out;
}

async function listAssociations(token, companyId, toObjectType) {
  const res = await hubspotRequest(
    token,
    'GET',
    `/crm/v4/objects/companies/${companyId}/associations/${toObjectType}?limit=500`,
    null,
    { allow404: true },
  );
  return (res?.results ?? []).map((r) => String(r.toObjectId));
}

// Cuantos campos con dato tiene el registro: desempata quien es el primario.
function riqueza(props) {
  return PROPS.filter((k) => !isEmpty(props?.[k])).length;
}

function clasificar(registros) {
  const rucs = [...new Set(registros.map((r) => digits(r.properties?.ruc)).filter(Boolean))];
  const conRuc = registros.filter((r) => !isEmpty(r.properties?.ruc)).length;

  if (rucs.length > 1) {
    return { tier: 'X', motivo: `RUCs distintos: ${rucs.join(' vs ')}` };
  }
  if (rucs.length === 1 && conRuc === registros.length) {
    return { tier: 'A', motivo: `mismo RUC en los ${registros.length}: ${rucs[0]}` };
  }
  if (rucs.length === 1) {
    return { tier: 'B', motivo: `RUC ${rucs[0]} en ${conRuc}/${registros.length}, el resto vacio` };
  }

  // Sin RUC en ninguno: buscar otras coincidencias.
  const senales = [];
  const dominios = [...new Set(registros.map((r) => clean(r.properties?.domain)).filter(Boolean))];
  const telefonos = [...new Set(registros.map((r) => digits(r.properties?.phone)).filter(Boolean))];
  const contactSets = registros.map((r) => new Set(r.contactIds));
  let compartidos = 0;
  for (let i = 0; i < contactSets.length; i += 1) {
    for (let j = i + 1; j < contactSets.length; j += 1) {
      compartidos += [...contactSets[i]].filter((c) => contactSets[j].has(c)).length;
    }
  }

  if (dominios.length === 1 && registros.filter((r) => !isEmpty(r.properties?.domain)).length > 1) {
    senales.push(`mismo dominio ${dominios[0]}`);
  }
  if (telefonos.length === 1 && registros.filter((r) => !isEmpty(r.properties?.phone)).length > 1) {
    senales.push(`mismo telefono ${telefonos[0]}`);
  }
  if (compartidos > 0) senales.push(`${compartidos} contacto(s) asociado(s) en comun`);
  if (dominios.length > 1) senales.push(`OJO dominios distintos: ${dominios.join(' vs ')}`);

  if (senales.length && !senales.some((s) => s.startsWith('OJO'))) {
    return { tier: 'C', motivo: senales.join('; ') };
  }
  return { tier: 'D', motivo: senales.length ? senales.join('; ') : 'solo coincide el nombre, sin RUC ni otra senal' };
}

// Primario: el mas rico en datos; empata -> mas contactos; empata -> mas viejo.
function elegirPrimario(registros) {
  return [...registros].sort((a, b) => {
    const rq = riqueza(b.properties) - riqueza(a.properties);
    if (rq !== 0) return rq;
    const ct = b.contactIds.length - a.contactIds.length;
    if (ct !== 0) return ct;
    return String(a.properties?.createdate ?? '').localeCompare(String(b.properties?.createdate ?? ''));
  })[0];
}

const mongo = new MongoClient(uri);
try {
  await mongo.connect();
  const credentials = await mongo.db(tenantDb).collection('HubspotCredentials')
    .findOne({ refreshToken: { $nin: [null, ''] } });
  if (!credentials) throw new Error(`No HubspotCredentials con refreshToken en ${tenantDb}`);

  console.log(`${tenantDb}: portal ${credentials.portalId ?? 'unknown'} - refrescando token`);
  const token = await refreshAccessToken(credentials);

  console.log('Leyendo todas las companies...');
  const companies = await listAllCompanies(token);
  console.log(`Total companies: ${companies.length}`);

  const groups = new Map();
  for (const c of companies) {
    const key = normalizeName(c.properties?.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  // Caso 3: grupos duplicados donde NINGUNO tiene idsap.
  const caso3 = [...groups.entries()]
    .filter(([, l]) => l.length > 1 && l.every((c) => isEmpty(c.properties?.idsap)));
  console.log(`Grupos del caso 3 (duplicados sin idsap): ${caso3.length}\n`);

  console.log('Leyendo asociaciones (contactos y deals) de cada registro...');
  const analizados = [];
  for (const [key, list] of caso3) {
    const registros = [];
    for (const c of list) {
      // eslint-disable-next-line no-await-in-loop
      const contactIds = await listAssociations(token, c.id, 'contacts');
      // eslint-disable-next-line no-await-in-loop
      const dealIds = await listAssociations(token, c.id, 'deals');
      registros.push({ id: String(c.id), properties: c.properties ?? {}, contactIds, dealIds });
    }
    const { tier, motivo } = clasificar(registros);
    const primario = elegirPrimario(registros);
    analizados.push({
      label: key,
      tier,
      motivo,
      primary: primario.id,
      secondaries: registros.filter((r) => r.id !== primario.id).map((r) => r.id),
      registros,
    });
  }

  const porTier = (t) => analizados.filter((a) => a.tier === t);
  console.log('\n===== RESUMEN =====');
  for (const t of ['A', 'B', 'C', 'D', 'X']) {
    console.log(`  Tier ${t}: ${porTier(t).length} grupo(s)`);
  }

  for (const t of ['A', 'B', 'C', 'D', 'X']) {
    const list = porTier(t);
    if (!list.length) continue;
    console.log(`\n===== TIER ${t} (${list.length}) =====`);
    for (const g of list.sort((a, b) => a.label.localeCompare(b.label))) {
      console.log(`  [${g.label}] x${g.registros.length} -- ${g.motivo}`);
      for (const r of g.registros) {
        const p = r.properties;
        const marca = r.id === g.primary ? '>' : ' ';
        console.log(`      ${marca} id=${r.id} | ruc=${p.ruc ?? '--'} | dom=${p.domain ?? '--'} | tel=${p.phone ?? '--'} | campos=${riqueza(p)} | contactos=${r.contactIds.length} | deals=${r.dealIds.length} | creada=${String(p.createdate ?? '').slice(0, 10)} | "${p.name}"`);
      }
    }
  }

  if (planPath) {
    const incluidos = analizados.filter((a) => tiersWanted.includes(a.tier));
    const plan = {
      generadoEn: new Date().toISOString(),
      tenantDb,
      portalId: credentials.portalId ?? null,
      tiersIncluidos: tiersWanted,
      grupos: incluidos.map((g) => ({
        label: g.label,
        tier: g.tier,
        motivo: g.motivo,
        idsap: null,
        primary: g.primary,
        secondaries: g.secondaries,
      })),
    };
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
    console.log(`\nPlan (tiers ${tiersWanted.join(',')}): ${plan.grupos.length} grupo(s), ${plan.grupos.reduce((a, g) => a + g.secondaries.length, 0)} merge(s) -> ${planPath}`);
  }
} catch (error) {
  console.error(`\nERROR: ${error.message ?? error}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
