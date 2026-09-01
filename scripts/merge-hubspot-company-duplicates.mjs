// Fusiona companies duplicadas por nombre en el portal de un tenant.
// Caso 1 de la auditoria: grupos donde EXACTAMENTE UNO tiene idsap.
// El que tiene idsap es siempre el primario; los demas se absorben.
//
// EL MERGE DE HUBSPOT ES IRREVERSIBLE. Por eso:
//   - snapshot completo a JSON antes de tocar nada
//   - re-verificacion en vivo de cada par justo antes de fusionar
//   - dry run por defecto
//   - ejecucion secuencial: si un merge falla, se detiene
//
// Uso:
//   node --env-file=.env scripts/merge-hubspot-company-duplicates.mjs <tenantDb> [--apply] [--only <texto>] [--snapshot <ruta.json>]
import { MongoClient } from 'mongodb';
import { writeFileSync, readFileSync } from 'node:fs';

const HUBSPOT_API = 'https://api.hubapi.com';

// Plan fijo: derivado de audit-hubspot-company-name-duplicates.mjs (caso UN_IDSAP).
// primary = el que trae idsap. secondaries = los que se absorben.
const PLAN = [
  { label: 'Ferreteria Lugo', idsap: 'C00217', primary: '57789834165', secondaries: ['57815696510'] },
  { label: 'GRUPO ITM', idsap: 'C00002', primary: '57813986105', secondaries: ['57804862063'] },
  { label: 'Impelsa', idsap: 'C00099', primary: '57809049370', secondaries: ['57801341576'] },
  { label: 'ITS InfoCom', idsap: 'C00302', primary: '57796418100', secondaries: ['57807806136'] },
  { label: 'PALMARES DEL CASTILLO', idsap: 'C00512', primary: '57849110679', secondaries: ['45830600623', '45841662802'] },
  { label: 'SIECO', idsap: 'C00511', primary: '57849108880', secondaries: ['45819887395'] },
  { label: 'Solpro', idsap: 'C00007', primary: '57803964055', secondaries: ['57807806042'] },
  { label: 'SUMELSA', idsap: 'C00132', primary: '57790448746', secondaries: ['57802267269'] },
  { label: 'TELSSA', idsap: 'C00003', primary: '45831062713', secondaries: ['57793215515'] },
];

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const onlyIdx = flags.indexOf('--only');
const only = onlyIdx >= 0 ? flags[onlyIdx + 1] : null;
const snapIdx = flags.indexOf('--snapshot');
const snapshotPath = snapIdx >= 0 ? flags[snapIdx + 1] : null;
const planIdx = flags.indexOf('--plan');
const planPath = planIdx >= 0 ? flags[planIdx + 1] : null;
const objIdx = flags.indexOf('--object');
const objectType = objIdx >= 0 ? flags[objIdx + 1] : 'companies';

const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/merge-hubspot-company-duplicates.mjs <tenantDb> [--apply] [--only <texto>] [--snapshot <ruta.json>]');
  process.exit(1);
}
if (!tenantDb) usage('Missing tenant database name.');
if (!uri) usage('MONGODB_URI is not set.');
if (!clientId || !clientSecret) usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set.');

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

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

// OJO: batch/read NO resuelve los IDs alias que deja un merge (los reporta como
// inexistentes). El GET individual SI los sigue y devuelve el objeto vigente,
// cuyo `id` puede ser DISTINTO al pedido: al fusionar, HubSpot crea un ID nuevo
// y deja primario y secundario como alias. Por eso aca solo se usa GET individual,
// y siempre se lee el `id` de la respuesta, nunca el que se pidio.
async function readCompany(token, id, props) {
  const query = new URLSearchParams({ properties: props.join(',') });
  return hubspotRequest(
    token,
    'GET',
    `/crm/v3/objects/${objectType}/${id}?${query.toString()}`,
    null,
    { allow404: true },
  );
}

async function readCompanies(token, ids, props) {
  const out = new Map();
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await readCompany(token, id, props);
    if (rec) out.set(String(id), rec); // clave = ID pedido; rec.id = ID vigente
  }
  return out;
}

// Solo para el snapshot: manda las 266 propiedades en el body, sin limite de URL.
// Los registros del snapshot son pre-merge, asi que no hay alias que resolver.
async function batchReadCompanies(token, ids, props) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    // eslint-disable-next-line no-await-in-loop
    const res = await hubspotRequest(token, 'POST', `/crm/v3/objects/${objectType}/batch/read`, {
      properties: props,
      inputs: chunk.map((id) => ({ id })),
    });
    for (const r of res?.results ?? []) out.set(String(r.id), r);
  }
  return out;
}

