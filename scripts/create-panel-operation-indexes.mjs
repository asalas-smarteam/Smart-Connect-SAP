// scripts/create-panel-operation-indexes.mjs
//
// Índices que usan las listas de Eventos y Syncs del panel de soporte (/panel/api), en la base
// de UN tenant. No se agregaron a los esquemas Mongoose a propósito: así el arranque de la API
// no los construye solo en todos los tenants de producción. Se crean a mano, con evidencia.
//
//   WebhookEvents: { createdAt: -1 }, { status: 1, createdAt: -1 },
//                  { 'payload.deal.hs_object_id': 1, createdAt: -1 }
//   SyncLogs:      { startedAt: -1 }, { clientConfigId: 1, startedAt: -1 },
//                  { startedAt: -1, _id: -1 } parcial (recordsProcessed > 0) para ?hideEmpty=true
//
// Dry run por defecto: imprime, por colección, la cantidad de documentos, el tamaño, los índices
// actuales y los que faltan, sin escribir nada. Con --apply crea solo los que faltan. Es
// idempotente. No crea bases ni colecciones: si no existen, lo dice y no hace nada.
//
// Uso, un tenant a la vez:
//   node --env-file=.env scripts/create-panel-operation-indexes.mjs <tenantDbName> [--apply]
//   (en producción: docker compose exec api node scripts/create-panel-operation-indexes.mjs <tenantDbName>)
import { MongoClient } from 'mongodb';

// Cada índice: { key, options }. Se compara solo la llave (orden y dirección).
const INDEXES = Object.freeze({
  WebhookEvents: [
    { key: { createdAt: -1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { 'payload.deal.hs_object_id': 1, createdAt: -1 } },
  ],
  SyncLogs: [
    { key: { startedAt: -1 } },
    { key: { clientConfigId: 1, startedAt: -1 } },
    // Corridas con registros (?hideEmpty=true): la mayoría son vueltas vacías de la cola.
    { key: { startedAt: -1, _id: -1 }, options: { partialFilterExpression: { recordsProcessed: { $gt: 0 } } } },
  ],
});

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/create-panel-operation-indexes.mjs <tenantDbName> [--apply]');
  process.exit(1);
}

if (!tenantDb || tenantDb.startsWith('--')) {
  usage('Missing tenant database name.');
}

// Solo bases de tenant: nunca la master, admin ni otra base del servidor.
const tenantPrefix = `${process.env.TENANT_DB_PREFIX || 'sap_integration'}_`;
if (!tenantDb.startsWith(tenantPrefix)) {
  usage(`The database name must start with ${tenantPrefix}`);
}

// Sin default a localhost: apuntar en silencio a un Mongo vacío haría creer que todo está bien.
if (!uri) {
  usage('MONGODB_URI is not set. Export it or run with `node --env-file=.env`.');
}

const sameKey = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'n/d';
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function collectionSize(db, name) {
  try {
    const [stats] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    return stats?.storageStats?.storageSize;
  } catch (error) {
    return undefined;
  }
}

const client = new MongoClient(uri);

async function main() {
  await client.connect();

  // Un nombre mal escrito no debe crear una base nueva.
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  if (!databases.some((database) => database.name === tenantDb)) {
    console.error(`${tenantDb}: la base no existe. No se hace nada.`);
    process.exitCode = 1;
    return;
  }

  const db = client.db(tenantDb);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  let created = 0;
  let missingTotal = 0;

  for (const [name, wanted] of Object.entries(INDEXES)) {
    if (!existing.has(name)) {
      console.log(`${tenantDb}.${name}: la colección no existe; se omite.`);
      continue;
    }
    const collection = db.collection(name);
    const count = await collection.estimatedDocumentCount();
    const size = await collectionSize(db, name);
    const current = await collection.indexes();
    const missing = wanted.filter(({ key }) => !current.some((index) => sameKey(index.key, key)));
    missingTotal += missing.length;

    console.log(`${tenantDb}.${name}: ${count} documento(s), ${formatBytes(size)}`);
    console.log(`  índices actuales: ${current.map((index) => JSON.stringify(index.key)).join(', ')}`);
    console.log(`  faltan: ${missing.length ? missing.map(({ key, options }) => JSON.stringify(key) + (options ? ' (parcial)' : '')).join(', ') : 'ninguno'}`);

    if (apply) {
      for (const { key, options } of missing) {
        await collection.createIndex(key, options ?? {});
        created += 1;
        console.log(`  creado: ${JSON.stringify(key)}`);
      }
    }
  }

  if (!apply) {
    console.log(missingTotal ? 'Dry run. Re-run with --apply to create the missing indexes.' : 'Dry run. Nothing to create.');
  } else {
    console.log(`${tenantDb}: ${created} índice(s) creado(s).`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`${tenantDb}: error: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
