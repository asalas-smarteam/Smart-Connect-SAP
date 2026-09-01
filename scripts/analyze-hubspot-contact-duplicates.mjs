// Analiza contactos duplicados por NOMBRE en el portal de un tenant. SOLO LECTURA.
//
// Los contactos tienen DOS identidades SAP independientes, no alternativas:
//   idsap        -> CardCode del BusinessPartner (C00xxx / E00xxx): el contacto ES un cliente
//   internalcode -> InternalCode del ContactEmployee (numerico): el contacto pertenece a una empresa
// Un mismo humano puede tener las dos: en este portal ya hay contactos con ambas
// pobladas y valores distintos. Por eso un grupo con uno de cada tipo NO es un
// conflicto, es la misma persona en sus dos roles.
//
// El email no sirve de llave: HubSpot lo fuerza unico en contacts, asi que nunca
// colisiona, y ademas la mitad de los contactos no tiene.
//
// Categorias:
//   C1       exactamente UN registro identificado  -> ganador claro, como el caso 1 de companies
//   MIXTO    unos con idsap y otros con internalcode, sin choque dentro de cada
//            campo -> misma persona en dos roles; al fusionar queda un registro
//            con las dos identidades
//   CONFLICTO  dos idsap distintos, o dos internalcode distintos -> revisar a mano
//   C3       ninguno identificado -> se clasifica por evidencia (email/telefono/empresa)
//   EMPRESAS_DISTINTAS  el grupo se reparte entre companies distintas -> casi seguro
//            son personas distintas con el mismo nombre; NUNCA se fusiona solo
//
// Uso:
//   node --env-file=.env scripts/analyze-hubspot-contact-duplicates.mjs <tenantDb> [--plan <salida.json>] [--categoria C1]
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const HUBSPOT_API = 'https://api.hubapi.com';
const PAGE_LIMIT = 100;
const ASSOC_TYPES = ['companies', 'deals', 'tickets', 'notes', 'tasks', 'emails', 'calls', 'meetings'];

const [, , tenantDb, ...flags] = process.argv;
const planIdx = flags.indexOf('--plan');
const planPath = planIdx >= 0 ? flags[planIdx + 1] : null;
const catIdx = flags.indexOf('--categoria');
const catWanted = catIdx >= 0 ? flags[catIdx + 1].toUpperCase() : 'C1';

const uri = process.env.MONGODB_URI;
const clientId = process.env.HUBSPOT_CLIENT_ID;
const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/analyze-hubspot-contact-duplicates.mjs <tenantDb> [--plan <salida.json>] [--categoria C1]');
  process.exit(1);
}
if (!tenantDb) usage('Missing tenant database name.');
if (!uri) usage('MONGODB_URI is not set.');
if (!clientId || !clientSecret) usage('HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be set.');

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
const clean = (v) => (isEmpty(v) ? null : String(v).trim());
const digits = (v) => (isEmpty(v) ? null : String(v).replace(/[^0-9]/g, '') || null);

