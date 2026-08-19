// scripts/migrate-webhook-event-dedup-active.mjs
//
// Migración por tenant que habilita el reenvío de webhooks tras un fallo definitivo.
// Hace cuatro cosas, en este orden y no en otro:
//
//   1. Verifica que no exista YA más de un evento no-errored por (eventType, dealId). No
//      debería haberlo, porque el dedup de aplicación bloqueaba cualquier segundo evento,
//      pero un índice único que se crea sobre datos que lo violan falla; mejor reportarlo.
//   2. Backfillea `dedupActive` en los cuatro tipos deduplicados: true si el estado NO es
//      `errored`, false si lo es.
//   3. Crea el índice único parcial nuevo.
//   4. Tumba el índice viejo, que solo cubría createDeal.
//
// El orden importa. Si el índice nuevo se crea antes del backfill, los documentos sin el campo
// quedan fuera del filtro parcial y no hay protección. Si el viejo se tumba antes de que el
// nuevo exista, hay una ventana sin NINGUNA garantía dura sobre createDeal -- y ese flujo no
// escribe SapDocumentLink, así que el índice es su única red contra una orden duplicada en SAP.
// Los pasos 3 y 4 pueden ir en ese orden porque la llave del índice nuevo incluye `dedupActive`
// y es por lo tanto un patrón distinto al del viejo: MongoDB no acepta dos índices con la misma
// llave que difieran solo en el partialFilterExpression.
//
// Es idempotente: se puede correr de nuevo sin efecto.
//
// El nombre de la base es `${TENANT_DB_PREFIX|sap_integration}_${tenantKey}` (ver
// buildTenantDatabaseName en src/infrastructure/database/tenant/tenantDatabase.js).
//
// Uso, un tenant a la vez:
//   node --env-file=.env scripts/migrate-webhook-event-dedup-active.mjs <tenantDbName> [--apply]
//
// Dry run por defecto: sin --apply no se escribe nada.
import { MongoClient } from 'mongodb';
// Importados, NO copiados: la lista de tipos vive en un solo lugar. Se puede importar sin
// arrastrar nada porque webhookEvent.service.js no tiene imports propios; el script sigue sin
// depender del resto del grafo de módulos de src/.
import {
  DEDUPLICATED_EVENT_TYPES as DEDUPLICATED_EVENT_TYPE_SET,
  RESENDABLE_STATUS,
} from '../src/infrastructure/webhook/webhookEvent.service.js';

// updateQuotation no está en el Set: no participa del dedup, así que sus documentos nunca
// llevan `dedupActive` y quedan fuera del índice.
const DEDUPLICATED_EVENT_TYPES = [...DEDUPLICATED_EVENT_TYPE_SET];

const OLD_INDEX_NAME = 'eventType_1_payload.deal.hs_object_id_1';
const NEW_INDEX_NAME = 'eventType_1_payload.deal.hs_object_id_1_dedupActive_1';

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/migrate-webhook-event-dedup-active.mjs <tenantDbName> [--apply]');
  process.exit(1);
}

if (!tenantDb) {
  usage('Missing tenant database name.');
}

// Sin default a localhost: apuntar en silencio a un Mongo local vacío haría que un --apply
// reporte un tranquilizador "0 documentos" mientras el tenant real queda sin migrar.
if (!uri) {
  usage('MONGODB_URI is not set. Export it or run with `node --env-file=.env`.');
}

const client = new MongoClient(uri);
await client.connect();

// Envuelta en una funcion async para que el camino de colisiones salga con `return` en vez de
// `process.exit` desde dentro del `try`: `process.exit` termina el proceso antes de desenrollar
// la pila, asi que el `finally` de abajo -- el que cierra la conexion a Mongo -- nunca llega a
// correr. `return` si atraviesa el `finally`. El codigo de salida se fija por separado con
// `process.exitCode`, que Node aplica al terminar normalmente sin matar el proceso a la fuerza.
async function migrate() {
  try {
    const events = client.db(tenantDb).collection('WebhookEvents');

    // --- Paso 1: colisiones ---
    const collisions = await events.aggregate([
      {
        $match: {
          eventType: { $in: DEDUPLICATED_EVENT_TYPES },
          status: { $ne: RESENDABLE_STATUS },
          'payload.deal.hs_object_id': { $exists: true },
        },
      },
      { $group: { _id: { eventType: '$eventType', dealId: '$payload.deal.hs_object_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    if (collisions.length > 0) {
      console.error(`${tenantDb}: ${collisions.length} colision(es) impiden crear el indice unico.`);
      for (const collision of collisions) {
        console.error(`  ${collision._id.eventType} / deal ${collision._id.dealId}: ${collision.count} eventos abiertos`);
      }
      console.error('Resolver a mano cual evento queda abierto antes de reintentar.');
      process.exitCode = 1;
      return;
    }

    console.log(`${tenantDb}: sin colisiones.`);

    // --- Paso 2: backfill ---
    const openFilter = {
      eventType: { $in: DEDUPLICATED_EVENT_TYPES },
      'payload.deal.hs_object_id': { $exists: true },
      status: { $ne: RESENDABLE_STATUS },
    };
    const erroredFilter = {
      eventType: { $in: DEDUPLICATED_EVENT_TYPES },
      'payload.deal.hs_object_id': { $exists: true },
      status: RESENDABLE_STATUS,
    };

    const openCount = await events.countDocuments(openFilter);
    const erroredCount = await events.countDocuments(erroredFilter);
    console.log(`${tenantDb}: ${openCount} evento(s) abierto(s) -> dedupActive true, ${erroredCount} errored -> false`);

    const indexes = await events.indexes();
    const hasOld = indexes.some((index) => index.name === OLD_INDEX_NAME);
    const hasNew = indexes.some((index) => index.name === NEW_INDEX_NAME);
    console.log(`${tenantDb}: indice viejo ${hasOld ? 'presente' : 'ausente'}, indice nuevo ${hasNew ? 'presente' : 'ausente'}`);

    if (!apply) {
      console.log('Dry run. Re-run with --apply to write.');
    } else {
      await events.updateMany(openFilter, { $set: { dedupActive: true } });
      await events.updateMany(erroredFilter, { $set: { dedupActive: false } });
      console.log('Backfill listo.');

      // --- Paso 3: indice nuevo ---
      if (!hasNew) {
        await events.createIndex(
          { eventType: 1, 'payload.deal.hs_object_id': 1, dedupActive: 1 },
          {
            name: NEW_INDEX_NAME,
            unique: true,
            partialFilterExpression: {
              dedupActive: true,
              'payload.deal.hs_object_id': { $exists: true },
            },
          }
        );
        console.log(`Indice ${NEW_INDEX_NAME} creado.`);
      }

      // --- Paso 4: indice viejo ---
      if (hasOld) {
        await events.dropIndex(OLD_INDEX_NAME);
        console.log(`Indice ${OLD_INDEX_NAME} eliminado.`);
      }
    }
  } finally {
    await client.close();
  }
}

await migrate();