// Que se lee para verificar, y que asociacion sirve de guard "no perdimos nada":
// en companies son los contactos que cuelgan; en contacts, las companies.
const PERFIL = {
  companies: {
    verifyProps: ['name', 'idsap', 'codigo_de_sn', 'ruc', 'razon_social', 'num_associated_contacts'],
    guardAssoc: 'contacts',
    etiqueta: (p) => `name="${p.name}" idsap=${p.idsap ?? '--'} ruc=${p.ruc ?? '--'}`,
  },
  contacts: {
    verifyProps: ['firstname', 'lastname', 'email', 'idsap', 'internalcode', 'associatedcompanyid'],
    guardAssoc: 'companies',
    etiqueta: (p) => `name="${[p.firstname, p.lastname].filter(Boolean).join(' ')}" idsap=${p.idsap ?? '--'} ic=${p.internalcode ?? '--'} email=${p.email ?? '--'}`,
  },
};
if (!PERFIL[objectType]) usage(`--object solo acepta ${Object.keys(PERFIL).join(' o ')}, no "${objectType}".`);
const { verifyProps: VERIFY_PROPS, guardAssoc: GUARD_ASSOC, etiqueta } = PERFIL[objectType];

async function listAssociations(token, companyId, toObjectType) {
  const res = await hubspotRequest(
    token,
    'GET',
    `/crm/v4/objects/${objectType}/${companyId}/associations/${toObjectType}?limit=500`,
    null,
    { allow404: true },
  );
  return (res?.results ?? []).map((r) => String(r.toObjectId));
}

