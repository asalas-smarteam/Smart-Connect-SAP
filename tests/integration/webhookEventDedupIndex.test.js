import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createWebhookEventModel } from '#infrastructure/database/models/tenant/WebhookEvent.js';
import {
  queueWebhookEvent,
  CREATE_DEAL_EVENT_TYPE,
} from '#infrastructure/webhook/webhookEvent.service.js';
import MongooseWebhookEventRepository from '#infrastructure/repositories/MongooseWebhookEventRepository.js';

// Nombre que scripts/migrate-webhook-event-dedup-active.mjs hardcodea como NEW_INDEX_NAME.
// No se importa del script porque el script tiene código de nivel superior que conecta a Mongo
// con MONGODB_URI y llama a process.exit si faltan argumentos -- importar el módulo lo
// ejecutaría. Se copia el literal a mano; si el script lo cambia sin que este test lo note,
// la migración quedaría comparando contra un nombre viejo, así que hay que mantenerlos
// sincronizados manualmente (confirmado leyendo el script).
const MIGRATION_NEW_INDEX_NAME = 'eventType_1_payload.deal.hs_object_id_1_dedupActive_1';

// El índice que existía ANTES de esta migración: único sobre (eventType, dealId) sin
// distinguir status, y limitado a createDeal. Se recrea a mano porque un tenant al que no se
// le corrió la migración lo conserva tal cual.
const LEGACY_INDEX_NAME = 'eventType_1_payload.deal.hs_object_id_1';

// El índice es la única garantía DURA de que no entren dos eventos abiertos para el mismo
// deal. Importa acá y no en un unit test porque la restricción la aplica el servidor: con
// un modelo mockeado, `create` siempre "funciona" y el agujero no se ve.
let mongoServer;
let connection;
let WebhookEvent;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(mongoServer.getUri(), { dbName: 'dedup-index-test' })
    .asPromise();
  WebhookEvent = createWebhookEventModel(connection);
  // Espera a que Mongoose termine de construir los índices declarados en el schema.
  await WebhookEvent.init();
}, 60000);

afterAll(async () => {
  await connection?.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await WebhookEvent.deleteMany({});
});

function buildEvent(overrides = {}) {
  return {
    eventType: 'createQuotation',
    payload: { deal: { hs_object_id: 'deal-1' } },
    status: 'waiting',
    retries: 0,
    maxRetries: 3,
    lastError: null,
    dedupActive: true,
    ...overrides,
  };
}

