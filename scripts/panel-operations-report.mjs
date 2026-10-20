// scripts/panel-operations-report.mjs
//
// Diagnóstico de SOLO LECTURA para el panel de soporte (plan 5, A0), en la base de UN tenant.
// Sirve para afinar con evidencia el catálogo de causas de error (src/domain/panel/errorCauses.js),
// el saneador de textos para clientes (errorText.js) y el número de documento del resumen (F6).
//
// Muestra:
//   - SyncLogs: corridas con y sin tarea (clientConfigId), por objectType, y cuántas están vacías;
//   - WebhookEvents: los 50 lastError más frecuentes, normalizados (números, ids, IPs, hosts,
//     URLs y correos reemplazados por marcadores), sobre los 20 000 errores más recientes;
//   - claves de primer nivel de errorMessage y de los ítems de errors (sin valores);
//   - eventos creados con y sin sapAudit.responseSap.DocNum, y claves de responseSap (sin valores).
//
// No escribe nada. Ojo: los textos de error pueden traer datos del negocio; revisa la salida
// antes de compartirla.
//
// Uso:
//   node --env-file=.env scripts/panel-operations-report.mjs <tenantDbName>
import { MongoClient } from 'mongodb';

const [, , tenantDb] = process.argv;
const uri = process.env.MONGODB_URI;
const tenantPrefix = `${process.env.TENANT_DB_PREFIX || 'sap_integration'}_`;
const MAX_ERRORS = 20000;
const TOP = 50;
const SAMPLE = 300;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/panel-operations-report.mjs <tenantDbName>');
  process.exit(1);
}

if (!tenantDb || tenantDb.startsWith('--')) {
  usage('Missing tenant database name.');
}
if (!tenantDb.startsWith(tenantPrefix)) {
  usage(`The database name must start with ${tenantPrefix}`);
}
if (!uri) {
  usage('MONGODB_URI is not set. Export it or run with `node --env-file=.env`.');
}

function normalizeErrorText(text) {
  return String(text)
    .replace(/\b(?:https?|wss?):\/\/[^\s'"<>()]+/gi, '<url>')
    .replace(/\b[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi, '<correo>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '<ip>')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/gi, '<host>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function keysOf(value, into) {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of Object.keys(item)) {
        into.set(key, (into.get(key) ?? 0) + 1);
      }
    } else {
      const kind = Array.isArray(item) ? '<lista>' : `<${typeof item}>`;
      into.set(kind, (into.get(kind) ?? 0) + 1);
    }
  }
}

function printCounts(title, map) {
  console.log(title);
  const rows = [...map].sort((left, right) => right[1] - left[1]);
  if (rows.length === 0) {
    console.log('  (nada)');
  }
  for (const [key, count] of rows) {
    console.log(`  ${String(count).padStart(7)}  ${key}`);
  }
}

const client = new MongoClient(uri);

async function main() {
  await client.connect();
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  if (!databases.some((database) => database.name === tenantDb)) {
    console.error(`${tenantDb}: la base no existe.`);
    process.exitCode = 1;
    return;
  }
  const db = client.db(tenantDb);
  console.log(`== ${tenantDb} ==`);

  // --- Corridas ---
  const runs = await db.collection('SyncLogs').aggregate([
    {
      $group: {
        _id: {
          withTask: { $gt: ['$clientConfigId', null] },
          objectType: { $ifNull: ['$objectType', null] },
          empty: { $lte: [{ $ifNull: ['$recordsProcessed', 0] }, 0] },
        },
        count: { $sum: 1 },
      },
    },
  ], { allowDiskUse: true }).toArray();
  printCounts('\nCorridas (con tarea | objectType | vacía):', new Map(runs.map((row) => [
    `${row._id.withTask ? 'con tarea' : 'SIN tarea'} | ${row._id.objectType ?? '-'} | ${row._id.empty ? 'vacía' : 'con registros'}`,
    row.count,
  ])));

  const errorMessageKeys = new Map();
  const errorItemKeys = new Map();
  const withErrorMessage = await db.collection('SyncLogs')
    .find({ errorMessage: { $ne: null } }, { projection: { errorMessage: 1 } })
    .sort({ startedAt: -1 })
    .limit(SAMPLE)
    .toArray();
  for (const run of withErrorMessage) {
    keysOf(run.errorMessage, errorMessageKeys);
  }
  const withErrors = await db.collection('SyncLogs')
    .aggregate([
      { $match: { 'errors.0': { $exists: true } } },
      { $sort: { startedAt: -1 } },
      { $limit: SAMPLE },
      { $project: { errors: { $slice: ['$errors', 3] } } },
    ])
    .toArray();
  for (const run of withErrors) {
    keysOf(run.errors, errorItemKeys);
  }
  printCounts(`\nClaves de errorMessage (últimas ${SAMPLE} corridas con error):`, errorMessageKeys);
  printCounts(`\nClaves de los ítems de errors (últimas ${SAMPLE} corridas con errores):`, errorItemKeys);

  // --- Eventos ---
  const errored = await db.collection('WebhookEvents')
    .find({ status: 'errored', lastError: { $type: 'string' } }, { projection: { lastError: 1 } })
    .sort({ _id: -1 })
    .limit(MAX_ERRORS)
    .toArray();
  const texts = new Map();
  for (const event of errored) {
    const key = normalizeErrorText(event.lastError);
    texts.set(key, (texts.get(key) ?? 0) + 1);
  }
  const top = new Map([...texts].sort((left, right) => right[1] - left[1]).slice(0, TOP));
  printCounts(`\nTop ${TOP} lastError normalizados (${errored.length} eventos con error revisados):`, top);

  const createdStatuses = ['completed', 'sap_order_created', 'sap_created_hubspot_error'];
  const events = db.collection('WebhookEvents');
  const created = await events.countDocuments({ status: { $in: createdStatuses } });
  const withDocNum = await events.countDocuments({ status: { $in: createdStatuses }, 'sapAudit.responseSap.DocNum': { $exists: true } });
  console.log(`\nEventos creados: ${created}; con sapAudit.responseSap.DocNum: ${withDocNum}`);
  const responseKeys = new Map();
  const samples = await events
    .find({ status: { $in: createdStatuses }, 'sapAudit.responseSap': { $type: 'object' } }, { projection: { 'sapAudit.responseSap': 1 } })
    .sort({ _id: -1 })
    .limit(SAMPLE)
    .toArray();
  for (const event of samples) {
    keysOf(event.sapAudit?.responseSap, responseKeys);
  }
  printCounts(`\nClaves de sapAudit.responseSap en eventos creados (últimos ${SAMPLE}):`, responseKeys);
}

try {
  await main();
} catch (error) {
  console.error(`${tenantDb}: error: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
