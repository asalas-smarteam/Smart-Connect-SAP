// Archiva (borra a papelera) las companies duplicadas VACIAS de un plan, dejando
// solo el primario de cada grupo. Alternativa al merge cuando los secundarios no
// tienen absolutamente nada que conservar.
//
// DRY RUN POR DEFECTO. Sin --apply no se borra nada.
//
// Salvaguardas, todas obligatorias antes de borrar cada registro:
//   1. snapshot completo (todas las propiedades + 9 tipos de asociacion) a JSON
//   2. el id tiene que estar en `secondaries` de algun grupo del plan; jamas se
//      toca un primary
//   3. re-lectura en vivo: si el registro gano CUALQUIER campo no-sistema o
//      CUALQUIER asociacion desde que se genero el plan, se salta
//   4. si el id resuelve a otro id (fue fusionado), se salta
//
// Uso:
//   node --env-file=.env scripts/delete-hubspot-company-duplicates.mjs <tenantDb> --plan <plan.json> [--apply] [--snapshot <ruta.json>]
import { MongoClient } from 'mongodb';
import { writeFileSync, readFileSync } from 'node:fs';

const HUBSPOT_API = 'https://api.hubapi.com';

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
  'num_notes', 'hubspot_team_id', 'hubspot_owner_id', 'hubspot_owner_assigneddate',
  'hs_v2_time_in_current_stage', 'hs_v2_date_entered_lead',
  'hs_v2_date_entered_current_stage', 'hs_user_ids_of_all_notification_recipients',
  'hs_task_label', 'hs_owning_teams', 'hs_annual_revenue_currency_code',
  'num_associated_deals', 'first_deal_created_date', 'closedate', 'days_to_close',
  'hs_v2_date_entered_opportunity', 'hs_v2_date_exited_opportunity',
  'hs_v2_date_entered_customer', 'hs_v2_date_exited_lead',
  'hs_v2_cumulative_time_in_lead', 'hs_v2_cumulative_time_in_opportunity',
  'hs_v2_latest_time_in_lead', 'hs_v2_latest_time_in_opportunity',
]);

const ASSOC_TYPES = ['contacts', 'deals', 'tickets', 'notes', 'tasks', 'emails', 'calls', 'meetings', 'quotes'];

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const planIdx = flags.indexOf('--plan');
const planPath = planIdx >= 0 ? flags[planIdx + 1] : null;
const snapIdx = flags.indexOf('--snapshot');
const snapshotPath = snapIdx >= 0 ? flags[snapIdx + 1] : null;

const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/delete-hubspot-company-duplicates.mjs <tenantDb> --plan <plan.json> [--apply] [--snapshot <ruta.json>]');
  process.exit(1);
}
if (!tenantDb) usage('Missing tenant database name.');
if (!planPath) usage('--plan es obligatorio: este script no borra nada sin un plan explicito.');
if (!uri) usage('MONGODB_URI is not set.');
if (!clientId || !clientSecret) usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set.');

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

