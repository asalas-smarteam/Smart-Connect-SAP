// scripts/migrate-s4-contact-internalcode.mjs
// One-off migration for S/4 tenants provisioned before the contactEmployee
// identity moved from idsap to internalcode. Run manually, one tenant at a
// time:  node scripts/migrate-s4-contact-internalcode.mjs <tenantDbName>
// Pass --apply to write; without it the script only reports what it would do.
import { MongoClient } from 'mongodb';

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';

if (!tenantDb) {
  console.error('Usage: node scripts/migrate-s4-contact-internalcode.mjs <tenantDbName> [--apply]');
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();

try {
  const mappings = client.db(tenantDb).collection('FieldMappings');
  const filter = {
    objectType: 'contact',
    sourceContext: 'contactEmployee',
    sourceField: 'BusinessPartner',
    targetField: 'idsap',
  };

  const affected = await mappings.find(filter).toArray();
  console.log(`${tenantDb}: ${affected.length} contactEmployee mapping(s) would change idsap -> internalcode`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write.');
  } else {
    const result = await mappings.updateMany(filter, { $set: { targetField: 'internalcode' } });
    console.log(`Updated ${result.modifiedCount} mapping(s).`);
  }
} finally {
  await client.close();
}
