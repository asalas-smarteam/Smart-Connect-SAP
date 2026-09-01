// Verifica a fondo si las companies de un grupo estan realmente vacias, antes
// de decidir si se pueden fusionar o borrar sin perder nada.
//
// A diferencia de analyze-hubspot-company-duplicates.mjs, que mira 14 propiedades
// y 2 tipos de asociacion, este lee TODAS las propiedades del portal y TODOS los
// tipos de asociacion que puede tener una company.
//
// SOLO LECTURA.
//
// Uso:
//   node --env-file=.env scripts/inspect-hubspot-company-emptiness.mjs <tenantDb> [--tier D] [--plan <salida.json>]
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const HUBSPOT_API = 'https://api.hubapi.com';
const PAGE_LIMIT = 100;

// Propiedades que HubSpot rellena solo: tener dato aqui no significa que el
// registro "tenga informacion" puesta por alguien.
const SISTEMA = new Set([
  'hs_object_id', 'createdate', 'hs_lastmodifieddate', 'hs_createdate',
  'hs_object_source', 'hs_object_source_id', 'hs_object_source_label',
  'hs_object_source_user_id', 'hs_object_source_detail_1',
  'hs_object_source_detail_2', 'hs_object_source_detail_3',
  'hs_pipeline', 'hs_all_owner_ids', 'hs_all_team_ids',
  'hs_all_accessible_team_ids', 'hs_user_ids_of_all_owners',
  'hs_merged_object_ids', 'hs_unique_creation_key', 'hs_was_imported',
  'hs_updated_by_user_id', 'hs_created_by_user_id', 'num_associated_contacts',
  'hs_num_child_companies', 'hs_num_blockers', 'hs_num_contacts_with_buying_roles',
  'hs_num_decision_makers', 'hs_num_open_deals', 'hs_object_source_prefix',
  'hs_time_in_lead', 'hs_time_in_customer', 'hs_time_in_opportunity',
  'hs_time_in_subscriber', 'hs_time_in_evangelist', 'hs_time_in_other',
  'hs_time_in_marketingqualifiedlead', 'hs_time_in_salesqualifiedlead',
  'lifecyclestage', 'hs_lifecyclestage_lead_date',
  'hs_lifecyclestage_customer_date', 'hs_lifecyclestage_opportunity_date',
  'hs_lifecyclestage_subscriber_date', 'hs_lifecyclestage_other_date',
  'hs_lifecyclestage_evangelist_date',
  'hs_lifecyclestage_marketingqualifiedlead_date',
  'hs_lifecyclestage_salesqualifiedlead_date',
  'notes_last_updated', 'hs_last_sales_activity_timestamp',
  'hs_last_sales_activity_date', 'hs_last_sales_activity_type',
  // Estos los pone HubSpot en TODA company al crearla o al asignar propietario.
  // Sin ellos aqui, cada registro parece "con datos" y ningun grupo sale limpio.
  'num_notes', 'hubspot_team_id', 'hubspot_owner_id', 'hubspot_owner_assigneddate',
  'hs_v2_time_in_current_stage', 'hs_v2_date_entered_lead',
  'hs_v2_date_entered_current_stage', 'hs_user_ids_of_all_notification_recipients',
  'hs_task_label', 'hs_owning_teams', 'hs_annual_revenue_currency_code',
  // Derivados del ciclo de vida y de los deals: reflejan asociaciones, que ya
  // se cuentan aparte.
  'num_associated_deals', 'first_deal_created_date', 'closedate', 'days_to_close',
  'hs_v2_date_entered_opportunity', 'hs_v2_date_exited_opportunity',
  'hs_v2_date_entered_customer', 'hs_v2_date_exited_lead',
  'hs_v2_cumulative_time_in_lead', 'hs_v2_cumulative_time_in_opportunity',
  'hs_v2_latest_time_in_lead', 'hs_v2_latest_time_in_opportunity',
]);

const ASSOC_TYPES = ['contacts', 'deals', 'tickets', 'notes', 'tasks', 'emails', 'calls', 'meetings', 'quotes'];

const [, , tenantDb, ...flags] = process.argv;
const tierIdx = flags.indexOf('--tier');
const tierWanted = (tierIdx >= 0 ? flags[tierIdx + 1] : 'D').toUpperCase();
const planIdx = flags.indexOf('--plan');
const planPath = planIdx >= 0 ? flags[planIdx + 1] : null;

const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/inspect-hubspot-company-emptiness.mjs <tenantDb> [--tier D] [--plan <salida.json>]');
  process.exit(1);
}
if (!tenantDb) usage('Missing tenant database name.');
if (!uri) usage('MONGODB_URI is not set.');
if (!clientId || !clientSecret) usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set.');

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
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

async function listAllCompanies(token, props) {
  const out = [];
  let after;
  do {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      properties: props.join(','),
      ...(after ? { after } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    const page = await hubspotRequest(token, 'GET', `/crm/v3/objects/companies?${query.toString()}`);
    out.push(...(page?.results ?? []));
    after = page?.paging?.next?.after;
  } while (after);
  return out;
}

async function batchRead(token, ids, props) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    // eslint-disable-next-line no-await-in-loop
    const res = await hubspotRequest(token, 'POST', '/crm/v3/objects/companies/batch/read', {
      properties: props,
      inputs: chunk.map((id) => ({ id })),
    });
    for (const r of res?.results ?? []) out.set(String(r.id), r);
  }
  return out;
}

