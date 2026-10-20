import { jest } from '@jest/globals';
import { PassThrough } from 'node:stream';
import mongoose from 'mongoose';
import MongooseTicketRepository from '../../../src/infrastructure/database/repositories/MongooseTicketRepository.js';
import GridFsTicketAttachmentStore from '../../../src/infrastructure/database/repositories/GridFsTicketAttachmentStore.js';
import TenantTicketContextReader from '../../../src/infrastructure/database/repositories/TenantTicketContextReader.js';
import { getPanelTenantModels } from '../../../src/infrastructure/database/repositories/panelTenantModels.js';
import { ticketSchema } from '../../../src/infrastructure/database/models/panel/Ticket.js';
import { ticketCounterSchema } from '../../../src/infrastructure/database/models/panel/TicketCounter.js';

const TENANT = 'sap_integration_acme';
const TICKET_ID = '6711b2c3d4e5f60123456789';
const FILE_ID = '6711c9aaaaaaaaaaaaaaaaaa';

function query(result) {
  const chain = {
    select: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lean: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

function ticketDocument(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(TICKET_ID),
    number: 7,
    code: 'ACME-0007',
    title: 'No llegó',
    description: 'Detalle',
    category: 'documentos',
    status: 'abierto',
    context: null,
    createdBy: { userId: 'u1', name: 'Ana', role: 'admin' },
    attachments: [{ fileId: new mongoose.Types.ObjectId(FILE_ID), filename: 'a.png', contentType: 'image/png', size: 3 }],
    messages: [],
    internalResolution: null,
    statusHistory: [{ from: null, to: 'abierto', byType: 'cliente', byId: 'u1', byName: 'Ana', at: new Date('2026-10-10T00:00:00Z') }],
    openedAt: new Date('2026-10-10T00:00:00Z'),
    firstResponseAt: null,
    resolvedAt: null,
    reopenCount: 0,
    lastActivityAt: new Date('2026-10-10T00:00:00Z'),
    lastPublicAuthorType: 'cliente',
    clientLastSeenAt: null,
    staffLastSeenAt: null,
    __v: 0,
    ...overrides,
  };
}

describe('panel ticket schemas', () => {
  it('never creates the collection or indexes on read', () => {
    expect(ticketSchema.get('autoIndex')).toBe(false);
    expect(ticketSchema.get('autoCreate')).toBe(false);
    expect(ticketSchema.get('collection')).toBe('Tickets');
    expect(ticketCounterSchema.get('autoCreate')).toBe(false);
    expect(ticketCounterSchema.get('collection')).toBe('TicketCounters');
  });

  it('declares the spec indexes', () => {
    const indexes = ticketSchema.indexes().map(([fields, options]) => [fields, options?.unique === true]);
    expect(indexes).toEqual(expect.arrayContaining([
      [{ number: 1 }, true],
      [{ status: 1, lastActivityAt: -1 }, false],
      [{ lastActivityAt: -1 }, false],
      [{ category: 1, lastActivityAt: -1 }, false],
    ]));
  });

  it('registers the panel models once per connection without the tenant registry', async () => {
    const models = {};
    const connection = {
      models,
      model: jest.fn((name) => {
        models[name] = { modelName: name };
        return models[name];
      }),
    };
    const getConnection = jest.fn().mockResolvedValue(connection);

    const first = await getPanelTenantModels(TENANT, { getConnection });
    const second = await getPanelTenantModels(TENANT, { getConnection });

    expect(getConnection).toHaveBeenCalledWith(TENANT);
    expect(connection.model).toHaveBeenCalledTimes(2);
    expect(first.Ticket).toBe(second.Ticket);
    expect(Object.keys(models).sort()).toEqual(['PanelTicket', 'PanelTicketCounter']);
  });
});

describe('MongooseTicketRepository', () => {
  function build(Ticket, TicketCounter = {}) {
    const getModels = jest.fn().mockResolvedValue({ Ticket, TicketCounter, connection: {} });
    return { repository: new MongooseTicketRepository({ getModels }), getModels };
  }

  it('returns null for malformed ids without opening the tenant', async () => {
    const { repository, getModels } = build({});
    expect(await repository.findById(TENANT, 'abc')).toBeNull();
    expect(await repository.findById(TENANT, { $ne: null })).toBeNull();
    expect(await repository.update(TENANT, '../x', { expectedStatus: 'abierto' })).toBeNull();
    await repository.markSeen(TENANT, 'abc', 'cliente', new Date());
    expect(getModels).not.toHaveBeenCalled();
  });

  it('maps documents to plain tickets with string ids', async () => {
    const Ticket = { findById: jest.fn(() => query(ticketDocument())) };
    const { repository } = build(Ticket);

    const ticket = await repository.findById(TENANT, TICKET_ID);

    expect(ticket.id).toBe(TICKET_ID);
    expect(ticket.attachments[0].fileId).toBe(FILE_ID);
    expect(ticket).not.toHaveProperty('_id');
    expect(ticket).not.toHaveProperty('__v');
  });

  it('creates indexes once, allocates the number atomically and builds the code', async () => {
    const created = ticketDocument();
    const Ticket = {
      createIndexes: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({ toObject: () => created }),
    };
    const TicketCounter = { findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'tickets', seq: 7 }) };
    const { repository } = build(Ticket, TicketCounter);
    const codeFor = jest.fn((number) => `ACME-000${number}`);

    await repository.create(TENANT, { id: TICKET_ID, title: 'x', messages: [] }, { codeFor });
    await repository.create(TENANT, { id: TICKET_ID, title: 'y', messages: [] }, { codeFor });

    expect(Ticket.createIndexes).toHaveBeenCalledTimes(1);
    expect(TicketCounter.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'tickets' },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, lean: true }
    );
    expect(Ticket.create).toHaveBeenCalledWith(expect.objectContaining({ _id: TICKET_ID, number: 7, code: 'ACME-0007' }));
  });

  it('lists with an exact-value filter, the list projection and lastActivityAt desc', async () => {
    const find = query([ticketDocument()]);
    const Ticket = { find: jest.fn(() => find), countDocuments: jest.fn().mockResolvedValue(1) };
    const { repository } = build(Ticket);

    const result = await repository.list(TENANT, { status: 'abierto', category: 'documentos', skip: 25, limit: 25 });

    expect(Ticket.find).toHaveBeenCalledWith({ status: 'abierto', category: 'documentos' });
    const projection = find.select.mock.calls[0][0];
    expect(projection).not.toHaveProperty('messages');
    expect(projection).not.toHaveProperty('internalResolution');
    expect(projection).not.toHaveProperty('context.snapshot');
    expect(find.sort).toHaveBeenCalledWith({ lastActivityAt: -1, _id: -1 });
    expect(find.skip).toHaveBeenCalledWith(25);
    expect(find.limit).toHaveBeenCalledWith(25);
    expect(result.total).toBe(1);
  });

  it('updates with the expected status as a compare-and-set guard', async () => {
    const Ticket = {
      findOneAndUpdate: jest.fn().mockResolvedValue(ticketDocument({ status: 'en_progreso' })),
      updateOne: jest.fn().mockResolvedValue({}),
      findById: jest.fn(() => query(ticketDocument({ status: 'en_progreso' }))),
    };
    const { repository } = build(Ticket);
    const at = new Date('2026-10-11T00:00:00Z');

    await repository.update(TENANT, TICKET_ID, {
      expectedStatus: 'abierto',
      set: { status: 'en_progreso', lastActivityAt: at },
      inc: { reopenCount: 1 },
      pushMessage: { id: 'm1', authorType: 'smarteam', body: 'hola', attachments: [], createdAt: at },
      pushHistory: [{ from: 'abierto', to: 'en_progreso', byType: 'smarteam', at }],
      setIfNull: { firstResponseAt: at },
    });

    const [filter, operations] = Ticket.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: TICKET_ID, status: 'abierto' });
    expect(operations.$set).toEqual({ status: 'en_progreso', lastActivityAt: at });
    expect(operations.$inc).toEqual({ reopenCount: 1 });
    expect(operations.$push.messages).toEqual(expect.objectContaining({ _id: 'm1', body: 'hola' }));
    expect(operations.$push.messages).not.toHaveProperty('id');
    expect(operations.$push.statusHistory.$each).toHaveLength(1);
    expect(Ticket.updateOne).toHaveBeenCalledWith({ _id: TICKET_ID, firstResponseAt: null }, { $set: { firstResponseAt: at } });
  });

  it('does not throw when only the setIfNull step fails after the update was saved', async () => {
    const saved = ticketDocument({ status: 'en_progreso' });
    const Ticket = {
      findOneAndUpdate: jest.fn().mockResolvedValue(saved),
      updateOne: jest.fn().mockRejectedValue(new Error('network')),
    };
    const { repository } = build(Ticket);

    const ticket = await repository.update(TENANT, TICKET_ID, {
      expectedStatus: 'abierto',
      set: { status: 'en_progreso' },
      setIfNull: { firstResponseAt: new Date() },
    });

    expect(ticket.status).toBe('en_progreso');
  });

  it('returns null when the status changed in the meantime', async () => {
    const Ticket = { findOneAndUpdate: jest.fn().mockResolvedValue(null) };
    const { repository } = build(Ticket);

    expect(await repository.update(TENANT, TICKET_ID, { expectedStatus: 'abierto', set: { status: 'resuelto' } })).toBeNull();
  });

  it('marks the view with $max on the side field only', async () => {
    const Ticket = { updateOne: jest.fn().mockResolvedValue({}) };
    const { repository } = build(Ticket);
    const at = new Date();

    await repository.markSeen(TENANT, TICKET_ID, 'smarteam', at);
    await repository.markSeen(TENANT, TICKET_ID, 'otro', at);

    expect(Ticket.updateOne).toHaveBeenCalledTimes(1);
    expect(Ticket.updateOne).toHaveBeenCalledWith({ _id: TICKET_ID }, { $max: { staffLastSeenAt: at } }, { timestamps: false });
  });

  it('counts by status', async () => {
    const Ticket = { aggregate: jest.fn().mockResolvedValue([{ _id: 'abierto', count: 2 }, { _id: 'resuelto', count: 5 }]) };
    const { repository } = build(Ticket);

    expect(await repository.countByStatus(TENANT)).toEqual({ abierto: 2, resuelto: 5 });
  });
});

