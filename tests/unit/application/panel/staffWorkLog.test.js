import { jest } from '@jest/globals';
import ClientTickets from '../../../../src/application/use-cases/panel/ClientTickets.js';
import StaffWorkLog from '../../../../src/application/use-cases/panel/StaffWorkLog.js';
import { panelReasons } from '../../../../src/application/use-cases/panel/panelReasons.js';
import { toWorkLogView, workLogFingerprintSource } from '../../../../src/domain/panel/workLog.js';
import { FakeTenantDirectory, RecordingAuditLog } from './panelFakes.js';
import { FakeApiTokenCodec, InMemoryIdempotencyStore } from './apiTokenFakes.js';
import { FakeAttachmentStore, FakeContextReader, InMemoryTicketRepository } from './ticketFakes.js';

const PRINTER = 'sap_integration_printer';
const NOEL = 'sap_integration_noelito';
const START = new Date('2026-11-04T21:10:00.000Z');
const RESOLVED_MESSAGE = 'El ticket ya está resuelto. Pásalo a en progreso desde el panel para registrar más trabajo.';

const dev = { id: 'a1b2c3d4e5f6a7b8c9d0e1f2', name: 'Ana Mora', email: 'ana@smarteam.test', accountType: 'smarteam' };
const otherDev = { id: 'b1b2c3d4e5f6a7b8c9d0e1f2', name: 'Luis Vargas', email: 'luis@smarteam.test', accountType: 'smarteam' };
const clientUser = { id: 'c-1', name: 'Carla Cliente', role: 'admin', accountType: 'cliente', tenantKey: PRINTER };
const TOKEN_AUTH = Object.freeze({ via: 'token', tokenId: 'a00000000000000000000001', prefix: 'spn_a1b2' });
const OTHER_TOKEN_AUTH = Object.freeze({ via: 'token', tokenId: 'a00000000000000000000002', prefix: 'spn_c3d4' });

const BODY = Object.freeze({
  summary: 'Se corrigió el mapeo del campo de bodega.',
  internalNote: 'El mapeo apuntaba a la propiedad vieja; se reprocesaron 14 eventos.',
  hours: 2.5,
  resolve: false,
  crmProjectId: '123456789',
});

const TENANTS = [
  { tenantKey: PRINTER, companyName: 'Printer', status: 'active' },
  { tenantKey: NOEL, companyName: 'Noelito', status: 'suspended' },
];

function build({ tenants = TENANTS } = {}) {
  const ticketRepository = new InMemoryTicketRepository();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const apiTokenCodec = new FakeApiTokenCodec();
  const auditLog = new RecordingAuditLog();
  const logger = { warn: jest.fn() };
  let current = START.getTime();
  const now = () => new Date(current);
  const client = new ClientTickets({
    ticketRepository,
    attachmentStore: new FakeAttachmentStore(),
    contextReader: new FakeContextReader(),
    tenantDbPrefix: 'sap_integration',
    now,
  });
  const workLog = new StaffWorkLog({
    ticketRepository,
    tenantDirectory: new FakeTenantDirectory(tenants),
    idempotencyStore,
    apiTokenCodec,
    tenantDbPrefix: 'sap_integration',
    auditLog,
    logger,
    now,
  });
  return {
    ticketRepository,
    idempotencyStore,
    apiTokenCodec,
    auditLog,
    logger,
    client,
    workLog,
    advance: (ms) => { current += ms; },
  };
}

// Abre un ticket del tenant con el número pedido (el correlativo siguiente).
async function openTicket(ctx, { tenantKey = PRINTER, number = 12, status = 'abierto' } = {}) {
  ctx.ticketRepository.counters.set(tenantKey, number - 1);
  const result = await ctx.client.create({
    user: { ...clientUser, tenantKey },
    fields: { title: 'La cotización no llegó', description: 'Detalle', category: 'documentos' },
  });
  const ticket = ctx.ticketRepository.tickets(tenantKey).find((candidate) => candidate.id === result.data.id);
  ticket.status = status;
  ctx.ticketRepository.touchedTenants.length = 0;
  return ticket;
}

