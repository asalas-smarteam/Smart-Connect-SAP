import ClientTickets from '../../../../src/application/use-cases/panel/ClientTickets.js';
import StaffTickets from '../../../../src/application/use-cases/panel/StaffTickets.js';
import { FakeTenantDirectory, TENANTS } from './panelFakes.js';
import {
  FakeAttachmentStore,
  FakeContextReader,
  InMemoryTicketRepository,
  image,
  steppingClock,
} from './ticketFakes.js';

const ACME = 'sap_integration_acme';
const ana = { id: 'u-ana', name: 'Ana Mora', role: 'admin', accountType: 'cliente', tenantKey: ACME };
const dev = { id: 'u-dev', name: 'Dev Smarteam', accountType: 'smarteam', tenantKey: null };

function build() {
  const ticketRepository = new InMemoryTicketRepository();
  const attachmentStore = new FakeAttachmentStore();
  const now = steppingClock();
  const client = new ClientTickets({
    ticketRepository,
    attachmentStore,
    contextReader: new FakeContextReader(),
    tenantDbPrefix: 'sap_integration',
    now,
  });
  const staff = new StaffTickets({
    ticketRepository,
    attachmentStore,
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    now,
  });
  return { client, staff, ticketRepository, attachmentStore };
}

async function openTicket(ctx) {
  const result = await ctx.client.create({
    user: ana,
    fields: { title: 'No llegó', description: 'Detalle', category: 'documentos' },
  });
  return result.data;
}

function stored(ctx) {
  return ctx.ticketRepository.tickets(ACME)[0];
}

describe('StaffTickets — tenant validation', () => {
  it.each([
    ['an unknown tenant', 'sap_integration_fantasma'],
    ['a non-string tenant', { $ne: null }],
    ['an empty tenant', ''],
  ])('answers not_found for %s without touching any tenant database', async (_label, tenantKey) => {
    const ctx = build();
    const id = '0000000000000000000000ff';

    for (const call of [
      () => ctx.staff.get({ tenantKey, id }),
      () => ctx.staff.reply({ user: dev, tenantKey, id, fields: { body: 'x' } }),
      () => ctx.staff.setStatus({ user: dev, tenantKey, id, to: 'esperando_cliente' }),
      () => ctx.staff.resolve({ user: dev, tenantKey, id, fields: { message: 'a', internalResolution: 'b' } }),
      () => ctx.staff.setInternalResolution({ user: dev, tenantKey, id, text: 'x' }),
      () => ctx.staff.attachment({ tenantKey, id, fileId: id }),
    ]) {
      expect(await call()).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
    expect(ctx.ticketRepository.touchedTenants).toEqual([]);
  });

  it('answers not_found when the ticket is not in that tenant', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    expect(await ctx.staff.get({ tenantKey: 'sap_integration_initech', id: ticket.id })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('StaffTickets.get', () => {
  it('returns the staff detail with company and internal note and marks the staff view', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    stored(ctx).internalResolution = { text: 'Causa raíz', updatedAt: new Date('2026-10-12T11:00:00Z'), updatedBy: { userId: 'u-dev', name: 'Dev Smarteam' } };

    const result = await ctx.staff.get({ tenantKey: ACME, id: ticket.id });

    expect(result.data).toEqual(expect.objectContaining({
      tenantKey: ACME,
      companyName: 'Acme Industrial',
      hasNews: false,
      internalResolution: { text: 'Causa raíz', updatedAt: '2026-10-12T11:00:00.000Z', updatedBy: { name: 'Dev Smarteam' } },
    }));
    expect(stored(ctx).staffLastSeenAt).toBeInstanceOf(Date);
  });
});

describe('StaffTickets.reply', () => {
  it('first message on an open ticket moves it to en_progreso and sets firstResponseAt once', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const first = await ctx.staff.reply({ user: dev, tenantKey: ACME, id: ticket.id, fields: { body: 'Lo revisamos' }, images: [image()] });
    const second = await ctx.staff.reply({ user: dev, tenantKey: ACME, id: ticket.id, fields: { body: 'Otra cosa' } });

    expect(first.statusCode).toBe(201);
    expect(first.data.status).toBe('en_progreso');
    expect(first.data.firstResponseAt).not.toBeNull();
    expect(second.data.firstResponseAt).toBe(first.data.firstResponseAt);
    expect(second.data.statusHistory.map(({ to }) => to)).toEqual(['abierto', 'en_progreso']);
    expect(second.data.messages.map(({ authorType }) => authorType)).toEqual(['smarteam', 'smarteam']);
  });

  it('keeps esperando_cliente when Smarteam writes again', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    stored(ctx).status = 'esperando_cliente';

    const result = await ctx.staff.reply({ user: dev, tenantKey: ACME, id: ticket.id, fields: { body: 'Recordatorio' } });

    expect(result.data.status).toBe('esperando_cliente');
  });

  it('answers invalid_transition on a resolved ticket', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    stored(ctx).status = 'resuelto';

    expect(await ctx.staff.reply({ user: dev, tenantKey: ACME, id: ticket.id, fields: { body: 'x' } })).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
  });

  it('marks news for the client and not for Smarteam', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    await ctx.staff.reply({ user: dev, tenantKey: ACME, id: ticket.id, fields: { body: 'Hola' } });
    const list = await ctx.client.list({ user: ana, query: {} });

    expect(list.data.items[0].hasNews).toBe(true);
  });
});