describe('GridFsTicketAttachmentStore', () => {
  function fakeBucket({ files = [] } = {}) {
    const uploads = [];
    return {
      uploads,
      openUploadStream: jest.fn((filename, options) => {
        const stream = new PassThrough();
        stream.id = new mongoose.Types.ObjectId(FILE_ID);
        stream.resume();
        uploads.push({ filename, options });
        return stream;
      }),
      find: jest.fn(() => ({ limit: () => ({ toArray: async () => files }) })),
      openDownloadStream: jest.fn(() => new PassThrough()),
      delete: jest.fn().mockResolvedValue(undefined),
    };
  }

  function build(bucket) {
    const logger = { warn: jest.fn() };
    const store = new GridFsTicketAttachmentStore({
      getModels: jest.fn().mockResolvedValue({ connection: {} }),
      createBucket: () => bucket,
      logger,
    });
    return { store, logger };
  }

  it('stores the ticket id and the detected type in metadata', async () => {
    const bucket = fakeBucket();
    const { store } = build(bucket);

    const saved = await store.put(TENANT, { ticketId: TICKET_ID, filename: 'a.png', contentType: 'image/png', data: Buffer.from('abc') });

    expect(bucket.uploads[0]).toEqual({ filename: 'a.png', options: { metadata: { ticketId: TICKET_ID, contentType: 'image/png' } } });
    expect(saved).toEqual({ fileId: FILE_ID, filename: 'a.png', contentType: 'image/png', size: 3 });
  });

  it('aborts a failed upload so no chunks are left behind', async () => {
    const bucket = fakeBucket();
    const abort = jest.fn().mockResolvedValue(undefined);
    bucket.openUploadStream = jest.fn(() => {
      const stream = new PassThrough();
      stream.abort = abort;
      stream.end = () => stream.emit('error', new Error('write failed'));
      return stream;
    });
    const { store } = build(bucket);

    await expect(store.put(TENANT, { ticketId: TICKET_ID, filename: 'a.png', contentType: 'image/png', data: Buffer.from('a') }))
      .rejects.toThrow('write failed');
    expect(abort).toHaveBeenCalled();
  });

  it('opens only files of that ticket', async () => {
    const bucket = fakeBucket({ files: [{ length: 10, metadata: { contentType: 'image/webp' } }] });
    const { store } = build(bucket);

    const file = await store.open(TENANT, { ticketId: TICKET_ID, fileId: FILE_ID });

    expect(bucket.find).toHaveBeenCalledWith({ _id: new mongoose.Types.ObjectId(FILE_ID), 'metadata.ticketId': TICKET_ID });
    expect(file).toEqual(expect.objectContaining({ contentType: 'image/webp', size: 10 }));
    expect(await store.open(TENANT, { ticketId: TICKET_ID, fileId: 'nope' })).toBeNull();
  });

  it('returns null for a file of another ticket', async () => {
    const { store } = build(fakeBucket({ files: [] }));
    expect(await store.open(TENANT, { ticketId: TICKET_ID, fileId: FILE_ID })).toBeNull();
  });

  it('never throws while cleaning up', async () => {
    const bucket = fakeBucket();
    bucket.delete.mockRejectedValue(new Error('FileNotFound'));
    const { store, logger } = build(bucket);

    await expect(store.remove(TENANT, [FILE_ID, 'basura'])).resolves.toBeUndefined();
    expect(bucket.delete).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('TenantTicketContextReader', () => {
  it('reads the event through the operations reader without raw fields', async () => {
    const operationsReader = { findEvent: jest.fn().mockResolvedValue({ _id: 'e' }) };
    const reader = new TenantTicketContextReader({ operationsReader });

    expect(await reader.readEvent(TENANT, TICKET_ID)).toEqual({ _id: 'e' });
    expect(operationsReader.findEvent).toHaveBeenCalledWith(TENANT, TICKET_ID, { withRaw: false });
  });

  it('reads the sync without errors and its task', async () => {
    const operationsReader = {
      findSync: jest.fn().mockResolvedValue({ sync: { _id: 's', clientConfigId: 'c1' }, errorsTotal: 3 }),
      findTasks: jest.fn().mockResolvedValue([{ _id: 'c1', clientName: 'Productos' }]),
    };
    const reader = new TenantTicketContextReader({ operationsReader });

    const result = await reader.readSync(TENANT, TICKET_ID);

    expect(operationsReader.findSync).toHaveBeenCalledWith(TENANT, TICKET_ID, { errorsLimit: 0 });
    expect(operationsReader.findTasks).toHaveBeenCalledWith(TENANT, ['c1']);
    expect(result).toEqual({ sync: { _id: 's', clientConfigId: 'c1' }, task: { _id: 'c1', clientName: 'Productos' } });
  });

  it('returns null when the sync does not exist', async () => {
    const operationsReader = { findSync: jest.fn().mockResolvedValue(null), findTasks: jest.fn() };
    const reader = new TenantTicketContextReader({ operationsReader });

    expect(await reader.readSync(TENANT, TICKET_ID)).toBeNull();
    expect(operationsReader.findTasks).not.toHaveBeenCalled();
  });
});