function stored(ctx, ticket, tenantKey = PRINTER) {
  return ctx.ticketRepository.tickets(tenantKey).find((candidate) => candidate.id === ticket.id);
}

function publish(ctx, overrides = {}) {
  return ctx.workLog.publish({
    user: dev,
    auth: TOKEN_AUTH,
    code: 'PRINTER-0012',
    body: { ...BODY },
    ...overrides,
  });
}

function fingerprint(ctx, body = BODY, code = 'PRINTER-0012') {
  const input = {
    summary: body.summary,
    internalNote: body.internalNote ?? null,
    hours: body.hours,
    resolve: body.resolve ?? false,
    crmProjectId: body.crmProjectId ?? null,
  };
  return ctx.apiTokenCodec.hash(workLogFingerprintSource({ code, input }));
}

describe('StaffWorkLog.findByCode', () => {
  it.each([
    ['PRINTER-0012'],
    [' printer-0012 '],
  ])('finds %p in sap_integration_printer', async (code) => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const result = await ctx.workLog.findByCode({ code });

    expect(result).toEqual({
      ok: true,
      data: {
        tenantKey: PRINTER,
        id: ticket.id,
        code: 'PRINTER-0012',
        title: 'La cotización no llegó',
        companyName: 'Printer',
        status: 'abierto',
        openedAt: START.toISOString(),
      },
    });
    expect(ctx.ticketRepository.touchedTenants).toEqual([PRINTER]);
  });

  it('finds a 5-digit number (PRINTER-12345)', async () => {
    const ctx = build();
    await openTicket(ctx, { number: 12345 });

    const result = await ctx.workLog.findByCode({ code: 'PRINTER-12345' });

    expect(result.data.code).toBe('PRINTER-12345');
  });

  it('answers not_found for a number that does not exist', async () => {
    const ctx = build();
    await openTicket(ctx);

    expect(await ctx.workLog.findByCode({ code: 'PRINTER-9999' })).toEqual({ ok: false, reason: panelReasons.NOT_FOUND });
  });

  it.each([
    ['an unknown company', 'NOEXISTE-0001'],
    ['a code without hyphen', 'PRINTER0012'],
    ['an empty code', ''],
    ['a non-string code', { $ne: null }],
    ['a code without number', 'PRINTER-'],
  ])('answers not_found for %s without opening any tenant database', async (_label, code) => {
    const ctx = build();
    await openTicket(ctx);

    expect(await ctx.workLog.findByCode({ code })).toEqual({ ok: false, reason: panelReasons.NOT_FOUND });
    expect(ctx.ticketRepository.touchedTenants).toEqual([]);
  });

  it('only opens tenants whose prefix matches (a suspended company is still searchable)', async () => {
    const ctx = build();
    await openTicket(ctx, { tenantKey: NOEL, number: 3 });

    const result = await ctx.workLog.findByCode({ code: 'noelito-0003' });

    expect(result.data).toEqual(expect.objectContaining({ tenantKey: NOEL, companyName: 'Noelito' }));
    expect(ctx.ticketRepository.touchedTenants).toEqual([NOEL]);
  });

  it('answers ambiguous_code (409) and warns when two companies give the same prefix and number', async () => {
    const ctx = build({ tenants: [...TENANTS, { tenantKey: 'printer', companyName: 'Printer viejo', status: 'active' }] });
    await openTicket(ctx);
    await openTicket(ctx, { tenantKey: 'printer' });

    const result = await ctx.workLog.findByCode({ code: 'PRINTER-0012' });

    expect(result).toEqual({ ok: false, reason: panelReasons.AMBIGUOUS_CODE });
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRINTER-0012' }));
  });

  it('does not mark the ticket as seen by Smarteam', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    await ctx.workLog.findByCode({ code: 'PRINTER-0012' });

    expect(stored(ctx, ticket).staffLastSeenAt).toBeNull();
  });
});