describe('StaffTickets.setStatus', () => {
  it.each([
    ['abierto', 'en_progreso', true],
    ['en_progreso', 'esperando_cliente', true],
    ['resuelto', 'en_progreso', true],
    ['abierto', 'esperando_cliente', false],
    ['abierto', 'resuelto', false],
    ['esperando_cliente', 'en_progreso', false],
    ['en_progreso', 'resuelto', false],
    ['en_progreso', 'cerrado', false],
  ])('%s → %s allowed: %s', async (from, to, allowed) => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    stored(ctx).status = from;

    const result = await ctx.staff.setStatus({ user: dev, tenantKey: ACME, id: ticket.id, to });

    if (allowed) {
      expect(result.data.status).toBe(to);
      expect(result.data.statusHistory.at(-1)).toEqual(expect.objectContaining({ from, to, byType: 'smarteam', byName: 'Dev Smarteam' }));
    } else {
      expect(result).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
    }
  });

  it('taking an open ticket to en_progreso does not set firstResponseAt', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const result = await ctx.staff.setStatus({ user: dev, tenantKey: ACME, id: ticket.id, to: 'en_progreso' });

    expect(result.data.status).toBe('en_progreso');
    expect(result.data.firstResponseAt).toBeNull();
    expect(stored(ctx).firstResponseAt ?? null).toBeNull();
  });
});

describe('StaffTickets.resolve', () => {
  it('requires the message to the client and the internal resolution', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const noMessage = await ctx.staff.resolve({ user: dev, tenantKey: ACME, id: ticket.id, fields: { internalResolution: 'x' } });
    const noInternal = await ctx.staff.resolve({ user: dev, tenantKey: ACME, id: ticket.id, fields: { message: 'x' } });

    expect(noMessage.message).toBe('El mensaje al cliente es obligatorio.');
    expect(noInternal.message).toBe('La resolución interna es obligatorio.');
  });

  it.each(['abierto', 'en_progreso', 'esperando_cliente'])('resolves from %s', async (from) => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    stored(ctx).status = from;

    const result = await ctx.staff.resolve({
      user: dev,
      tenantKey: ACME,
      id: ticket.id,
      fields: { message: 'Corregimos el mapeo', internalResolution: 'FieldMapping corregido' },
      images: [image()],
    });

    expect(result.data).toEqual(expect.objectContaining({ status: 'resuelto' }));
    expect(result.data.resolvedAt).not.toBeNull();
    expect(result.data.firstResponseAt).not.toBeNull();
    expect(result.data.internalResolution).toEqual(expect.objectContaining({ text: 'FieldMapping corregido', updatedBy: { name: 'Dev Smarteam' } }));
    expect(result.data.messages.at(-1)).toEqual(expect.objectContaining({ body: 'Corregimos el mapeo', authorType: 'smarteam' }));
  });

  it('answers invalid_transition for an already resolved ticket', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    stored(ctx).status = 'resuelto';

    expect(await ctx.staff.resolve({ user: dev, tenantKey: ACME, id: ticket.id, fields: { message: 'a', internalResolution: 'b' } }))
      .toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
  });
});

describe('StaffTickets.setInternalResolution', () => {
  it('updates the note in any status and validates the text', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const result = await ctx.staff.setInternalResolution({ user: dev, tenantKey: ACME, id: ticket.id, text: 'Nota' });
    const empty = await ctx.staff.setInternalResolution({ user: dev, tenantKey: ACME, id: ticket.id, text: '' });

    expect(result.data.internalResolution.text).toBe('Nota');
    expect(result.data.status).toBe('abierto');
    expect(empty.reason).toBe('VALIDATION_ERROR');
  });

  it('retries once when the status changed in the meantime', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    ctx.ticketRepository.conflictNextUpdate = true;

    const result = await ctx.staff.setInternalResolution({ user: dev, tenantKey: ACME, id: ticket.id, text: 'Nota' });

    expect(result.ok).toBe(true);
  });
});

describe('full support flow', () => {
  it('client opens, Smarteam asks, client answers, Smarteam resolves, client reopens', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    const tenantKey = ACME;
    const { id } = ticket;

    await ctx.staff.reply({ user: dev, tenantKey, id, fields: { body: '¿Qué lista de precios?' } });
    await ctx.staff.setStatus({ user: dev, tenantKey, id, to: 'esperando_cliente' });
    await ctx.client.reply({ user: ana, id, fields: { body: 'La base' } });
    await ctx.staff.resolve({ user: dev, tenantKey, id, fields: { message: 'Listo', internalResolution: 'Causa' } });
    const reopened = await ctx.client.reopen({ user: ana, id, message: 'Sigue fallando' });

    expect(reopened.data.statusHistory.map(({ from, to }) => `${from}->${to}`)).toEqual([
      'null->abierto',
      'abierto->en_progreso',
      'en_progreso->esperando_cliente',
      'esperando_cliente->en_progreso',
      'en_progreso->resuelto',
      'resuelto->abierto',
    ]);
    expect(reopened.data.reopenCount).toBe(1);
    expect(JSON.stringify(reopened.data)).not.toContain('Causa');
  });
});
