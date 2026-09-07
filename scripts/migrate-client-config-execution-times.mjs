// scripts/migrate-client-config-execution-times.mjs
//
// Migración por base que convierte ClientConfigs.executionTime de String a array de String.
//
// NO es un prerrequisito de deploy: Mongoose 8 hidrata un escalar guardado en un path [String] como
// array de un elemento, así que el código nuevo lee bien los documentos viejos. Esto es para dejar
// los tipos consistentes en disco, sobre todo porque .lean() NO castea y ahí sí llega el string
// crudo.
//
// Idempotente: los documentos que ya son array no se tocan.
//
// El nombre de la base de un tenant es `${TENANT_DB_PREFIX|sap_integration}_${tenantKey}` (ver
// buildTenantDatabaseName en src/infrastructure/database/tenant/tenantDatabase.js). La base master
// tiene su propia colección ClientConfigs con las plantillas y también hay que correrla.
//
// Uso, una base a la vez:
//   node --env-file=.env scripts/migrate-client-config-execution-times.mjs <dbName> [--apply]
//
// Dry run por defecto: sin --apply no se escribe nada.
import { MongoClient } from 'mongodb';
// Importado, NO copiado: el formato de la hora vive en un solo lugar. Se puede importar sin
// arrastrar nada porque execution-times.js es puro y no tiene imports propios.
import { EXECUTION_TIME_PATTERN } from '../src/domain/sync/execution-times.js';

const COLLECTION = 'ClientConfigs';

const [, , dbName, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/migrate-client-config-execution-times.mjs <dbName> [--apply]');
  process.exit(1);
}

if (!dbName) {
  usage('Missing database name.');
}

if (!uri) {
  usage('Missing MONGODB_URI.');
}

const client = new MongoClient(uri);

try {
  await client.connect();
  const collection = client.db(dbName).collection(COLLECTION);

  const candidates = await collection
    .find({ executionTime: { $type: 'string' } })
    .project({ _id: 1, clientName: 1, mode: 1, executionTime: 1 })
    .toArray();

  const planned = [];
  const invalid = [];

  for (const doc of candidates) {
    const value = String(doc.executionTime).trim();

    if (!value) {
      planned.push({ doc, next: [] });
      continue;
    }

    if (!EXECUTION_TIME_PATTERN.test(value)) {
      invalid.push({ doc, value });
      continue;
    }

    planned.push({ doc, next: [value] });
  }

  console.log(`[${dbName}] ${COLLECTION}: ${candidates.length} document(s) with a string executionTime`);

  for (const { doc, next } of planned) {
    console.log(`  ${doc._id} ${doc.clientName || '(no name)'} [${doc.mode}] ${JSON.stringify(doc.executionTime)} -> ${JSON.stringify(next)}`);
  }

  for (const { doc, value } of invalid) {
    console.warn(`  SKIPPED ${doc._id} ${doc.clientName || '(no name)'}: ${JSON.stringify(value)} is not HH:mm`);
  }

  if (!apply) {
    console.log(`[${dbName}] dry run: nothing written. Re-run with --apply to write.`);
  } else {
    let updated = 0;

    for (const { doc, next } of planned) {
      const result = await collection.updateOne({ _id: doc._id }, { $set: { executionTime: next } });
      updated += result.modifiedCount;
    }

    console.log(`[${dbName}] applied: ${updated} document(s) updated, ${invalid.length} skipped as invalid.`);
  }
} finally {
  await client.close();
}