describe('StaffWorkLog.publish — effects', () => {
  it('abierto + resolve:false → public message by the token owner, en_progreso, firstResponseAt, client news and a work log entry', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    ctx.advance(60 * 1000);
    const at = new Date(START.getTime() + 60 * 1000);

    const result = await publish(ctx);

    const after = stored(ctx, ticket);
    const [message] = after.messages;
    const [entry] = after.workLog;
    expect(result).toEqual({
      ok: true,
      statusCode: 201,
      data: {
        entry: {
          id: entry.id,
          author: { name: 'Ana Mora' },
          hours: 2.5,
          internalNote: BODY.internalNote,
          crmProjectId: '123456789',
          createdAt: at.toISOString(),
          messageId: message.id,
        },
        ticket: { status: 'en_progreso' },
      },
    });
    expect(message).toEqual(expect.objectContaining({
      authorType: 'smarteam',
      authorId: dev.id,
      authorName: 'Ana Mora',
      body: BODY.summary,
      attachments: [],
    }));
    expect(after.status).toBe('en_progreso');
    expect(after.firstResponseAt).toEqual(at);
    expect(after.staffLastSeenAt).toEqual(at);
    expect(after.lastPublicAuthorType).toBe('smarteam');
    expect(after.statusHistory.map(({ to }) => to)).toEqual(['abierto', 'en_progreso']);
    expect(entry).toEqual({
      id: expect.any(String),
      authorId: dev.id,
      authorName: 'Ana Mora',
      hours: 2.5,
      internalNote: BODY.internalNote,
      crmProjectId: '123456789',
      messageId: message.id,
      resolved: false,
      statusAfter: 'en_progreso',
      via: 'token',
      tokenId: TOKEN_AUTH.tokenId,
      idempotencyKey: null,
      idempotencyFingerprint: null,
      createdAt: at,
    });

    const list = await ctx.client.list({ user: clientUser, query: {} });
    expect(list.data.items[0].hasNews).toBe(true);
  });

  it('keeps esperando_cliente with resolve:false and adds no history entry', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx, { status: 'esperando_cliente' });

    const result = await publish(ctx);

    expect(result.data.ticket.status).toBe('esperando_cliente');
    expect(stored(ctx, ticket).status).toBe('esperando_cliente');
    expect(stored(ctx, ticket).statusHistory).toHaveLength(1);
  });

  it('en_progreso + resolve:true → resuelto with resolvedAt, internalResolution and history; the client sees the summary', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx, { status: 'en_progreso' });
    stored(ctx, ticket).internalResolution = { text: 'Anterior', updatedAt: START, updatedBy: { userId: 'x', name: 'X' } };

    const result = await publish(ctx, { body: { ...BODY, resolve: true } });

    const after = stored(ctx, ticket);
    expect(result.data.ticket.status).toBe('resuelto');
    expect(after.status).toBe('resuelto');
    expect(after.resolvedAt).toEqual(START);
    expect(after.internalResolution).toEqual({ text: BODY.internalNote, updatedAt: START, updatedBy: { userId: dev.id, name: 'Ana Mora' } });
    expect(after.statusHistory.at(-1)).toEqual(expect.objectContaining({ from: 'en_progreso', to: 'resuelto', byType: 'smarteam', byName: 'Ana Mora' }));
    expect(after.workLog[0]).toEqual(expect.objectContaining({ resolved: true, statusAfter: 'resuelto' }));

    const detail = await ctx.client.get({ user: clientUser, id: ticket.id });
    expect(detail.data.messages.map(({ body }) => body)).toEqual([BODY.summary]);
  });

  it('records via session and no tokenId with the default auth', async () => {
    const ctx = build();
    await openTicket(ctx);

    await ctx.workLog.publish({ user: dev, code: 'PRINTER-0012', body: { ...BODY } });

    const [entry] = ctx.ticketRepository.tickets(PRINTER)[0].workLog;
    expect(entry).toEqual(expect.objectContaining({ via: 'session', tokenId: null }));
  });

  it('answers 400 for resolve:true without internalNote and leaves the ticket untouched', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx, { status: 'en_progreso' });
    const before = structuredClone(stored(ctx, ticket));

    const result = await publish(ctx, { body: { ...BODY, resolve: true, internalNote: '  ' } });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message: 'La nota interna es obligatoria para resolver.' });
    expect(stored(ctx, ticket)).toEqual(before);
  });

  it.each([[false], [true]])('answers invalid_transition on a resolved ticket (resolve:%p) and leaves it identical', async (resolve) => {
    const ctx = build();
    const ticket = await openTicket(ctx, { status: 'resuelto' });
    const before = structuredClone(stored(ctx, ticket));

    const result = await publish(ctx, { body: { ...BODY, resolve }, idempotencyKey: 'k-resuelto' });

    expect(result).toEqual({ ok: false, reason: panelReasons.INVALID_TRANSITION, message: RESOLVED_MESSAGE });
    expect(stored(ctx, ticket)).toEqual(before);
    expect(ctx.idempotencyStore.records).toEqual([]);
  });

  it.each([[0.25], [24]])('accepts hours = %p', async (hours) => {
    const ctx = build();
    await openTicket(ctx);

    expect((await publish(ctx, { body: { ...BODY, hours } })).statusCode).toBe(201);
  });

  it.each([[0], [0.2], [24.25], ['2.5'], [null]])('rejects hours = %p with 400', async (hours) => {
    const ctx = build();
    await openTicket(ctx);

    const result = await publish(ctx, { body: { ...BODY, hours } });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message: 'Las horas deben ir de 0.25 a 24, en cuartos de hora.' });
  });

  it.each([
    ['an empty summary', { summary: '' }],
    ['a 5001-character summary', { summary: 'x'.repeat(5001) }],
    ['a 65-character crmProjectId', { crmProjectId: 'x'.repeat(65) }],
  ])('rejects %s with 400 before touching anything', async (_label, patch) => {
    const ctx = build();
    await openTicket(ctx);

    const result = await publish(ctx, { body: { ...BODY, ...patch }, idempotencyKey: 'k-400' });

    expect(result.reason).toBe(panelReasons.VALIDATION_ERROR);
    expect(ctx.idempotencyStore.calls).toEqual([]);
    expect(ctx.ticketRepository.touchedTenants).toEqual([]);
  });

  it('answers not_found for an unknown code', async () => {
    const ctx = build();
    await openTicket(ctx);

    expect(await publish(ctx, { code: 'PRINTER-9999' })).toEqual({ ok: false, reason: panelReasons.NOT_FOUND });
  });

  it('retries once with the re-read ticket when the state changed in between', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    ctx.ticketRepository.conflictNextUpdate = true;

    const result = await publish(ctx);

    expect(result.statusCode).toBe(201);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
    expect(stored(ctx, ticket).messages).toHaveLength(1);
  });

  it('answers invalid_transition when the ticket was resolved between the read and the write', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx, { status: 'en_progreso' });
    const update = ctx.ticketRepository.update.bind(ctx.ticketRepository);
    ctx.ticketRepository.update = async (tenantKey, id, change) => {
      stored(ctx, ticket).status = 'resuelto';
      return update(tenantKey, id, change);
    };

    const result = await publish(ctx, { idempotencyKey: 'k-carrera' });

    expect(result).toEqual({ ok: false, reason: panelReasons.INVALID_TRANSITION, message: RESOLVED_MESSAGE });
    expect(stored(ctx, ticket).workLog).toBeUndefined();
    expect(ctx.idempotencyStore.records).toEqual([]);
  });

  it('without Idempotency-Key two calls create two entries', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    await publish(ctx);
    await publish(ctx);

    expect(stored(ctx, ticket).workLog).toHaveLength(2);
    expect(stored(ctx, ticket).messages).toHaveLength(2);
    expect(ctx.idempotencyStore.calls).toEqual([]);
  });

  it('audits ticket.work_logged without the note, the summary or the token', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const result = await publish(ctx, { ip: '10.0.0.9' });

    expect(ctx.auditLog.entries).toHaveLength(1);
    const [entry] = ctx.auditLog.entries;
    expect(entry).toEqual(expect.objectContaining({
      action: 'ticket.work_logged',
      actor: { userId: dev.id, email: dev.email, accountType: 'smarteam' },
      target: null,
      details: {
        tenantKey: PRINTER,
        ticketId: ticket.id,
        ticketCode: 'PRINTER-0012',
        entryId: result.data.entry.id,
        hours: 2.5,
        resolved: false,
        via: 'token',
        tokenPrefix: 'spn_a1b2',
      },
      ip: '10.0.0.9',
      expiresAt: null,
    }));
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(BODY.internalNote);
    expect(serialized).not.toContain(BODY.summary);
    expect(serialized).not.toContain(TOKEN_AUTH.tokenId);
  });
});

