import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createWebhookEventModel } from '#infrastructure/database/models/tenant/WebhookEvent.js';
import MongooseWebhookEventRepository from '#infrastructure/repositories/MongooseWebhookEventRepository.js';
import { buildWebhookSapAudit } from '#infrastructure/sync/syncLog.service.js';
import { createSapCallRecorder } from '#infrastructure/sap/sapCallRecorder.js';

// El bug que los mocks no podian ver: el sapAudit se construia bien, pero MongoDB rechazaba
// el $set entero por las claves `$select`/`$top`/`$filter` de los params de OData
// ("The dollar ($) prefixed field '$select' ... is not valid for storage"), y con el se
// perdian status y lastError. Se cobro dos eventos con la orden ya creada en SAP, colgados en
// 'sap_order_created'. Esta suite escribe contra un mongod real: es el unico lugar donde la
// validacion de claves del servidor participa de verdad.

let mongoServer;
let connection;
let WebhookEvent;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose.createConnection(mongoServer.getUri(), { dbName: 'audit-test' }).asPromise();
  WebhookEvent = createWebhookEventModel(connection);
}, 60000);

afterAll(async () => {
  await connection?.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await WebhookEvent.deleteMany({});
});

// Reproduce el trafico real de un createDeal: busqueda por EmailAddress (params de OData),
// POST del BusinessPartner rechazado por un stored procedure, y respuesta con anotaciones
// @odata.
async function recordRealisticTraffic() {
  const recorder = createSapCallRecorder();
  const adapter = recorder.wrap({
    request: async (_sapConfig, { method, path }) => {
      if (method === 'post' && path === '/BusinessPartners') {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: {
            status: 400,
            data: {
              error: {
                code: -2028,
                message: { lang: 'es-GT', value: '(1) SP - ERROR - el subgrupo NO es valido para este cliente.' },
              },
            },
          },
        });
      }
      return { '@odata.context': 'https://sap/$metadata#BusinessPartners', value: [] };
    },
  });

  await adapter.request({}, {
    method: 'get',
    path: '/BusinessPartners',
    params: { $top: 1, $select: 'CardCode,CardName', $filter: "EmailAddress eq 'danysec@gmail.com'" },
  });

  await adapter.request({}, {
    method: 'post',
    path: '/BusinessPartners',
    data: { CardCode: 'CDany', CardName: 'Dany Sec', GroupCode: 105 },
  }).catch(() => {});

  return recorder;
}