async function contarAsociaciones(token, companyId) {
  const conteo = {};
  for (const tipo of ASSOC_TYPES) {
    // eslint-disable-next-line no-await-in-loop
    const res = await hubspotRequest(
      token,
      'GET',
      `/crm/v4/objects/companies/${companyId}/associations/${tipo}?limit=100`,
      null,
      { allow404: true },
    );
    const n = (res?.results ?? []).length;
    if (n > 0) conteo[tipo] = n;
  }
  return conteo;
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
  const allProps = (propsMeta?.results ?? []).map((p) => p.name);
  const propsUtiles = allProps.filter((p) => !SISTEMA.has(p));
  console.log(`Propiedades del portal: ${allProps.length} (${propsUtiles.length} no-sistema)`);

  console.log('Leyendo companies...');
  const companies = await listAllCompanies(token, ['name', 'idsap', 'ruc', 'phone', 'domain']);

  const groups = new Map();
  for (const c of companies) {
    const key = normalizeName(c.properties?.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  // Tier D: duplicados sin idsap, sin RUC en ninguno, sin telefono/dominio comun.
  const candidatos = [...groups.entries()].filter(([, l]) => {
    if (l.length < 2) return false;
    if (!l.every((c) => isEmpty(c.properties?.idsap))) return false;
    const rucs = [...new Set(l.map((c) => digits(c.properties?.ruc)).filter(Boolean))];
    if (rucs.length > 0) return false;
    const tels = [...new Set(l.map((c) => digits(c.properties?.phone)).filter(Boolean))];
    const doms = [...new Set(l.map((c) => c.properties?.domain).filter((d) => !isEmpty(d)))];
    return tels.length === 0 && doms.length === 0;
  });

  console.log(`Grupos candidatos a tier ${tierWanted}: ${candidatos.length}\n`);
  console.log('Leyendo las propiedades completas y los 9 tipos de asociacion de cada registro...');

  const resultados = [];
  for (const [key, list] of candidatos) {
    // eslint-disable-next-line no-await-in-loop
    const detalle = await batchRead(token, list.map((c) => String(c.id)), allProps);
    const registros = [];
    for (const c of list) {
      const id = String(c.id);
      const props = detalle.get(id)?.properties ?? {};
      const conDato = propsUtiles.filter((p) => !isEmpty(props[p]));
      // eslint-disable-next-line no-await-in-loop
      const asociaciones = await contarAsociaciones(token, id);
      registros.push({
        id,
        name: props.name,
        camposConDato: conDato,
        asociaciones,
        vacio: conDato.filter((p) => p !== 'name').length === 0 && Object.keys(asociaciones).length === 0,
      });
    }
    resultados.push({ label: key, registros });
  }

  const limpios = [];
  const conDatos = [];
  for (const g of resultados) {
    const noVacios = g.registros.filter((r) => !r.vacio);
    // Limpio = a lo sumo UNO tiene algo; el resto son cascarones que se pueden
    // descartar sin perder nada. Ese uno es el que se conserva.
    if (noVacios.length <= 1) limpios.push(g);
    else conDatos.push(g);
  }

  console.log('\n===== RESUMEN =====');
  console.log(`  Grupos donde a lo sumo 1 registro tiene datos: ${limpios.length}`);
  console.log(`  Grupos donde 2+ registros tienen datos:        ${conDatos.length}`);

  const pinta = (g) => {
    console.log(`  [${g.label}] x${g.registros.length}`);
    for (const r of g.registros) {
      const campos = r.camposConDato.filter((p) => p !== 'name');
      const asoc = Object.entries(r.asociaciones).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`      ${r.vacio ? 'VACIO ' : 'CON DATOS'} id=${r.id} | campos: ${campos.length ? campos.join(', ') : '(ninguno)'} | asociaciones: ${asoc || '(ninguna)'}`);
    }
  };

  if (limpios.length) {
    console.log(`\n===== A LO SUMO 1 CON DATOS (${limpios.length}) =====`);
    limpios.sort((a, b) => a.label.localeCompare(b.label)).forEach(pinta);
  }
  if (conDatos.length) {
    console.log(`\n===== OJO: 2+ CON DATOS, NO AUTOMATIZAR (${conDatos.length}) =====`);
    conDatos.sort((a, b) => a.label.localeCompare(b.label)).forEach(pinta);
  }

  if (planPath) {
    const plan = {
      generadoEn: new Date().toISOString(),
      tenantDb,
      portalId: credentials.portalId ?? null,
      tiersIncluidos: [tierWanted],
      grupos: limpios.map((g) => {
        // Primario: el unico con datos si lo hay; si todos estan vacios, el mas viejo por id.
        const conAlgo = g.registros.find((r) => !r.vacio);
        const primario = conAlgo ?? [...g.registros].sort((a, b) => a.id.localeCompare(b.id))[0];
        return {
          label: g.label,
          tier: tierWanted,
          motivo: conAlgo
            ? `solo ${conAlgo.id} tiene datos; el resto son cascarones vacios`
            : 'todos los registros estan completamente vacios',
          idsap: null,
          primary: primario.id,
          secondaries: g.registros.filter((r) => r.id !== primario.id).map((r) => r.id),
        };
      }),
    };
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
    console.log(`\nPlan: ${plan.grupos.length} grupo(s), ${plan.grupos.reduce((a, g) => a + g.secondaries.length, 0)} merge(s) -> ${planPath}`);
  }
} catch (error) {
  console.error(`\nERROR: ${error.message ?? error}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
