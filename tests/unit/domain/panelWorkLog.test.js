import {
  checkIdempotencyKey,
  checkWorkLogInput,
  toWorkLogEntryView,
  toWorkLogView,
  totalHours,
  workLogFingerprintSource,
} from '../../../src/domain/panel/workLog.js';
import { parseTicketCode } from '../../../src/domain/panel/tickets.js';

const HOURS_MESSAGE = 'Las horas deben ir de 0.25 a 24, en cuartos de hora.';

function body(overrides = {}) {
  return { summary: 'Se corrigió el mapeo.', hours: 2.5, ...overrides };
}

describe('checkWorkLogInput', () => {
  it('normalizes a full body', () => {
    expect(checkWorkLogInput(body({
      summary: '  Se corrigió el mapeo.  ',
      internalNote: '  Nota  ',
      resolve: true,
      crmProjectId: ' 123456789 ',
    }))).toEqual({
      ok: true,
      input: {
        summary: 'Se corrigió el mapeo.',
        internalNote: 'Nota',
        hours: 2.5,
        resolve: true,
        crmProjectId: '123456789',
      },
    });
  });

  it('defaults optional fields and ignores unknown fields', () => {
    expect(checkWorkLogInput(body({ extra: 'x', internalNote: '   ', crmProjectId: '' }))).toEqual({
      ok: true,
      input: { summary: 'Se corrigió el mapeo.', internalNote: null, hours: 2.5, resolve: false, crmProjectId: null },
    });
  });

  it.each([0.25, 24, 1, 7.75])('accepts hours %p', (hours) => {
    expect(checkWorkLogInput(body({ hours })).ok).toBe(true);
  });

  it.each([0, 0.2, 24.25, '2.5', null, undefined, -1, Number.NaN, Infinity, 1.1])('rejects hours %p', (hours) => {
    expect(checkWorkLogInput(body({ hours }))).toEqual({ ok: false, message: HOURS_MESSAGE });
  });

  it.each([
    ['empty summary', { summary: '' }, 'El resumen es obligatorio.'],
    ['blank summary', { summary: '   ' }, 'El resumen es obligatorio.'],
    ['missing summary', { summary: undefined }, 'El resumen es obligatorio.'],
    ['5001 summary', { summary: 'a'.repeat(5001) }, 'El resumen supera los 5000 caracteres.'],
    ['5001 internal note', { internalNote: 'a'.repeat(5001) }, 'La nota interna supera los 5000 caracteres.'],
    ['resolve without note', { resolve: true }, 'La nota interna es obligatoria para resolver.'],
    ['resolve with blank note', { resolve: true, internalNote: '  ' }, 'La nota interna es obligatoria para resolver.'],
    ['resolve as text', { resolve: 'true' }, 'resolve debe ser verdadero o falso.'],
    ['65 crmProjectId', { crmProjectId: 'a'.repeat(65) },
      'El id del proyecto del CRM debe tener hasta 64 caracteres: letras, números, guion bajo o guion.'],
    ['crmProjectId with spaces inside', { crmProjectId: '12 34' },
      'El id del proyecto del CRM debe tener hasta 64 caracteres: letras, números, guion bajo o guion.'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(checkWorkLogInput(body(overrides))).toEqual({ ok: false, message });
  });

  it('accepts 5000 characters and a 64 character crmProjectId', () => {
    const result = checkWorkLogInput(body({ summary: 'a'.repeat(5000), crmProjectId: `${'a'.repeat(62)}_-` }));
    expect(result.ok).toBe(true);
  });

  it.each([null, undefined, 'texto', []])('asks for the summary when the body is %p', (value) => {
    expect(checkWorkLogInput(value)).toEqual({ ok: false, message: 'El resumen es obligatorio.' });
  });
});

describe('checkIdempotencyKey', () => {
  const MESSAGE = 'Idempotency-Key debe tener de 1 a 128 caracteres: letras, números, punto, guion bajo, dos puntos o guion.';

  it.each([undefined, null])('is optional (%p)', (value) => {
    expect(checkIdempotencyKey(value)).toEqual({ ok: true, key: null });
  });

  it.each(['3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f', 'a', 'x.y_z:1-2', 'a'.repeat(128)])('accepts %p', (value) => {
    expect(checkIdempotencyKey(value)).toEqual({ ok: true, key: value });
  });

  it.each(['', ' abc', 'a b', 'a/b', 'a'.repeat(129), 42])('rejects %p', (value) => {
    expect(checkIdempotencyKey(value)).toEqual({ ok: false, message: MESSAGE });
  });
});

describe('workLogFingerprintSource', () => {
  function source(raw, code = 'PRINTER-0012') {
    const result = checkWorkLogInput(raw);
    expect(result.ok).toBe(true);
    return workLogFingerprintSource({ code, input: result.input });
  }

  it('uses fixed key order and normalized values', () => {
    expect(source(body(), ' printer-0012 ')).toBe(
      '{"code":"PRINTER-0012","summary":"Se corrigió el mapeo.","internalNote":null,"hours":2.5,"resolve":false,"crmProjectId":null}'
    );
  });

  it('is the same with empty, blank or missing internalNote and with unknown fields', () => {
    const base = source(body());
    expect(source(body({ internalNote: '' }))).toBe(base);
    expect(source(body({ internalNote: '   ' }))).toBe(base);
    expect(source(body({ unknown: 'x' }))).toBe(base);
    expect(source({ hours: 2.5, summary: 'Se corrigió el mapeo.' })).toBe(base);
  });

  it('changes when a normalized field changes', () => {
    expect(source(body({ hours: 3 }))).not.toBe(source(body()));
  });
});

describe('parseTicketCode', () => {
  it.each([
    ['PRINTER-0012', { code: 'PRINTER-0012', prefix: 'PRINTER', number: 12 }],
    [' printer-0012 ', { code: 'PRINTER-0012', prefix: 'PRINTER', number: 12 }],
    ['PRINTER-12345', { code: 'PRINTER-12345', prefix: 'PRINTER', number: 12345 }],
    ['MI-EMPRESA-0003', { code: 'MI-EMPRESA-0003', prefix: 'MI-EMPRESA', number: 3 }],
  ])('parses %p', (value, expected) => {
    expect(parseTicketCode(value)).toEqual(expected);
  });

  it.each(['PRINTER0012', 'PRINTER-', '-0012', 'PRINTER-12a', 'PRINTER-1234567890', '', null, undefined, 12])(
    'returns null for %p',
    (value) => {
      expect(parseTicketCode(value)).toBeNull();
    }
  );
});

describe('work log view', () => {
  const older = {
    id: 'e1',
    authorId: 'u2',
    authorName: 'Luis Vargas',
    hours: 1.75,
    internalNote: null,
    crmProjectId: null,
    messageId: 'm1',
    resolved: false,
    statusAfter: 'en_progreso',
    via: 'session',
    tokenId: null,
    idempotencyKey: null,
    createdAt: new Date('2026-11-03T16:00:00.000Z'),
  };
  const newer = {
    id: 'e2',
    authorId: 'u1',
    authorName: 'Ana Mora',
    hours: 2.5,
    internalNote: 'Nota',
    crmProjectId: '123456789',
    messageId: 'm2',
    resolved: true,
    statusAfter: 'resuelto',
    via: 'token',
    tokenId: 't1',
    idempotencyKey: 'token:t1:abc',
    createdAt: new Date('2026-11-04T21:10:00.000Z'),
  };

  it('sorts newest first and sums hours (2.5 + 1.75 = 4.25)', () => {
    const view = toWorkLogView([older, newer]);
    expect(view.totalHours).toBe(4.25);
    expect(view.entries.map((entry) => entry.id)).toEqual(['e2', 'e1']);
    expect(view.entries[0]).toEqual({
      id: 'e2',
      author: { name: 'Ana Mora' },
      hours: 2.5,
      internalNote: 'Nota',
      crmProjectId: '123456789',
      createdAt: '2026-11-04T21:10:00.000Z',
      messageId: 'm2',
    });
  });

  it('does not expose internal fields', () => {
    const view = toWorkLogEntryView(newer);
    for (const key of ['authorId', 'tokenId', 'idempotencyKey', 'via', 'statusAfter', 'resolved']) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it('is empty without entries', () => {
    expect(toWorkLogView(undefined)).toEqual({ totalHours: 0, entries: [] });
    expect(toWorkLogView([])).toEqual({ totalHours: 0, entries: [] });
    expect(totalHours([])).toBe(0);
  });
});