describe('índice único parcial de dedup en WebhookEvents', () => {
  it('rechaza un segundo evento no-errored para el mismo eventType y deal', async () => {
    await WebhookEvent.create(buildEvent());

    await expect(WebhookEvent.create(buildEvent())).rejects.toMatchObject({ code: 11000 });
  });

  it('acepta varios eventos errored para el mismo eventType y deal', async () => {
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));

    await expect(WebhookEvent.countDocuments({ status: 'errored' })).resolves.toBe(3);
  });

  it('acepta un evento nuevo abierto cuando el anterior quedó errored', async () => {
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));

    await expect(WebhookEvent.create(buildEvent())).resolves.toMatchObject({ status: 'waiting' });
  });

  // updateQuotation nunca lleva el campo, así que sus documentos no entran al índice: una
  // cotización se actualiza muchas veces y cada envío es legítimo.
  it('no limita los eventos de updateQuotation, que no llevan dedupActive', async () => {
    const base = { eventType: 'updateQuotation', dedupActive: undefined };
    await WebhookEvent.create(buildEvent(base));
    await WebhookEvent.create(buildEvent(base));

    await expect(WebhookEvent.countDocuments({ eventType: 'updateQuotation' })).resolves.toBe(2);
  });

  // Los reportes de calidad de datos viven en esta misma colección y no tienen deal. Sin la
  // cláusula $exists del filtro parcial, todos colisionarían entre sí en (eventType, null).
  it('no limita documentos sin deal, aunque tengan dedupActive en true', async () => {
    const report = {
      eventType: 'productQualityReport',
      payload: { rows: [] },
      status: 'report',
      retries: 0,
      maxRetries: 0,
      lastError: null,
      dedupActive: true,
    };
    await WebhookEvent.create(report);
    await WebhookEvent.create(report);

    await expect(WebhookEvent.countDocuments({ status: 'report' })).resolves.toBe(2);
  });

  it('sigue permitiendo el mismo deal en tipos de evento distintos', async () => {
    await WebhookEvent.create(buildEvent({ eventType: 'createQuotation' }));
    await WebhookEvent.create(buildEvent({ eventType: 'inventoryTransferRequest' }));

    await expect(WebhookEvent.countDocuments({})).resolves.toBe(2);
  });

  it('el nombre del índice nuevo coincide con el que la migración de tenant espera encontrar', async () => {
    // Si alguien renombrara los campos de la llave en el schema sin actualizar el script de
    // migración (o viceversa), Mongoose generaría un nombre distinto del NEW_INDEX_NAME
    // hardcodeado en scripts/migrate-webhook-event-dedup-active.mjs. La migración seguiría
    // corriendo -- crearía un índice de más con el nombre que ella espera y nunca tumbaría el
    // que Mongoose realmente construyó -- así que la única forma de detectarlo es comparar el
    // nombre real contra el literal, no solo confiar en que el índice "existe".
    const indexes = await WebhookEvent.collection.indexes();
    const names = indexes.map((index) => index.name);

    expect(names).toContain(MIGRATION_NEW_INDEX_NAME);
  });
});

// Prueba de punta a punta de la costura entre `queueWebhookEvent`/`markFailed`, que ESCRIBEN
// dedupActive, y el índice único parcial, que lo LEE. A diferencia del describe de arriba, acá
// no se construye ningún documento a mano: si alguien renombrara el campo en el schema sin
// tocar el servicio, o el servicio escribiera el string 'true' en vez del booleano, el índice
// dejaría de filtrar lo que el servicio cree que está escribiendo y estos tests se pondrían
// rojos -- que es justo el agujero que un doble inyectado (fixture a mano o modelo mockeado)
// no puede ver.
describe('costura real entre queueWebhookEvent/markFailed y el índice de dedup', () => {
  it('permite reencolar el mismo (eventType, dealId) después de que el intento anterior se marcó errored', async () => {
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const payload = { deal: { hs_object_id: 'deal-resend-ok' } };

    const first = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });
    expect(first.duplicated).toBe(false);

    await repository.markFailed(
      { _id: first.eventId, eventType: CREATE_DEAL_EVENT_TYPE },
      { status: 'errored', retries: 3, lastError: 'SAP timeout' }
    );

    const second = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });

    expect(second.duplicated).toBe(false);
  });

  it('bloquea un segundo encolado para el mismo (eventType, dealId) si el primero nunca se marcó errored', async () => {
    const payload = { deal: { hs_object_id: 'deal-resend-blocked' } };

    const first = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });
    expect(first.duplicated).toBe(false);

    const second = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });

    expect(second.duplicated).toBe(true);
    expect(second.eventId).toEqual(first.eventId);
  });

  // El par de arriba llama a queueWebhookEvent en secuencia, así que el que corta el segundo
  // intento es el chequeo de aplicación de findBlockingEvent (busca por `status`, nunca lee
  // dedupActive) -- el índice ni se llega a ejercitar, porque para cuando el segundo intento
  // corre, el primero ya está commiteado y findBlockingEvent lo ve. Si el servicio escribiera
  // 'true' en vez de true, o el campo se llamara distinto en el schema, ese par seguiría en
  // verde igual, tapando el agujero otra vez (confirmado: forzar ese mismo mutante hace que
  // dos llamadas por Promise.all sigan resolviendo 1 duplicado/1 no-duplicado, porque Node
  // serializa lo suficiente las dos consultas de findBlockingEvent como para que la primera ya
  // esté commiteada cuando corre la segunda -- una carrera real no es reproducible de forma
  // determinística contra mongodb-memory-server).
  //
  // La única forma determinística de forzar que sea el ÍNDICE -- y no el chequeo de
  // aplicación -- el que corte el segundo intento, es simular el resultado que produciría una
  // carrera real: la lectura de findBlockingEvent no ve el evento ya abierto (como si hubiera
  // llegado un instante antes del primer insert) y el segundo intento llega igual al create().
  // Se fuerza SOLO ese resultado de lectura, una vez; todo lo demás -- construir el documento,
  // escribir dedupActive, `WebhookEvent.create()`, el índice único real -- es código de
  // producción sin mockear. Si el índice no rechaza el create(), el catch de `queueWebhookEvent`
  // nunca se dispara y esta prueba se pone roja.
  it('si el chequeo de aplicación no llega a ver el evento abierto, el índice es la última barrera', async () => {
    const payload = { deal: { hs_object_id: 'deal-resend-race' } };

    const first = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });
    expect(first.duplicated).toBe(false);

    const findOneSpy = jest.spyOn(WebhookEvent, 'findOne').mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve(null) }),
    });

    let second;
    try {
      second = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });
    } finally {
      findOneSpy.mockRestore();
    }

    expect(second.duplicated).toBe(true);
    expect(second.eventId).toEqual(first.eventId);
    await expect(
      WebhookEvent.countDocuments({ 'payload.deal.hs_object_id': 'deal-resend-race' })
    ).resolves.toBe(1);
  });
});