describe('StaffWorkLog.publish — idempotency', () => {
  it('the same key twice answers the same response with one entry, one message and one audit', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const first = await publish(ctx, { idempotencyKey: 'clave-1' });
    ctx.advance(5000);
    const second = await publish(ctx, { idempotencyKey: 'clave-1' });

    expect(second).toEqual(first);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
    expect(stored(ctx, ticket).messages).toHaveLength(1);
    expect(ctx.auditLog.actions()).toEqual(['ticket.work_logged']);
    expect(ctx.idempotencyStore.records).toEqual([expect.objectContaining({
      ownerKey: `token:${TOKEN_AUTH.tokenId}`,
      key: 'clave-1',
      state: 'done',
      tenantKey: PRINTER,
      ticketId: ticket.id,
      entryId: first.data.entry.id,
      status: 201,
      fingerprint: fingerprint(ctx),
    })]);
    expect(stored(ctx, ticket).workLog[0].idempotencyKey).toBe(`token:${TOKEN_AUTH.tokenId}:clave-1`);
  });

  it('uses user:<id> as owner with a session', async () => {
    const ctx = build();
    await openTicket(ctx);

    await ctx.workLog.publish({ user: dev, auth: { via: 'session' }, code: 'PRINTER-0012', body: { ...BODY }, idempotencyKey: 'k' });

    expect(ctx.idempotencyStore.records[0].ownerKey).toBe(`user:${dev.id}`);
  });

  it('the same key with another hours answers idempotency_key_reused (422)', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    await publish(ctx, { idempotencyKey: 'clave-1' });

    const result = await publish(ctx, { idempotencyKey: 'clave-1', body: { ...BODY, hours: 3 } });

    expect(result).toEqual({ ok: false, reason: panelReasons.IDEMPOTENCY_KEY_REUSED });
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
  });

  it('a pending key with another fingerprint answers 422', async () => {
    const ctx = build();
    await openTicket(ctx);
    await ctx.idempotencyStore.reserve({ ownerKey: `token:${TOKEN_AUTH.tokenId}`, key: 'k', fingerprint: 'otra', at: START });

    expect(await publish(ctx, { idempotencyKey: 'k' })).toEqual({ ok: false, reason: panelReasons.IDEMPOTENCY_KEY_REUSED });
  });

  it('a fresh pending key with the same fingerprint answers request_in_progress (409)', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    await ctx.idempotencyStore.reserve({ ownerKey: `token:${TOKEN_AUTH.tokenId}`, key: 'k', fingerprint: fingerprint(ctx), at: new Date(START.getTime() - 59 * 1000) });

    expect(await publish(ctx, { idempotencyKey: 'k' })).toEqual({ ok: false, reason: panelReasons.REQUEST_IN_PROGRESS });
    expect(stored(ctx, ticket).workLog).toBeUndefined();
    // El pending ajeno no se libera.
    expect(ctx.idempotencyStore.records).toHaveLength(1);
  });

  it('two simultaneous requests with the same key: one 201 and the other 409 or the same response', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const results = await Promise.all([publish(ctx, { idempotencyKey: 'k' }), publish(ctx, { idempotencyKey: 'k' })]);

    const created = results.filter((result) => result.statusCode === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    results.filter((result) => result.statusCode !== 201).forEach((result) => {
      expect(result).toEqual({ ok: false, reason: panelReasons.REQUEST_IN_PROGRESS });
    });
    created.forEach((result) => expect(result).toEqual(created[0]));
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
  });

  it('the same key from another token is processed as new', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const first = await publish(ctx, { idempotencyKey: 'k' });
    const second = await publish(ctx, { user: otherDev, auth: OTHER_TOKEN_AUTH, idempotencyKey: 'k' });

    expect(second.statusCode).toBe(201);
    expect(second.data.entry.id).not.toBe(first.data.entry.id);
    expect(second.data.entry.author).toEqual({ name: 'Luis Vargas' });
    expect(stored(ctx, ticket).workLog).toHaveLength(2);
  });

  it('a 400 first attempt and a corrected retry with the same key answers 201', async () => {
    const ctx = build();
    await openTicket(ctx);

    const invalid = await publish(ctx, { idempotencyKey: 'k', body: { ...BODY, hours: 0 } });
    const corrected = await publish(ctx, { idempotencyKey: 'k' });

    expect(invalid.reason).toBe(panelReasons.VALIDATION_ERROR);
    expect(corrected.statusCode).toBe(201);
  });

  it('a 404 after reserving releases the key, so a later retry is processed', async () => {
    const ctx = build();
    const result = await publish(ctx, { idempotencyKey: 'k' });

    expect(result).toEqual({ ok: false, reason: panelReasons.NOT_FOUND });
    expect(ctx.idempotencyStore.records).toEqual([]);
    expect(ctx.idempotencyStore.calls).toEqual(['find', 'reserve', 'release']);

    await openTicket(ctx);
    expect((await publish(ctx, { idempotencyKey: 'k' })).statusCode).toBe(201);
  });

  it('an ambiguous code after reserving releases the key', async () => {
    const ctx = build({ tenants: [...TENANTS, { tenantKey: 'printer', companyName: 'Printer viejo', status: 'active' }] });
    await openTicket(ctx);
    await openTicket(ctx, { tenantKey: 'printer' });

    expect(await publish(ctx, { idempotencyKey: 'k' })).toEqual({ ok: false, reason: panelReasons.AMBIGUOUS_CODE });
    expect(ctx.idempotencyStore.records).toEqual([]);
  });

  it('a failing release does not change the answer and is logged', async () => {
    const ctx = build();
    ctx.idempotencyStore.failNextRelease = true;

    expect(await publish(ctx, { idempotencyKey: 'k' })).toEqual({ ok: false, reason: panelReasons.NOT_FOUND });
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('not released') }));
  });

  it.each([
    ['internalNote ""', { internalNote: '' }],
    ['internalNote "   "', { internalNote: '   ' }],
    ['no internalNote', { internalNote: undefined }],
  ])('normalizes the fingerprint: %s, an unknown field and another key order give the same response', async (_label, patch) => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    const base = { ...BODY, internalNote: null };

    const first = await publish(ctx, { idempotencyKey: 'k', body: base });
    const { summary, ...rest } = { ...BODY, ...patch, extra: 'campo desconocido' };
    const second = await publish(ctx, { idempotencyKey: 'k', code: ' printer-0012 ', body: { ...rest, summary: `  ${summary}  ` } });

    expect(second).toEqual(first);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
  });

  it.each([
    ['a space', 'clave con espacio'],
    ['a slash', 'clave/1'],
    ['an empty key', ''],
    ['129 characters', 'k'.repeat(129)],
  ])('rejects an Idempotency-Key with %s (400)', async (_label, idempotencyKey) => {
    const ctx = build();
    await openTicket(ctx);

    const result = await publish(ctx, { idempotencyKey });

    expect(result).toEqual({
      ok: false,
      reason: panelReasons.VALIDATION_ERROR,
      message: 'Idempotency-Key debe tener de 1 a 128 caracteres: letras, números, punto, guion bajo, dos puntos o guion.',
    });
    expect(ctx.idempotencyStore.calls).toEqual([]);
  });

  it('accepts a UUID and a 128-character key', async () => {
    const ctx = build();
    await openTicket(ctx);

    expect((await publish(ctx, { idempotencyKey: '0b6f3c1e-8a2d-4f7b-9c55-1e2d3f4a5b6c' })).statusCode).toBe(201);
    expect((await publish(ctx, { idempotencyKey: 'k'.repeat(128) })).statusCode).toBe(201);
  });

  it('a crash in complete after writing with resolve:true is recovered 60 s later with the same 201, not a 409', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx, { status: 'en_progreso' });
    ctx.idempotencyStore.failNextComplete = true;
    const body = { ...BODY, resolve: true };

    const first = await publish(ctx, { idempotencyKey: 'k', body });
    expect(first.statusCode).toBe(201);
    expect(first.data.ticket.status).toBe('resuelto');
    expect(ctx.idempotencyStore.records[0].state).toBe('pending');
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('not completed') }));

    // Antes de 60 s: sigue en curso.
    ctx.advance(30 * 1000);
    expect(await publish(ctx, { idempotencyKey: 'k', body })).toEqual({ ok: false, reason: panelReasons.REQUEST_IN_PROGRESS });

    // A los 60 s desde la reserva se retoma; el paso 4 encuentra la entrada.
    ctx.advance(31 * 1000);
    const retried = await publish(ctx, { idempotencyKey: 'k', body });

    expect(retried).toEqual(first);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
    expect(stored(ctx, ticket).messages).toHaveLength(1);
    expect(ctx.idempotencyStore.records[0]).toEqual(expect.objectContaining({ state: 'done', entryId: first.data.entry.id, status: 201 }));
    expect(ctx.auditLog.actions()).toEqual(['ticket.work_logged']);
  });

  it('an exception after reserving releases the key and rethrows; an immediate retry is processed', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    ctx.ticketRepository.failNextUpdate = true;

    await expect(publish(ctx, { idempotencyKey: 'k' })).rejects.toThrow('update failed');
    expect(ctx.idempotencyStore.records).toEqual([]);

    const retried = await publish(ctx, { idempotencyKey: 'k' });
    expect(retried.statusCode).toBe(201);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
  });

  it('two simultaneous takeovers of an abandoned pending: one proceeds and the other answers 409', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    await ctx.idempotencyStore.reserve({ ownerKey: `token:${TOKEN_AUTH.tokenId}`, key: 'k', fingerprint: fingerprint(ctx), at: new Date(START.getTime() - 120 * 1000) });

    const results = await Promise.all([publish(ctx, { idempotencyKey: 'k' }), publish(ctx, { idempotencyKey: 'k' })]);

    expect(results.map((result) => result.statusCode ?? result.reason).sort()).toEqual([201, panelReasons.REQUEST_IN_PROGRESS].sort());
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
  });

  it('the replay is identical even after the ticket status changed', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    const first = await publish(ctx, { idempotencyKey: 'k' });
    stored(ctx, ticket).status = 'resuelto';
    stored(ctx, ticket).workLog.push({ ...stored(ctx, ticket).workLog[0], id: 'ffffffffffffffffffffffff', hours: 1 });

    ctx.advance(60 * 60 * 1000);
    const replay = await publish(ctx, { idempotencyKey: 'k' });

    expect(replay).toEqual(first);
    expect(replay.data.ticket.status).toBe('en_progreso');
  });

  it('passes the request time to find, so an expired key is not used', async () => {
    const ctx = build();
    await openTicket(ctx);
    const find = jest.spyOn(ctx.idempotencyStore, 'find');

    await publish(ctx, { idempotencyKey: 'k' });

    expect(find).toHaveBeenCalledWith({ ownerKey: `token:${TOKEN_AUTH.tokenId}`, key: 'k', now: START });
  });

  it('the fake store ignores an expired key the same way', async () => {
    const ctx = build();
    await ctx.idempotencyStore.reserve({ ownerKey: 'token:t', key: 'k', fingerprint: 'f', at: START });

    expect(await ctx.idempotencyStore.find({ ownerKey: 'token:t', key: 'k', now: new Date(START.getTime() + 24 * 60 * 60 * 1000) })).toBeNull();
    expect(await ctx.idempotencyStore.find({ ownerKey: 'token:t', key: 'k', now: START })).toEqual(expect.objectContaining({ key: 'k' }));
  });

  it('stores the fingerprint in the entry and never shows it', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);

    const result = await publish(ctx, { idempotencyKey: 'k' });
    const withoutKey = await publish(ctx);

    const [keyed, unkeyed] = stored(ctx, ticket).workLog;
    expect(keyed.idempotencyFingerprint).toBe(fingerprint(ctx));
    expect(unkeyed.idempotencyFingerprint).toBeNull();
    expect(result.data.entry).not.toHaveProperty('idempotencyFingerprint');
    expect(withoutKey.data.entry).not.toHaveProperty('idempotencyFingerprint');
    expect(JSON.stringify(toWorkLogView(stored(ctx, ticket).workLog))).not.toContain('idempotencyFingerprint');
    expect(JSON.stringify(toWorkLogView(stored(ctx, ticket).workLog))).not.toContain(fingerprint(ctx));
  });

  it('after the key expired (24 h), the same key with another body answers 422 and releases its reservation', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    await publish(ctx, { idempotencyKey: 'k' });
    ctx.advance(25 * 60 * 60 * 1000);
    ctx.idempotencyStore.entries.clear(); // el índice TTL ya la borró

    const result = await publish(ctx, { idempotencyKey: 'k', body: { ...BODY, hours: 3 } });

    expect(result).toEqual({ ok: false, reason: panelReasons.IDEMPOTENCY_KEY_REUSED });
    expect(ctx.idempotencyStore.records).toEqual([]);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
    expect(stored(ctx, ticket).messages).toHaveLength(1);
    expect(ctx.auditLog.actions()).toEqual(['ticket.work_logged']);
  });

  it('after the key expired (24 h), the same key with the same body answers the same 201', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    const first = await publish(ctx, { idempotencyKey: 'k' });
    ctx.advance(25 * 60 * 60 * 1000);
    ctx.idempotencyStore.entries.clear();

    const again = await publish(ctx, { idempotencyKey: 'k' });

    expect(again).toEqual(first);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
    expect(ctx.idempotencyStore.records).toEqual([expect.objectContaining({ state: 'done', entryId: first.data.entry.id })]);
  });

  it('an older entry without fingerprint keeps the previous behavior (same 201)', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    const first = await publish(ctx, { idempotencyKey: 'k' });
    delete stored(ctx, ticket).workLog[0].idempotencyFingerprint;
    ctx.advance(25 * 60 * 60 * 1000);
    ctx.idempotencyStore.entries.clear();

    const again = await publish(ctx, { idempotencyKey: 'k', body: { ...BODY, hours: 3 } });

    expect(again).toEqual(first);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
  });

  it('an entry with the same key and another fingerprint found after a failed guard answers 422 and releases', async () => {
    const ctx = build();
    const ticket = await openTicket(ctx);
    const guardKey = `token:${TOKEN_AUTH.tokenId}:k`;
    const update = ctx.ticketRepository.update.bind(ctx.ticketRepository);
    jest.spyOn(ctx.ticketRepository, 'update').mockImplementationOnce(async (tenantKey, id, change) => {
      // Otra escritura con la misma clave y otro cuerpo se adelantó.
      stored(ctx, ticket).workLog = [{ ...change.pushWorkLog, id: 'eeeeeeeeeeeeeeeeeeeeeeee', hours: 3, idempotencyKey: guardKey, idempotencyFingerprint: 'otra-huella' }];
      return update(tenantKey, id, change);
    });

    const result = await publish(ctx, { idempotencyKey: 'k' });

    expect(result).toEqual({ ok: false, reason: panelReasons.IDEMPOTENCY_KEY_REUSED });
    expect(ctx.idempotencyStore.records).toEqual([]);
    expect(stored(ctx, ticket).workLog).toHaveLength(1);
    expect(stored(ctx, ticket).workLog[0].id).toBe('eeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('never stores the summary, the internal note or the response body in the key registry', async () => {
    const ctx = build();
    await openTicket(ctx);

    const result = await publish(ctx, { idempotencyKey: 'k' });

    const serialized = JSON.stringify(ctx.idempotencyStore.records);
    expect(serialized).not.toContain(BODY.summary);
    expect(serialized).not.toContain(BODY.internalNote);
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain(result.data.entry.messageId);
    expect(Object.keys(ctx.idempotencyStore.records[0]).sort()).toEqual([
      'createdAt', 'entryId', 'expiresAt', 'fingerprint', 'key', 'ownerKey', 'state', 'status', 'tenantKey', 'ticketId',
    ]);
  });
});
