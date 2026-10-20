import ClientTickets from '../../../../src/application/use-cases/panel/ClientTickets.js';
import {
  FakeAttachmentStore,
  FakeContextReader,
  InMemoryTicketRepository,
  JPEG,
  PNG,
  SVG,
  image,
  steppingClock,
} from './ticketFakes.js';

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const EVENT_ID = '6711a0b1c2d3e4f501234567';
const SYNC_ID = '6711d0e1f2a3b4c501234567';

const ana = { id: 'u-ana', name: 'Ana Mora', role: 'admin', accountType: 'cliente', tenantKey: ACME };
const otro = { id: 'u-otro', name: 'Otro', role: 'usuario', accountType: 'cliente', tenantKey: INITECH };

function build({ contextReader = new FakeContextReader() } = {}) {
  const ticketRepository = new InMemoryTicketRepository();
  const attachmentStore = new FakeAttachmentStore();
  const useCase = new ClientTickets({
    ticketRepository,
    attachmentStore,
    contextReader,
    tenantDbPrefix: 'sap_integration',
    now: steppingClock(),
  });
  return { useCase, ticketRepository, attachmentStore };
}

const validFields = { title: 'La cotización no llegó', description: 'Detalle', category: 'documentos' };

async function createTicket(ctx, user = ana, extra = {}) {
  const result = await ctx.useCase.create({ user, fields: { ...validFields, ...extra.fields }, images: extra.images ?? [] });
  expect(result.ok).toBe(true);
  return result.data;
}

function deepKeys(value, keys = new Set()) {
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      deepKeys(nested, keys);
    }
  }
  return keys;
}