describe('sapAudit contra un MongoDB real', () => {
  it('markFailed guarda el audit completo, con el payload y el error de SAP', async () => {
    const event = await WebhookEvent.create({ eventType: 'createDeal', payload: { deal: {} } });
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const recorder = await recordRealisticTraffic();

    await repository.markFailed({ _id: event._id }, {
      status: 'waiting',
      retries: 1,
      lastError: '(1) SP - ERROR - el subgrupo NO es valido para este cliente.',
      sapAudit: buildWebhookSapAudit({
        payload_SAP: { businessPartner: null, order: null },
        response_SAP: { businessPartner: null, order: null },
        response_hubspot: null,
        sapCalls: recorder.calls,
      }),
    });

    const saved = await WebhookEvent.findById(event._id).lean();

    expect(saved.status).toBe('waiting');
    expect(saved.retries).toBe(1);
    expect(saved.sapAudit).not.toBeNull();

    const failedCall = saved.sapAudit.sapCalls.find((call) => call.ok === false);
    expect(failedCall.path).toBe('/BusinessPartners');
    expect(failedCall.request).toEqual({ CardCode: 'CDany', CardName: 'Dany Sec', GroupCode: 105 });
    expect(failedCall.error.message).toBe('(1) SP - ERROR - el subgrupo NO es valido para este cliente.');

    const searchCall = saved.sapAudit.sapCalls.find((call) => call.method === 'GET');
    expect(searchCall.params).toContain('$select=CardCode,CardName');
  });

  it('markCompleted guarda el audit y cierra el evento', async () => {
    const event = await WebhookEvent.create({ eventType: 'createDeal', payload: { deal: {} } });
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const recorder = await recordRealisticTraffic();

    await repository.markCompleted({ _id: event._id }, {
      docEntry: 565527,
      docNum: 11029481,
      cardCode: 'CLO031010',
      sapAudit: buildWebhookSapAudit({
        payload_SAP: { businessPartner: null, order: { CardCode: 'CLO031010' } },
        response_SAP: { businessPartner: null, order: { DocEntry: 565527 } },
        response_hubspot: { deal: { ok: true } },
        sapCalls: recorder.calls,
      }),
    });

    const saved = await WebhookEvent.findById(event._id).lean();

    expect(saved.status).toBe('completed');
    expect(saved.sapAudit.payloadSap.order).toEqual({ CardCode: 'CLO031010' });
    expect(saved.sapAudit.sapCalls).toHaveLength(2);
  });

  // La corrida de las 19:44 en produccion: 13 createQuotation completados con sapAudit null
  // porque las cotizaciones ya existian en SAP y los 13 tomaron el atajo de idempotencia
  // ("Quotation already exists for deal, skipping creation"). No se mando nada a SAP, asi que
  // no habia trafico que auditar -- pero el documento tiene que decirlo en vez de dejar un
  // null que se lee como auditoria rota.
  it('un evento saltado por idempotencia deja dicho que no se mando nada a SAP', async () => {
    const event = await WebhookEvent.create({ eventType: 'createQuotation', payload: { deal: {} } });
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });

    await repository.markCompleted({ _id: event._id }, {
      docEntry: 272710,
      docNum: 11023764,
      cardCode: 'CLO031010',
      sapAudit: buildWebhookSapAudit({
        payload_SAP: { businessPartner: null, quotation: null },
        response_SAP: { businessPartner: null, quotation: null },
        response_hubspot: null,
        sapCalls: [],
        skipped: {
          reason: 'quotation_already_exists',
          sapDocEntry: 272710,
          sapDocNum: 11023764,
        },
      }),
    });

    const saved = await WebhookEvent.findById(event._id).lean();

    expect(saved.status).toBe('completed');
    expect(saved.sapAudit.skipped.reason).toBe('quotation_already_exists');
    expect(saved.sapAudit.sapCalls).toEqual([]);
  });

  // Esta es LA garantia que faltaba. Ojo con lo que este mongod puede y no puede probar:
  // mongodb-memory-server corre MongoDB >= 5.0, que SI acepta claves con `$` prefijado, asi
  // que aca el $set con `$select` pasaria sin chistar -- el servidor del cliente es anterior y
  // por eso lo rechazo. Lo que si se verifica contra un servidor real, y es lo que garantiza
  // la compatibilidad: que lo persistido no lleva ninguna clave de las que un Mongo estricto
  // rechaza. El reintento sin audit (segundo cinturon) se cubre en
  // tests/unit/infrastructure/mongooseWebhookEventRepository.test.js, donde el rechazo se
  // puede simular.
  it('lo persistido no lleva ninguna clave que un Mongo estricto rechace', async () => {
    const event = await WebhookEvent.create({ eventType: 'createDeal', payload: { deal: {} } });
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const recorder = await recordRealisticTraffic();

    await repository.markFailed({ _id: event._id }, {
      status: 'waiting',
      retries: 1,
      lastError: 'SP - ERROR',
      sapAudit: buildWebhookSapAudit({
        payload_SAP: { businessPartner: { '$raro': 1, 'con.punto': 2 }, order: null },
        response_SAP: { businessPartner: null, order: null },
        response_hubspot: { deal: { '$hs': true } },
        sapCalls: recorder.calls,
      }),
    });

    const { sapAudit } = await WebhookEvent.findById(event._id).lean();
    const keys = [];
    const walk = (value) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          keys.push(key);
          walk(nested);
        }
      }
    };
    walk(sapAudit);

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => key.startsWith('$'))).toEqual([]);
    expect(keys.filter((key) => key.includes('.'))).toEqual([]);
  });
});