// ACEPTADO A PROPÓSITO, no un bug a arreglar: documenta el límite de un tenant al que todavía
// no se le corrió scripts/migrate-webhook-event-dedup-active.mjs. Ese tenant conserva el
// índice viejo -- único sobre (eventType, dealId) SIN distinguir status, y limitado a
// createDeal -- que no sabe nada de `errored` ni de `dedupActive`. Un evento createDeal
// errored sigue ocupando el cupo, así que el reenvío se rechaza igual que antes de este
// cambio. La señal para el operador de que está pasando esto es, precisamente, que el tenant
// todavía tiene el índice viejo: la decisión de no loguear este caso distinto de un duplicado
// real fue deliberada, porque ambos desaparecen en cuanto se corre la migración.
describe('estado pre-migración: tenant que todavía conserva el índice viejo', () => {
  afterEach(async () => {
    // El índice viejo no lo declara el schema (Mongoose no lo vuelve a crear en `init()`), así
    // que si no se tumba a mano acá se filtra al resto de los tests del archivo.
    const indexes = await WebhookEvent.collection.indexes();
    if (indexes.some((index) => index.name === LEGACY_INDEX_NAME)) {
      await WebhookEvent.collection.dropIndex(LEGACY_INDEX_NAME);
    }
  });

  it('el índice viejo sigue rechazando el reenvío de un createDeal errored aunque el índice nuevo ya lo permitiría', async () => {
    await WebhookEvent.collection.createIndex(
      { eventType: 1, 'payload.deal.hs_object_id': 1 },
      {
        name: LEGACY_INDEX_NAME,
        unique: true,
        partialFilterExpression: {
          eventType: 'createDeal',
          'payload.deal.hs_object_id': { $exists: true },
        },
      }
    );

    const payload = { deal: { hs_object_id: 'deal-legacy-tenant' } };
    const first = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });
    expect(first.duplicated).toBe(false);

    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    await repository.markFailed(
      { _id: first.eventId, eventType: CREATE_DEAL_EVENT_TYPE },
      { status: 'errored', retries: 3, lastError: 'SAP timeout' }
    );

    const second = await queueWebhookEvent({ WebhookEvent, eventType: CREATE_DEAL_EVENT_TYPE, payload });

    expect(second.duplicated).toBe(true);
  });
});