describe('ClientTickets.create', () => {
  it('creates an open ticket with code, history and the images of the opening', async () => {
    const ctx = build();

    const result = await ctx.useCase.create({ user: ana, fields: validFields, images: [image(PNG), image(JPEG, 'b.jpg')] });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(201);
    const ticket = result.data;
    expect(ticket).toEqual(expect.objectContaining({
      code: 'ACME-0001',
      status: 'abierto',
      category: 'documentos',
      createdBy: { name: 'Ana Mora', role: 'admin' },
      reopenCount: 0,
      hasNews: false,
      contextType: null,
      context: null,
      firstResponseAt: null,
      messages: [],
    }));
    expect(ticket.statusHistory).toEqual([
      { from: null, to: 'abierto', byType: 'cliente', byName: 'Ana Mora', at: ticket.openedAt },
    ]);
    expect(ticket.attachments.map(({ contentType }) => contentType)).toEqual(['image/png', 'image/jpeg']);
    for (const { fileId } of ticket.attachments) {
      expect(ctx.attachmentStore.files.get(fileId)).toEqual(expect.objectContaining({ tenantKey: ACME, ticketId: ticket.id }));
    }
    expect(deepKeys(ticket).has('internalResolution')).toBe(false);
  });

  it('numbers tickets per tenant', async () => {
    const ctx = build();
    await createTicket(ctx);
    const second = await createTicket(ctx);
    const other = await createTicket(ctx, otro);

    expect(second.code).toBe('ACME-0002');
    expect(other.code).toBe('INITECH-0001');
  });

  it.each([
    [{ title: '' }, 'El título es obligatorio.'],
    [{ title: 'x'.repeat(151) }, 'El título supera los 150 caracteres.'],
    [{ description: '   ' }, 'La descripción es obligatorio.'],
    [{ description: 'x'.repeat(5001) }, 'La descripción supera los 5000 caracteres.'],
    [{ category: 'ventas' }, 'Elige una categoría.'],
    [{ contextType: 'webhookEvent' }, 'Contexto inválido.'],
    [{ contextId: EVENT_ID }, 'Contexto inválido.'],
    [{ contextType: 'logs', contextId: EVENT_ID }, 'Contexto inválido.'],
  ])('rejects %j with validation_error', async (patch, message) => {
    const ctx = build();

    const result = await ctx.useCase.create({ user: ana, fields: { ...validFields, ...patch } });

    expect(result).toEqual({ ok: false, reason: 'VALIDATION_ERROR', message });
    expect(ctx.ticketRepository.tickets(ACME)).toHaveLength(0);
  });

  it.each([
    ['six images', [1, 2, 3, 4, 5, 6].map(() => image()), 'TOO_MANY_IMAGES'],
    ['an image over 5 MB', [image(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))], 'IMAGE_TOO_LARGE'],
    ['an SVG renamed to .png', [image(SVG, 'x.png')], 'INVALID_IMAGE'],
    ['an empty file', [image(Buffer.alloc(0))], 'INVALID_IMAGE'],
  ])('rejects %s and stores nothing', async (_label, images, reason) => {
    const ctx = build();

    const result = await ctx.useCase.create({ user: ana, fields: validFields, images });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
    expect(ctx.attachmentStore.puts).toBe(0);
    expect(ctx.ticketRepository.tickets(ACME)).toHaveLength(0);
  });

  it('links an event of its tenant with a generic snapshot', async () => {
    const contextReader = new FakeContextReader({
      events: {
        [ACME]: {
          [EVENT_ID]: {
            _id: EVENT_ID,
            eventType: 'createQuotation',
            status: 'errored',
            retries: 3,
            maxRetries: 3,
            lastError: 'El artículo no existe.',
            payload: { deal: { hs_object_id: '987' } },
            createdAt: new Date('2026-10-10T14:00:00Z'),
            updatedAt: new Date('2026-10-10T14:06:00Z'),
          },
        },
      },
    });
    const ctx = build({ contextReader });

    const ticket = await createTicket(ctx, ana, { fields: { contextType: 'webhookEvent', contextId: EVENT_ID } });

    expect(ticket.contextType).toBe('webhookEvent');
    expect(ticket.context).toEqual({
      type: 'webhookEvent',
      refId: EVENT_ID,
      snapshot: expect.objectContaining({ type: 'createQuotation', status: 'errored', lastError: 'El artículo no existe.', reference: '987' }),
    });
    expect(ticket.context.snapshot).not.toHaveProperty('payload');
  });

  it('links a sync of its tenant', async () => {
    const contextReader = new FakeContextReader({
      syncs: { [ACME]: { [SYNC_ID]: { sync: { _id: SYNC_ID, objectType: 'Product', status: 'errored', failed: 3 }, task: null } } },
    });
    const ctx = build({ contextReader });

    const ticket = await createTicket(ctx, ana, { fields: { contextType: 'syncLog', contextId: SYNC_ID } });

    expect(ticket.context.snapshot).toEqual(expect.objectContaining({ id: SYNC_ID, objectType: 'product', status: 'errored' }));
  });

  it.each([
    ['an event of another tenant', 'webhookEvent', { events: { [INITECH]: { [EVENT_ID]: { _id: EVENT_ID, status: 'errored' } } } }],
    ['a quality report', 'webhookEvent', { events: { [ACME]: { [EVENT_ID]: { _id: EVENT_ID, status: 'report' } } } }],
    ['a missing sync', 'syncLog', {}],
  ])('answers not_found for %s', async (_label, contextType, records) => {
    const ctx = build({ contextReader: new FakeContextReader(records) });

    const result = await ctx.useCase.create({ user: ana, fields: { ...validFields, contextType, contextId: EVENT_ID } });

    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('removes uploaded images when saving the ticket fails', async () => {
    const ctx = build();
    ctx.ticketRepository.failNextCreate = true;

    await expect(ctx.useCase.create({ user: ana, fields: validFields, images: [image(), image()] })).rejects.toThrow('insert failed');
    expect(ctx.attachmentStore.removed).toHaveLength(2);
    expect(ctx.attachmentStore.files.size).toBe(0);
  });

  it('removes the first images when a later upload fails', async () => {
    const ctx = build();
    ctx.attachmentStore.failOnPutNumber = 2;

    await expect(ctx.useCase.create({ user: ana, fields: validFields, images: [image(), image()] })).rejects.toThrow('gridfs down');
    expect(ctx.attachmentStore.removed).toHaveLength(1);
    expect(ctx.ticketRepository.tickets(ACME)).toHaveLength(0);
  });
});

describe('ClientTickets.list', () => {
  it('lists only the tickets of the session tenant, newest activity first', async () => {
    const ctx = build();
    const first = await createTicket(ctx);
    const second = await createTicket(ctx, ana, { fields: { category: 'precios' } });
    await createTicket(ctx, otro);

    const result = await ctx.useCase.list({ user: ana, query: {} });

    expect(result.data).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: 2 }));
    expect(result.data.items.map((item) => item.id)).toEqual([second.id, first.id]);
    for (const item of result.data.items) {
      expect(item).not.toHaveProperty('messages');
      expect(item).not.toHaveProperty('internalResolution');
      expect(item).not.toHaveProperty('description');
    }
  });

  it('filters by status and category and paginates', async () => {
    const ctx = build();
    await createTicket(ctx);
    await createTicket(ctx, ana, { fields: { category: 'precios' } });

    const filtered = await ctx.useCase.list({ user: ana, query: { category: 'precios', status: 'abierto' } });
    const page2 = await ctx.useCase.list({ user: ana, query: { page: '2', pageSize: '1' } });

    expect(filtered.data.total).toBe(1);
    expect(page2.data.items).toHaveLength(1);
    expect(page2.data.total).toBe(2);
  });

  it.each([
    [{ status: 'cerrado' }],
    [{ status: ['abierto'] }],
    [{ category: 'ventas' }],
    [{ pageSize: '101' }],
    [{ page: '0' }],
  ])('rejects %j', async (query) => {
    const ctx = build();
    expect((await ctx.useCase.list({ user: ana, query })).reason).toBe('VALIDATION_ERROR');
  });
});