async function hubspotRequest(token, method, path, body = null, { attempt = 1, allow404 = false, raw = false } = {}) {
  const response = await fetch(`${HUBSPOT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 429 && attempt <= 5) {
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return hubspotRequest(token, method, path, body, { attempt: attempt + 1, allow404, raw });
  }
  if (response.status === 404 && allow404) return null;
  if (!response.ok) throw new Error(`HubSpot ${method} ${path} -> ${response.status} ${await response.text()}`);
  if (raw || response.status === 204) return { ok: true };
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

async function readCompany(token, id, props) {
  const query = new URLSearchParams({ properties: props.join(',') });
  return hubspotRequest(token, 'GET', `/crm/v3/objects/companies/${id}?${query.toString()}`, null, { allow404: true });
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

  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan.tenantDb && plan.tenantDb !== tenantDb) {
    usage(`El plan fue generado para "${plan.tenantDb}", no para "${tenantDb}".`);
  }

  console.log(`${tenantDb}: portal ${credentials.portalId ?? 'unknown'} - refrescando token`);
  const token = await refreshAccessToken(credentials);

  const propsMeta = await hubspotRequest(token, 'GET', '/crm/v3/properties/companies');
  const allProps = (propsMeta?.results ?? []).map((p) => p.name);
  const propsUtiles = allProps.filter((p) => !SISTEMA.has(p) && p !== 'name');

  const primarios = new Set(plan.grupos.map((g) => String(g.primary)));
  const candidatos = plan.grupos.flatMap((g) => g.secondaries.map((s) => ({ grupo: g, id: String(s) })));
  console.log(`Plan: ${planPath}`);
  console.log(`  grupos: ${plan.grupos.length} | primarios (INTOCABLES): ${primarios.size} | candidatos a borrar: ${candidatos.length}`);
  console.log(`  propiedades del portal: ${allProps.length} (${propsUtiles.length} evaluables)`);

  // ---- Snapshot ----
  console.log('\nPaso 0 - snapshot completo de TODO lo que esta en el plan...');
  const todosIds = [...new Set([...primarios, ...candidatos.map((c) => c.id)])];
  const detalle = await batchRead(token, todosIds, allProps);
  const snapshot = { capturadoEn: new Date().toISOString(), tenantDb, portalId: credentials.portalId ?? null, planPath, grupos: [] };
  for (const g of plan.grupos) {
    const registros = [];
    for (const id of [String(g.primary), ...g.secondaries.map(String)]) {
      // eslint-disable-next-line no-await-in-loop
      const asociaciones = await contarAsociaciones(token, id);
      registros.push({
        id,
        rol: id === String(g.primary) ? 'primary' : 'secondary',
        properties: detalle.get(id)?.properties ?? null,
        asociaciones,
      });
    }
    snapshot.grupos.push({ label: g.label, primary: String(g.primary), registros });
  }
  if (snapshotPath) {
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`  snapshot -> ${snapshotPath}`);
  } else {
    console.log('  (sin --snapshot: no se escribio a disco)');
  }

  // ---- Verificacion en vivo, registro por registro ----
  console.log('\nPaso 1 - verificacion en vivo de cada candidato...');
  const borrables = [];
  const saltados = [];
  for (const { grupo, id } of candidatos) {
    const problemas = [];

    if (primarios.has(id)) problemas.push('es primario de algun grupo del plan');

    // eslint-disable-next-line no-await-in-loop
    const rec = await readCompany(token, id, ['name', 'idsap', 'hs_object_id']);
    if (!rec) problemas.push('ya no existe');
    else if (String(rec.id) !== id) problemas.push(`resuelve a ${rec.id}: fue fusionado, no es el mismo registro`);
    else if (!isEmpty(rec.properties?.idsap)) problemas.push(`AHORA tiene idsap=${rec.properties.idsap}`);

    if (rec && String(rec.id) === id) {
      const props = detalle.get(id)?.properties ?? {};
      const conDato = propsUtiles.filter((p) => !isEmpty(props[p]));
      if (conDato.length) problemas.push(`tiene datos en: ${conDato.join(', ')}`);
      // eslint-disable-next-line no-await-in-loop
      const asoc = await contarAsociaciones(token, id);
      const conAsoc = Object.entries(asoc).map(([k, v]) => `${k}:${v}`);
      if (conAsoc.length) problemas.push(`tiene asociaciones: ${conAsoc.join(' ')}`);
    }

    if (problemas.length) {
      saltados.push({ grupo, id, problemas });
      console.log(`  [SALTA] ${grupo.label} / ${id}: ${problemas.join('; ')}`);
    } else {
      borrables.push({ grupo, id });
    }
  }

  console.log(`\n  aptos para borrar: ${borrables.length} | saltados: ${saltados.length}`);

  if (borrables.length === 0) {
    console.log('\nNada que borrar.');
    process.exit(0);
  }

  if (!apply) {
    console.log(`\nDRY RUN - se archivarian ${borrables.length} registro(s) (la papelera de HubSpot permite restaurarlos):`);
    let n = 0;
    for (const { grupo, id } of borrables) {
      n += 1;
      const nombre = detalle.get(id)?.properties?.name ?? '?';
      console.log(`  ${String(n).padStart(2)}. DELETE /crm/v3/objects/companies/${id}   "${nombre}"  (sobrevive ${grupo.primary})`);
    }
    console.log('\nRe-ejecutar con --apply para archivarlos.');
    process.exit(0);
  }

  console.log('\nPaso 2 - ARCHIVANDO (secuencial, se detiene al primer error)...');
  let borrados = 0;
  for (const { grupo, id } of borrables) {
    const nombre = detalle.get(id)?.properties?.name ?? '?';
    // eslint-disable-next-line no-await-in-loop
    await hubspotRequest(token, 'DELETE', `/crm/v3/objects/companies/${id}`, null, { raw: true });
    borrados += 1;
    console.log(`  ${borrados}/${borrables.length} archivado ${id} "${nombre}" (sobrevive ${grupo.primary})`);

    // El primario nunca se toca, pero se comprueba que siga vivo por si acaso.
    // eslint-disable-next-line no-await-in-loop
    const vivo = await readCompany(token, String(grupo.primary), ['name', 'hs_object_id']);
    if (!vivo) throw new Error(`El primario ${grupo.primary} (${grupo.label}) desaparecio. Deteniendo.`);
  }

  console.log(`\nListo. ${borrados} registro(s) archivado(s). ${saltados.length} saltado(s).`);
  if (saltados.length) saltados.forEach(({ grupo, id, problemas }) => console.log(`  - ${grupo.label} / ${id}: ${problemas.join('; ')}`));
} catch (error) {
  console.error(`\nERROR: ${error.message ?? error}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