const mongo = new MongoClient(uri);
try {
  await mongo.connect();
  const credentials = await mongo.db(tenantDb).collection('HubspotCredentials')
    .findOne({ refreshToken: { $nin: [null, ''] } });
  if (!credentials) throw new Error(`No HubspotCredentials con refreshToken en ${tenantDb}`);

  console.log(`${tenantDb}: portal ${credentials.portalId ?? 'unknown'} - refrescando token`);
  const token = await refreshAccessToken(credentials);

  // Sin --plan se usa el PLAN fijo del caso 1. Con --plan se carga el JSON que
  // genera analyze-hubspot-company-duplicates.mjs, cuyos grupos traen idsap null
  // (caso 3: ningun registro del grupo esta en SAP).
  const origen = planPath ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  const base = origen ? origen.grupos : PLAN;
  if (origen) {
    console.log(`Plan externo: ${planPath} (tiers ${(origen.tiersIncluidos ?? []).join(',')}, generado ${origen.generadoEn})`);
    if (origen.objectType && origen.objectType !== objectType) {
      usage(`El plan es de "${origen.objectType}" pero --object dice "${objectType}".`);
    }
    if (origen.tenantDb && origen.tenantDb !== tenantDb) {
      usage(`El plan fue generado para "${origen.tenantDb}", no para "${tenantDb}".`);
    }
  }

  const plan = only
    ? base.filter((g) => g.label.toLowerCase().includes(only.toLowerCase()))
    : base;
  if (plan.length === 0) usage(`--only "${only}" no coincide con ningun grupo del plan.`);

  const allIds = plan.flatMap((g) => [g.primary, ...g.secondaries]);
  console.log(`Grupos en plan: ${plan.length} | registros: ${allIds.length} | merges: ${allIds.length - plan.length}`);

  // Todas las propiedades del portal, para que el snapshot sea completo.
  const propsMeta = await hubspotRequest(token, 'GET', `/crm/v3/properties/${objectType}`);
  const allProps = (propsMeta?.results ?? []).map((p) => p.name);
  console.log(`Propiedades del portal: ${allProps.length}`);

  // ---- Paso 0: snapshot ----
  console.log('\nPaso 0 - snapshot de los registros involucrados...');
  const records = await batchReadCompanies(token, allIds, allProps);
  const snapshot = { capturadoEn: new Date().toISOString(), tenantDb, portalId: credentials.portalId ?? null, grupos: [] };
  for (const g of plan) {
    const registros = [];
    for (const id of [g.primary, ...g.secondaries]) {
      const rec = records.get(id);
      // eslint-disable-next-line no-await-in-loop
      const contactIds = rec ? await listAssociations(token, id, GUARD_ASSOC) : [];
      // eslint-disable-next-line no-await-in-loop
      const dealIds = rec ? await listAssociations(token, id, 'deals') : [];
      registros.push({ id, existe: Boolean(rec), properties: rec?.properties ?? null, contactIds, dealIds });
    }
    snapshot.grupos.push({ label: g.label, idsap: g.idsap, primary: g.primary, secondaries: g.secondaries, registros });
  }
  if (snapshotPath) {
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`  snapshot -> ${snapshotPath}`);
  } else {
    console.log('  (sin --snapshot: no se escribio a disco)');
  }

  // ---- Paso 1: re-verificacion en vivo ----
  console.log('\nPaso 1 - re-verificacion en vivo...');
  const ok = [];
  const abortados = [];
  for (const g of plan) {
    const grupoSnap = snapshot.grupos.find((s) => s.label === g.label);
    // GET individual: sigue alias de merges previos y devuelve el ID vigente.
    // eslint-disable-next-line no-await-in-loop
    const primaryRec = await readCompany(token, g.primary, VERIFY_PROPS);
    const problemas = [];

    // El plan declara que identidad debe traer el primario. En companies es solo
    // idsap; en contacts son idsap e internalcode, independientes entre si: el
    // primario puede tener una, la otra, o ninguna.
    // Campo null en el plan = NADIE del grupo debe traerlo. Si alguien lo gano
    // desde que se genero el plan, el grupo cambio de caso y se re-audita.
    const IDENT = objectType === 'contacts' ? ['idsap', 'internalcode'] : ['idsap'];

    if (!primaryRec) problemas.push(`primario ${g.primary} no existe`);

    // La identidad se verifica a nivel de GRUPO, no por registro: en los grupos
    // MIXTO cada identidad vive en un registro distinto (uno trae idsap, otro
    // internalcode) y el merge las junta, que es justamente lo que se busca.
    // Lo que no puede pasar es que un campo tenga DOS valores distintos en el
    // grupo, o que aparezca un valor que el plan no declaraba.
    const vistos = Object.fromEntries(IDENT.map((campo) => [campo, new Set()]));
    const anota = (rec, quien) => {
      for (const campo of IDENT) {
        const v = isEmpty(rec.properties?.[campo]) ? null : String(rec.properties[campo]).trim();
        if (!v) continue;
        vistos[campo].add(v);
        const esperado = isEmpty(g[campo]) ? null : String(g[campo]).trim();
        if (!esperado) problemas.push(`${quien} AHORA tiene ${campo}=${v}, que el plan no declaraba`);
        else if (v !== esperado) problemas.push(`${quien} tiene ${campo}=${v}, el plan esperaba ${esperado}`);
      }
    };
    if (primaryRec) anota(primaryRec, `primario ${g.primary}`);

    for (const sid of g.secondaries) {
      // eslint-disable-next-line no-await-in-loop
      const rec = await readCompany(token, sid, VERIFY_PROPS);
      if (!rec) problemas.push(`secundario ${sid} no existe`);
      else if (String(rec.id) === String(primaryRec?.id)) {
        problemas.push(`secundario ${sid} YA fue fusionado en el primario (ambos resuelven a ${rec.id})`);
      } else {
        anota(rec, `secundario ${sid}`);
      }
    }

    // Cada identidad que el plan declaraba tiene que seguir existiendo en algun
    // registro del grupo; si desaparecio, el merge no la podria reconstruir.
    for (const campo of IDENT) {
      if (!isEmpty(g[campo]) && vistos[campo].size === 0) {
        problemas.push(`ningun registro del grupo tiene ya ${campo}=${g[campo]}`);
      }
    }

    // El ID vigente del primario, que es el que hay que usar al fusionar.
    g.currentPrimary = primaryRec ? String(primaryRec.id) : g.primary;

    if (problemas.length) {
      abortados.push({ g, problemas });
      console.log(`  [ABORTA] ${g.label}: ${problemas.join('; ')}`);
    } else {
      ok.push(g);
      const pc = grupoSnap.registros[0].contactIds.length;
      const sc = grupoSnap.registros.slice(1).reduce((a, r) => a + r.contactIds.length, 0);
      const union = new Set(grupoSnap.registros.flatMap((r) => r.contactIds)).size;
      console.log(`  [OK] ${g.label} (${g.idsap}): primario ${g.primary} (${pc} contactos) <- ${g.secondaries.join(', ')} (${sc} contactos) | union esperada = ${union}`);
    }
  }

  if (ok.length === 0) {
    console.log('\nNada que fusionar.');
    process.exit(0);
  }

  // ---- Paso 2/3 ----
  if (!apply) {
    console.log(`\nDRY RUN - operaciones que se ejecutarian (${ok.reduce((a, g) => a + g.secondaries.length, 0)}):`);
    let n = 0;
    for (const g of ok) {
      for (const sid of g.secondaries) {
        n += 1;
        console.log(`  ${String(n).padStart(2)}. POST /crm/v3/objects/${objectType}/merge { primaryObjectId: "${g.currentPrimary}", objectIdToMerge: "${sid}" }  // ${g.label}`);
      }
    }
    if (abortados.length) console.log(`\n  (${abortados.length} grupo(s) abortado(s) por la verificacion)`);
    console.log('\nRe-ejecutar con --apply para fusionar. EL MERGE ES IRREVERSIBLE.');
    process.exit(0);
  }

  console.log('\nPaso 3 - APLICANDO merges (secuencial, se detiene al primer error)...');
  const resultados = [];
  for (const g of ok) {
    const snapGrupo = snapshot.grupos.find((s) => s.label === g.label);
    const unionEsperada = new Set(snapGrupo.registros.flatMap((r) => r.contactIds)).size;

    // Cada merge devuelve un ID NUEVO. Hay que re-resolverlo antes del siguiente,
    // o el segundo merge de un grupo de 3 apuntaria a un ID que ya es alias.
    let vigente = g.currentPrimary;
    for (const sid of g.secondaries) {
      console.log(`  ${g.label}: fusionando ${sid} -> ${vigente} ...`);
      // eslint-disable-next-line no-await-in-loop
      const merged = await hubspotRequest(token, 'POST', `/crm/v3/objects/${objectType}/merge`, {
        primaryObjectId: vigente,
        objectIdToMerge: sid,
      });
      const nuevo = merged?.id ? String(merged.id) : null;
      if (nuevo && nuevo !== vigente) console.log(`    ID resultante: ${nuevo} (antes ${vigente})`);
      // eslint-disable-next-line no-await-in-loop
      vigente = nuevo ?? String((await readCompany(token, vigente, VERIFY_PROPS))?.id ?? vigente);
    }

    // eslint-disable-next-line no-await-in-loop
    const after = await readCompany(token, vigente, VERIFY_PROPS);
    const finalId = after ? String(after.id) : vigente;
    const p = after?.properties ?? {};

    // Las asociaciones tardan en propagarse tras el merge: leerlas de inmediato
    // devuelve 0 aunque no se haya perdido nada. Reintentar antes de dar por
    // perdido un contacto, si no el guard aborta por una falsa alarma.
    let contactosReales = 0;
    for (let intento = 1; intento <= 6; intento += 1) {
      // eslint-disable-next-line no-await-in-loop
      contactosReales = (await listAssociations(token, finalId, GUARD_ASSOC)).length;
      if (contactosReales >= unionEsperada) break;
      console.log(`    (asociaciones aun propagando: ${contactosReales}/${unionEsperada}, reintento ${intento}/6)`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000 * intento));
    }

    const alerta = contactosReales < unionEsperada ? `  <-- ALERTA: esperados >= ${unionEsperada}` : '';
    console.log(`    resultado: id=${finalId} ${etiqueta(p)} ${GUARD_ASSOC}=${contactosReales} (union esperada ${unionEsperada})${alerta}`);
    resultados.push({ label: g.label, idOriginal: g.primary, idFinal: finalId, idsap: p.idsap ?? null, name: p.name ?? null, contactosReales, unionEsperada });

    // Toda identidad que el plan declaraba tiene que seguir ahi despues del merge.
    // Si el grupo no tenia ninguna, no hay nada que comprobar.
    for (const campo of (objectType === 'contacts' ? ['idsap', 'internalcode'] : ['idsap'])) {
      if (!isEmpty(g[campo]) && isEmpty(p[campo])) {
        throw new Error(`Tras el merge, ${finalId} (${g.label}) quedo SIN ${campo}. Deteniendo.`);
      }
    }
    if (contactosReales < unionEsperada) throw new Error(`Tras el merge, ${finalId} (${g.label}) tiene ${contactosReales} ${GUARD_ASSOC}, menos que la union esperada ${unionEsperada}. Deteniendo.`);
  }

  console.log(`\nListo. ${resultados.length} grupo(s) fusionado(s), ${ok.reduce((a, g) => a + g.secondaries.length, 0)} merge(s).`);
  if (abortados.length) {
    console.log(`${abortados.length} grupo(s) NO se tocaron:`);
    abortados.forEach(({ g, problemas }) => console.log(`  - ${g.label}: ${problemas.join('; ')}`));
  }
} catch (error) {
  console.error(`\nERROR: ${error.message ?? error}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