describe('ClientTickets.get', () => {
  it('answers not_found for a ticket of another tenant or a malformed id', async () => {
    const ctx = build();
    const foreign = await createTicket(ctx, otro);

    expect(await ctx.useCase.get({ user: ana, id: foreign.id })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(await ctx.useCase.get({ user: ana, id: 'xyz' })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('marks the client view and never returns the internal note', async () => {
    const ctx = build();
    const created = await createTicket(ctx);
    const stored = ctx.ticketRepository.tickets(ACME)[0];
    stored.internalResolution = { text: 'secreto', updatedAt: new Date(), updatedBy: { name: 'Dev' } };
    stored.lastPublicAuthorType = 'smarteam';
    stored.lastActivityAt = new Date('2026-10-12T10:00:30Z');
    stored.clientLastSeenAt = new Date('2026-10-12T10:00:00Z');
    const before = await ctx.useCase.list({ user: ana, query: {} });

    const result = await ctx.useCase.get({ user: ana, id: created.id });

    expect(before.data.items[0].hasNews).toBe(true);

    expect(result.ok).toBe(true);
    expect(result.data.hasNews).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('secreto');
    expect(deepKeys(result.data).has('internalResolution')).toBe(false);
    expect(stored.clientLastSeenAt).toBeInstanceOf(Date);
  });
});

describe('ClientTickets.reply', () => {
  it('moves esperando_cliente to en_progreso and records the message', async () => {
    const ctx = build();
    const created = await createTicket(ctx);
    ctx.ticketRepository.tickets(ACME)[0].status = 'esperando_cliente';

    const result = await ctx.useCase.reply({ user: ana, id: created.id, fields: { body: ' Aquí va ' }, images: [image()] });

    expect(result.statusCode).toBe(201);
    expect(result.data.status).toBe('en_progreso');
    expect(result.data.messages).toEqual([
      expect.objectContaining({ authorType: 'cliente', authorName: 'Ana Mora', body: 'Aquí va' }),
    ]);
    expect(result.data.messages[0].attachments).toHaveLength(1);
    expect(result.data.statusHistory.at(-1)).toEqual(expect.objectContaining({ from: 'esperando_cliente', to: 'en_progreso', byType: 'cliente' }));
  });

  it('keeps an open ticket open', async () => {
    const ctx = build();
    const created = await createTicket(ctx);

    const result = await ctx.useCase.reply({ user: ana, id: created.id, fields: { body: 'más datos' } });

    expect(result.data.status).toBe('abierto');
    expect(result.data.statusHistory).toHaveLength(1);
  });

  it('answers invalid_transition on a resolved ticket before reading the body', async () => {
    const ctx = build();
    const created = await createTicket(ctx);
    ctx.ticketRepository.tickets(ACME)[0].status = 'resuelto';

    const result = await ctx.useCase.reply({ user: ana, id: created.id, fields: {}, images: [image()] });

    expect(result).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
    expect(ctx.attachmentStore.puts).toBe(0);
  });

  it('requires a body', async () => {
    const ctx = build();
    const created = await createTicket(ctx);

    expect((await ctx.useCase.reply({ user: ana, id: created.id, fields: { body: '' } })).message).toBe('El mensaje es obligatorio.');
  });

  it('cleans up the images when the status changed in the meantime', async () => {
    const ctx = build();
    const created = await createTicket(ctx);
    ctx.ticketRepository.conflictNextUpdate = true;

    const result = await ctx.useCase.reply({ user: ana, id: created.id, fields: { body: 'hola' }, images: [image()] });

    expect(result).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
    expect(ctx.attachmentStore.removed).toHaveLength(1);
  });

  it('cannot reply to a ticket of another tenant', async () => {
    const ctx = build();
    const foreign = await createTicket(ctx, otro);

    expect(await ctx.useCase.reply({ user: ana, id: foreign.id, fields: { body: 'x' } })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('ClientTickets.reopen', () => {
  it('reopens a resolved ticket to abierto, counts it and keeps the message', async () => {
    const ctx = build();
    const created = await createTicket(ctx);
    ctx.ticketRepository.tickets(ACME)[0].status = 'resuelto';

    const result = await ctx.useCase.reopen({ user: ana, id: created.id, message: 'Sigue fallando' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ status: 'abierto', reopenCount: 1 }));
    expect(result.data.messages.at(-1).body).toBe('Sigue fallando');
    expect(result.data.statusHistory.at(-1)).toEqual(expect.objectContaining({ from: 'resuelto', to: 'abierto' }));
  });

  it('answers invalid_transition when the ticket is not resolved', async () => {
    const ctx = build();
    const created = await createTicket(ctx);

    expect(await ctx.useCase.reopen({ user: ana, id: created.id, message: 'x' })).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
  });

  it('requires a message', async () => {
    const ctx = build();
    const created = await createTicket(ctx);
    ctx.ticketRepository.tickets(ACME)[0].status = 'resuelto';

    expect((await ctx.useCase.reopen({ user: ana, id: created.id, message: ' ' })).reason).toBe('VALIDATION_ERROR');
  });
});

describe('ClientTickets.attachment', () => {
  it('serves a file of the ticket and nothing else', async () => {
    const ctx = build();
    const first = await createTicket(ctx, ana, { images: [image()] });
    const second = await createTicket(ctx, ana, { images: [image()] });
    const fileId = first.attachments[0].fileId;

    const own = await ctx.useCase.attachment({ user: ana, id: first.id, fileId });
    const crossed = await ctx.useCase.attachment({ user: ana, id: second.id, fileId });
    const foreign = await ctx.useCase.attachment({ user: otro, id: first.id, fileId });

    expect(own).toEqual({ ok: true, data: expect.objectContaining({ contentType: 'image/png' }) });
    expect(crossed).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(foreign).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('ClientTickets — legacy snapshots (security review)', () => {
  it('re-sanitizes a raw snapshot stored before plan 5', async () => {
    const ctx = build();
    const created = await createTicket(ctx);
    ctx.ticketRepository.tickets(ACME)[0].context = {
      type: 'syncLog',
      refId: SYNC_ID,
      snapshot: { id: SYNC_ID, errorMessage: [{ payload_SAP: { CardCode: 'C1' } }], errors: [{ x: 1 }] },
    };
    ctx.ticketRepository.tickets(ACME).push({
      ...structuredClone(ctx.ticketRepository.tickets(ACME)[0]),
      id: '0000000000000000000000ee',
      context: { type: 'webhookEvent', refId: EVENT_ID, snapshot: { lastError: 'connect ETIMEDOUT 18.213.238.80:443', sapAudit: { a: 1 } } },
    });

    const sync = await ctx.useCase.get({ user: ana, id: created.id });
    const event = await ctx.useCase.get({ user: ana, id: '0000000000000000000000ee' });

    expect(sync.data.context.snapshot).toEqual({ id: SYNC_ID, errorMessage: { summary: '1 error(es) en la corrida' } });
    expect(event.data.context.snapshot).toEqual({ lastError: 'Tiempo de espera agotado.' });
  });
});
