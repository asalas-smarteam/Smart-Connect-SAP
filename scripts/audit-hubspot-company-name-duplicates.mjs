// Audita companies duplicadas por NOMBRE en el portal de un tenant. SOLO LECTURA.
//
// Uso:
//   node --env-file=.env <script> <tenantDbName> [--strict] [--csv <ruta>]
//
// Por defecto agrupa por nombre NORMALIZADO (mayusculas, sin puntuacion/acentos,
// espacios colapsados) para que "PALMARES DEL CASTILLO S.A" y
// "PALMARES DEL CASTILLO, S.A" caigan en el mismo grupo.
// --strict agrupa por el nombre exacto (solo trim + lowercase).
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const HUBSPOT_API = 'https://api.hubapi.com';
const PAGE_LIMIT = 100;

const [, , tenantDb, ...flags] = process.argv;
const strict = flags.includes('--strict');
const csvIdx = flags.indexOf('--csv');
const csvPath = csvIdx >= 0 ? flags[csvIdx + 1] : null;

const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env <script> <tenantDbName> [--strict] [--csv <ruta>]');
  process.exit(1);
}
if (!tenantDb) usage('Missing tenant database name.');
if (!uri) usage('MONGODB_URI is not set.');
if (!clientId || !clientSecret) usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set.');

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