function normalizeName(first, last) {
  return `${first ?? ''} ${last ?? ''}`
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nombres basura ("0", "1", iniciales sueltas) agrupan personas sin relacion.
function nombreUsable(key) {
  return key.length >= 4 && /[A-Z]/.test(key);
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
  'firstname', 'lastname', 'email', 'idsap', 'internalcode', 'phone', 'mobilephone',
  'jobtitle', 'associatedcompanyid', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate',
];

async function listAllContacts(token) {
  const out = [];
  let after;
  do {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      properties: PROPS.join(','),
      ...(after ? { after } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    const page = await hubspotRequest(token, 'GET', `/crm/v3/objects/contacts?${query.toString()}`);
    out.push(...(page?.results ?? []));
    after = page?.paging?.next?.after;
  } while (after);
  return out;
}

async function contarAsociaciones(token, contactId) {
  const conteo = {};
  for (const tipo of ASSOC_TYPES) {
    // eslint-disable-next-line no-await-in-loop
    const res = await hubspotRequest(
      token,
      'GET',
      `/crm/v4/objects/contacts/${contactId}/associations/${tipo}?limit=100`,
      null,
      { allow404: true },
    );
    const n = (res?.results ?? []).length;
    if (n > 0) conteo[tipo] = n;
  }
  return conteo;
}

function identidad(props) {
  const sap = clean(props?.idsap);
  const ic = clean(props?.internalcode);
  if (sap && ic) return `SAP:${sap}+IC:${ic}`;
  if (sap) return `SAP:${sap}`;
  if (ic) return `IC:${ic}`;
  return null;
}

function clasificar(registros) {
  const empresas = [...new Set(registros.map((r) => clean(r.properties?.associatedcompanyid)).filter(Boolean))];
  if (empresas.length > 1) {
    return { categoria: 'EMPRESAS_DISTINTAS', motivo: `repartidos entre companies ${empresas.join(' vs ')}` };
  }

  const saps = [...new Set(registros.map((r) => clean(r.properties?.idsap)).filter(Boolean))];
  const ics = [...new Set(registros.map((r) => clean(r.properties?.internalcode)).filter(Boolean))];
  const identificados = registros.filter((r) => identidad(r.properties)).length;

  if (saps.length > 1) return { categoria: 'CONFLICTO', motivo: `idsap distintos: ${saps.join(' vs ')}` };
  if (ics.length > 1) return { categoria: 'CONFLICTO', motivo: `internalcode distintos: ${ics.join(' vs ')}` };

  if (identificados === 0) {
    const emails = [...new Set(registros.map((r) => clean(r.properties?.email)?.toLowerCase()).filter(Boolean))];
    const tels = [...new Set(registros.flatMap((r) => [digits(r.properties?.phone), digits(r.properties?.mobilephone)]).filter(Boolean))];
    // Un valor solo es EVIDENCIA si dos o mas registros lo comparten. Si lo trae
    // uno solo y el resto lo tiene vacio, no confirma nada: no hay con que
    // contrastar. Contar "un unico valor distinto" como coincidencia inflaba la
    // evidencia de grupos donde el secundario esta completamente vacio.
    const conTel = registros.filter((r) => digits(r.properties?.phone) || digits(r.properties?.mobilephone)).length;
    const conEmpresa = registros.filter((r) => !isEmpty(r.properties?.associatedcompanyid)).length;

    const senales = [];
    if (emails.length > 1) senales.push(`OJO emails distintos: ${emails.join(' vs ')}`);
    if (tels.length > 1) senales.push(`OJO telefonos distintos: ${tels.join(' vs ')}`);
    else if (tels.length === 1 && conTel > 1) senales.push(`mismo telefono ${tels[0]} en ${conTel} registros`);
    else if (tels.length === 1) senales.push(`telefono ${tels[0]} en 1 solo registro (no confirma)`);
    if (empresas.length === 1 && conEmpresa > 1) senales.push(`misma empresa ${empresas[0]} en ${conEmpresa} registros`);
    else if (empresas.length === 1) senales.push(`empresa ${empresas[0]} en 1 solo registro (no confirma)`);

    // Confirmado = al menos una senal compartida por 2+ registros.
    const confirmado = (tels.length === 1 && conTel > 1) || (empresas.length === 1 && conEmpresa > 1);
    if (!confirmado && !senales.some((s) => s.startsWith('OJO'))) {
      return {
        categoria: 'C3_SIN_EVIDENCIA',
        motivo: senales.length ? `${senales.join('; ')}; solo el nombre coincide` : 'solo coincide el nombre',
      };
    }
    const hayOjo = senales.some((s) => s.startsWith('OJO'));
    return {
      categoria: hayOjo ? 'C3_REVISAR' : 'C3',
      motivo: senales.length ? senales.join('; ') : 'solo coincide el nombre, sin identidad ni otra senal',
    };
  }

  if (identificados === 1) {
    return { categoria: 'C1', motivo: `solo 1 identificado (${saps[0] ? `idsap ${saps[0]}` : `internalcode ${ics[0]}`})` };
  }

  // Varios identificados, sin choque dentro de idsap ni dentro de internalcode:
  // los roles se complementan en vez de contradecirse.
  return {
    categoria: 'MIXTO',
    motivo: `misma persona en 2 roles: idsap ${saps[0] ?? '--'} + internalcode ${ics[0] ?? '--'}`,
  };
}

// Primario: el mas identificado (2 identidades > 1 > 0); empata -> mas asociaciones;
// empata -> mas campos; empata -> mas viejo.
function elegirPrimario(registros) {
  const peso = (r) => (clean(r.properties?.idsap) ? 2 : 0) + (clean(r.properties?.internalcode) ? 1 : 0);
  const campos = (r) => PROPS.filter((k) => !isEmpty(r.properties?.[k])).length;
  const asoc = (r) => Object.values(r.asociaciones).reduce((a, b) => a + b, 0);
  return [...registros].sort((a, b) => (peso(b) - peso(a))
    || (asoc(b) - asoc(a))
    || (campos(b) - campos(a))
    || String(a.properties?.createdate ?? '').localeCompare(String(b.properties?.createdate ?? '')))[0];
}

const mongo = new MongoClient(uri);
try {
  await mongo.connect();
  const credentials = await mongo.db(tenantDb).collection('HubspotCredentials')
    .findOne({ refreshToken: { $nin: [null, ''] } });
  if (!credentials) throw new Error(`No HubspotCredentials con refreshToken en ${tenantDb}`);

  console.log(`${tenantDb}: portal ${credentials.portalId ?? 'unknown'} - refrescando token`);
  const token = await refreshAccessToken(credentials);

  const propsMeta = await hubspotRequest(token, 'GET', '/crm/v3/properties/contacts');
  const existentes = new Set((propsMeta?.results ?? []).map((p) => p.name));
  for (const p of ['idsap', 'internalcode']) {
    if (!existentes.has(p)) throw new Error(`La propiedad "${p}" no existe en contacts del portal ${credentials.portalId}`);
  }

  console.log('Leyendo todos los contactos...');
  const contactos = await listAllContacts(token);
  console.log(`Total contactos: ${contactos.length}`);

  const groups = new Map();
  let sinNombre = 0;
  let nombreBasura = 0;
  for (const c of contactos) {
    const key = normalizeName(c.properties?.firstname, c.properties?.lastname);
    if (!key) { sinNombre += 1; continue; }
    if (!nombreUsable(key)) { nombreBasura += 1; continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const dup = [...groups.entries()].filter(([, l]) => l.length > 1);
  console.log(`  sin nombre: ${sinNombre} | nombre no usable (basura): ${nombreBasura}`);
  console.log(`Grupos duplicados por nombre: ${dup.length} (${dup.reduce((a, [, l]) => a + l.length, 0)} registros)\n`);

  console.log('Leyendo asociaciones de cada registro...');
  const analizados = [];
  for (const [key, list] of dup) {
    const registros = [];
    for (const c of list) {
      // eslint-disable-next-line no-await-in-loop
      const asociaciones = await contarAsociaciones(token, c.id);
      registros.push({ id: String(c.id), properties: c.properties ?? {}, asociaciones });
    }
    const { categoria, motivo } = clasificar(registros);
    const primario = elegirPrimario(registros);
    analizados.push({
      label: key,
      categoria,
      motivo,
      primary: primario.id,
      secondaries: registros.filter((r) => r.id !== primario.id).map((r) => r.id),
      registros,
    });
  }

  const ORDEN = ['C1', 'MIXTO', 'C3', 'C3_SIN_EVIDENCIA', 'C3_REVISAR', 'CONFLICTO', 'EMPRESAS_DISTINTAS'];
  const por = (cat) => analizados.filter((a) => a.categoria === cat);

  console.log('\n===== RESUMEN =====');
  for (const cat of ORDEN) {
    const l = por(cat);
    console.log(`  ${cat.padEnd(20)} ${String(l.length).padStart(3)} grupo(s), ${l.reduce((a, g) => a + g.secondaries.length, 0)} merge(s)`);
  }

  for (const cat of ORDEN) {
    const list = por(cat);
    if (!list.length) continue;
    console.log(`\n===== ${cat} (${list.length}) =====`);
    for (const g of [...list].sort((a, b) => a.label.localeCompare(b.label))) {
      console.log(`  [${g.label}] x${g.registros.length} -- ${g.motivo}`);
      for (const r of g.registros) {
        const p = r.properties;
        const marca = r.id === g.primary ? '>' : ' ';
        const asoc = Object.entries(r.asociaciones).map(([k, v]) => `${k}:${v}`).join(' ') || '--';
        console.log(`      ${marca} id=${r.id} | idsap=${p.idsap ?? '--'} | ic=${p.internalcode ?? '--'} | email=${p.email ?? '--'} | tel=${p.phone ?? p.mobilephone ?? '--'} | empresa=${p.associatedcompanyid ?? '--'} | asoc: ${asoc} | creado=${String(p.createdate ?? '').slice(0, 10)}`);
      }
    }
  }

  if (planPath) {
    const incluidos = por(catWanted);
    const plan = {
      generadoEn: new Date().toISOString(),
      tenantDb,
      portalId: credentials.portalId ?? null,
      objectType: 'contacts',
      categoria: catWanted,
      // La identidad viaja en el plan para que el merge la re-verifique en vivo,
      // y es del GRUPO, no del primario: en los MIXTO cada identidad vive en un
      // registro distinto y el merge las junta. Al llegar aca ya se garantizo
      // que no hay mas de un valor por campo (si lo hubiera seria CONFLICTO).
      grupos: incluidos.map((g) => {
        const unico = (campo) => {
          const vals = [...new Set(g.registros.map((r) => clean(r.properties?.[campo])).filter(Boolean))];
          return vals[0] ?? null;
        };
        return {
          label: g.label,
          categoria: g.categoria,
          motivo: g.motivo,
          idsap: unico('idsap'),
          internalcode: unico('internalcode'),
          primary: g.primary,
          secondaries: g.secondaries,
        };
      }),
    };
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
    console.log(`\nPlan (${catWanted}): ${plan.grupos.length} grupo(s), ${plan.grupos.reduce((a, g) => a + g.secondaries.length, 0)} merge(s) -> ${planPath}`);
  }
} catch (error) {
  console.error(`\nERROR: ${error.message ?? error}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