function normalizeName(raw) {
  const base = String(raw ?? '').trim();
  if (strict) return base.toLowerCase();
  return base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function hubspotRequest(token, method, path, body = null, { attempt = 1 } = {}) {
  const response = await fetch(`${HUBSPOT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 429 && attempt <= 5) {
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return hubspotRequest(token, method, path, body, { attempt: attempt + 1 });
  }
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

const WANTED = ['name', 'idsap', 'codigo_de_sn', 'domain', 'ruc', 'razon_social', 'createdate', 'hs_lastmodifieddate', 'hubspot_owner_id', 'num_associated_contacts'];

async function listAllCompanies(token, props) {
  const out = [];
  let after;
  let pages = 0;
  do {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      properties: props.join(','),
      ...(after ? { after } : {}),
    });
    const page = await hubspotRequest(token, 'GET', `/crm/v3/objects/companies?${query.toString()}`);
    out.push(...(page?.results ?? []));
    after = page?.paging?.next?.after;
    pages += 1;
    if (pages % 10 === 0) console.log(`  ...${out.length} companies leidas`);
  } while (after);
  return out;
}

const mongo = new MongoClient(uri);
try {
  await mongo.connect();
  const credentials = await mongo.db(tenantDb).collection('HubspotCredentials')
    .findOne({ refreshToken: { $nin: [null, ''] } });
  if (!credentials) throw new Error(`No HubspotCredentials con refreshToken en ${tenantDb}`);

  console.log(`${tenantDb}: portal ${credentials.portalId ?? 'unknown'} - refrescando token`);
  const token = await refreshAccessToken(credentials);

  const propsMeta = await hubspotRequest(token, 'GET', '/crm/v3/properties/companies');
  const existing = new Set((propsMeta?.results ?? []).map((p) => p.name));
  const missing = WANTED.filter((p) => !existing.has(p));
  if (missing.length) console.log(`  (propiedades inexistentes, se omiten: ${missing.join(', ')})`);
  const props = WANTED.filter((p) => existing.has(p));
  if (!existing.has('idsap')) throw new Error('La propiedad "idsap" no existe en companies de este portal');

  console.log('Leyendo todas las companies...');
  const companies = await listAllCompanies(token, props);
  console.log(`Total companies: ${companies.length}\n`);

  const groups = new Map();
  let sinNombre = 0;
  for (const c of companies) {
    const key = normalizeName(c.properties?.name);
    if (!key) { sinNombre += 1; continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const dupes = [...groups.entries()].filter(([, list]) => list.length > 1);

  const totalDupRecords = dupes.reduce((acc, [, l]) => acc + l.length, 0);
  const conUnoIdsap = dupes.filter(([, l]) => l.filter((c) => !isEmpty(c.properties?.idsap)).length === 1);
  const conVariosIdsap = dupes.filter(([, l]) => l.filter((c) => !isEmpty(c.properties?.idsap)).length > 1);
  const sinIdsap = dupes.filter(([, l]) => l.every((c) => isEmpty(c.properties?.idsap)));

  console.log(`Modo agrupacion: ${strict ? 'nombre exacto' : 'nombre normalizado'}`);
  console.log(`Companies sin nombre:                    ${sinNombre}`);
  console.log(`Grupos duplicados:                       ${dupes.length}`);
  console.log(`Registros involucrados:                  ${totalDupRecords}`);
  console.log(`Registros sobrantes (a fusionar/borrar): ${totalDupRecords - dupes.length}`);
  console.log(`  grupos con EXACTAMENTE 1 con idsap:    ${conUnoIdsap.length}  <- caso limpio (ganador claro)`);
  console.log(`  grupos con VARIOS con idsap:           ${conVariosIdsap.length}  <- revisar a mano`);
  console.log(`  grupos SIN ningun idsap:               ${sinIdsap.length}  <- ninguno viene de SAP`);

  const fmt = (c) => {
    const p = c.properties ?? {};
    const created = p.createdate ? String(p.createdate).slice(0, 10) : '?';
    const mark = !isEmpty(p.idsap) ? '*' : ' ';
    return `      ${mark} id=${c.id} | idsap=${p.idsap ?? '--'} | codigo_de_sn=${p.codigo_de_sn ?? '--'} | ruc=${p.ruc ?? '--'} | creada=${created} | contactos=${p.num_associated_contacts ?? '0'} | "${p.name}"`;
  };

  const dump = (title, list) => {
    if (!list.length) return;
    console.log(`\n=== ${title} (${list.length}) ===`);
    for (const [key, l] of [...list].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  [${key}]  x${l.length}`);
      [...l].sort((a, b) => (isEmpty(a.properties?.idsap) ? 1 : 0) - (isEmpty(b.properties?.idsap) ? 1 : 0))
        .forEach((c) => console.log(fmt(c)));
    }
  };

  dump('GRUPOS CON 1 SOLO idsap - el marcado con * es el bueno', conUnoIdsap);
  dump('GRUPOS CON VARIOS idsap - conflicto, revisar', conVariosIdsap);
  dump('GRUPOS SIN idsap - ninguno esta en SAP', sinIdsap);

  if (csvPath) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['grupo', 'clave_normalizada', 'tamano_grupo', 'caso', 'company_id', 'name', 'idsap', 'codigo_de_sn', 'ruc', 'razon_social', 'domain', 'createdate', 'lastmodified', 'contactos_asociados', 'es_ganador'];
    const rows = [header.join(',')];
    let g = 0;
    const caso = (l) => {
      const n = l.filter((c) => !isEmpty(c.properties?.idsap)).length;
      if (n === 1) return 'UN_IDSAP';
      return n > 1 ? 'VARIOS_IDSAP' : 'SIN_IDSAP';
    };
    for (const [key, l] of [...dupes].sort((a, b) => a[0].localeCompare(b[0]))) {
      g += 1;
      const kind = caso(l);
      for (const c of l) {
        const p = c.properties ?? {};
        const ganador = kind === 'UN_IDSAP' && !isEmpty(p.idsap) ? 'SI' : '';
        rows.push([g, key, l.length, kind, c.id, p.name, p.idsap, p.codigo_de_sn, p.ruc, p.razon_social, p.domain, p.createdate, p.hs_lastmodifieddate, p.num_associated_contacts, ganador].map(esc).join(','));
      }
    }
    writeFileSync(csvPath, `﻿${rows.join('\n')}`, 'utf8');
    console.log(`\nCSV escrito en: ${csvPath}`);
  }
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
