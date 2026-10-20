import {
  TICKET_LIMITS,
  canResolve,
  canStaffSetStatus,
  checkRequiredText,
  hasNewsFor,
  isTicketCategory,
  isTicketContextType,
  isTicketStatus,
  statusAfterClientMessage,
  statusAfterReopen,
  statusAfterStaffMessage,
  ticketCode,
  ticketCodePrefix,
} from '../../../src/domain/panel/tickets.js';
import { detectImageType, safeAttachmentFilename } from '../../../src/domain/panel/imageType.js';
import { toEventView, toSyncView } from '../../../src/domain/panel/operationViews.js';

const STATUSES = ['abierto', 'en_progreso', 'esperando_cliente', 'resuelto'];

describe('ticket transitions', () => {
  it.each([
    ['abierto', 'abierto'],
    ['en_progreso', 'en_progreso'],
    ['esperando_cliente', 'en_progreso'],
    ['resuelto', null],
  ])('client message on %s leaves %s', (from, expected) => {
    expect(statusAfterClientMessage(from)).toBe(expected);
  });

  it.each([
    ['abierto', 'en_progreso'],
    ['en_progreso', 'en_progreso'],
    ['esperando_cliente', 'esperando_cliente'],
    ['resuelto', null],
  ])('staff message on %s leaves %s', (from, expected) => {
    expect(statusAfterStaffMessage(from)).toBe(expected);
  });

  it('allows only the three manual staff transitions', () => {
    const allowed = [];
    for (const from of STATUSES) {
      for (const to of [...STATUSES, 'cerrado', undefined]) {
        if (canStaffSetStatus(from, to)) {
          allowed.push(`${from}->${to}`);
        }
      }
    }
    expect(allowed).toEqual(['abierto->en_progreso', 'en_progreso->esperando_cliente', 'resuelto->en_progreso']);
  });

  it('resolves from any status except resuelto', () => {
    expect(STATUSES.filter(canResolve)).toEqual(['abierto', 'en_progreso', 'esperando_cliente']);
    expect(canResolve('desconocido')).toBe(false);
  });

  it('reopens only a resolved ticket, back to abierto', () => {
    expect(statusAfterReopen('resuelto')).toBe('abierto');
    for (const status of ['abierto', 'en_progreso', 'esperando_cliente']) {
      expect(statusAfterReopen(status)).toBeNull();
    }
  });

  it('rejects unknown statuses everywhere', () => {
    expect(statusAfterClientMessage('x')).toBeNull();
    expect(statusAfterStaffMessage(undefined)).toBeNull();
  });
});

describe('hasNewsFor', () => {
  const base = { lastActivityAt: new Date('2026-10-12T10:00:00Z') };

  it('client side: last public author is smarteam and newer than the client view', () => {
    expect(hasNewsFor({ ...base, lastPublicAuthorType: 'smarteam', clientLastSeenAt: new Date('2026-10-12T09:00:00Z') }, 'cliente')).toBe(true);
    expect(hasNewsFor({ ...base, lastPublicAuthorType: 'smarteam', clientLastSeenAt: new Date('2026-10-12T10:00:00Z') }, 'cliente')).toBe(false);
    expect(hasNewsFor({ ...base, lastPublicAuthorType: 'cliente', clientLastSeenAt: null }, 'cliente')).toBe(false);
  });

  it('staff side: a new ticket nobody at Smarteam opened has news', () => {
    expect(hasNewsFor({ ...base, lastPublicAuthorType: 'cliente', staffLastSeenAt: null }, 'smarteam')).toBe(true);
    expect(hasNewsFor({ ...base, lastPublicAuthorType: 'cliente', staffLastSeenAt: new Date('2026-10-12T11:00:00Z') }, 'smarteam')).toBe(false);
    expect(hasNewsFor({ ...base, lastPublicAuthorType: 'smarteam', staffLastSeenAt: null }, 'smarteam')).toBe(false);
  });
});

describe('ticket code', () => {
  it('strips the tenant database prefix and pads to 4 digits', () => {
    expect(ticketCode('sap_integration_printer', 7, 'sap_integration')).toBe('PRINTER-0007');
    expect(ticketCode('sap_integration_printer', 12345, 'sap_integration')).toBe('PRINTER-12345');
  });

  it('keeps the whole key when it has no prefix', () => {
    expect(ticketCodePrefix('acme', 'sap_integration')).toBe('ACME');
    expect(ticketCodePrefix('acme', '')).toBe('ACME');
  });
});

describe('value checks', () => {
  it('validates statuses, categories and context types as strings only', () => {
    expect(isTicketStatus('abierto')).toBe(true);
    expect(isTicketStatus(['abierto'])).toBe(false);
    expect(isTicketCategory('documentos')).toBe(true);
    expect(isTicketCategory({ $ne: 'x' })).toBe(false);
    expect(isTicketContextType('webhookEvent')).toBe(true);
    expect(isTicketContextType('WebhookEvent')).toBe(false);
  });

  it('trims required texts and enforces the limit', () => {
    expect(checkRequiredText('  hola  ', { label: 'El mensaje', max: 10 })).toEqual({ text: 'hola' });
    expect(checkRequiredText('   ', { label: 'El mensaje', max: 10 })).toEqual({ message: 'El mensaje es obligatorio.' });
    expect(checkRequiredText(5, { label: 'El mensaje', max: 10 })).toEqual({ message: 'El mensaje es obligatorio.' });
    expect(checkRequiredText('x'.repeat(11), { label: 'El mensaje', max: 10 })).toEqual({ message: 'El mensaje supera los 10 caracteres.' });
  });

  it('exposes the contract limits', () => {
    expect(TICKET_LIMITS).toEqual(expect.objectContaining({
      TITLE_MAX: 150,
      TEXT_MAX: 5000,
      MAX_IMAGES: 5,
      MAX_IMAGE_BYTES: 5 * 1024 * 1024,
      INBOX_PAGE_WINDOW: 1000,
    }));
  });
});

describe('detectImageType', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1');

  it('detects PNG, JPEG and WebP by their bytes', () => {
    expect(detectImageType(png)).toBe('image/png');
    expect(detectImageType(jpeg)).toBe('image/jpeg');
    expect(detectImageType(webp)).toBe('image/webp');
  });

  it('rejects SVG, HTML, GIF, RIFF that is not WebP and empty files', () => {
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'latin1'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    expect(detectImageType(png.subarray(0, 4))).toBeNull();
  });

  it('cleans file names', () => {
    expect(safeAttachmentFilename('C:\\fakepath\\captura.png', 'image/png')).toBe('captura.png');
    expect(safeAttachmentFilename('../../etc/"x"\r\n.png', 'image/png')).toBe('x.png');
    expect(safeAttachmentFilename('', 'image/webp')).toBe('imagen.webp');
    expect(safeAttachmentFilename(undefined, 'image/jpeg')).toBe('imagen.jpg');
  });
});

describe('operation views', () => {
  it('translates an event to the generic shape without payload or audit', () => {
    const view = toEventView({
      _id: 'e1',
      eventType: 'createQuotation',
      status: 'sap_created_hubspot_error',
      retries: 2,
      maxRetries: 3,
      lastError: 'boom',
      payload: { deal: { hs_object_id: 123 } },
      sapAudit: { secret: true },
      createdAt: new Date('2026-10-10T14:00:00Z'),
      updatedAt: new Date('2026-10-10T14:06:00Z'),
    });

    expect(view).toEqual({
      id: 'e1',
      type: 'createQuotation',
      status: 'destination_created_origin_error',
      retries: 2,
      maxRetries: 3,
      lastError: 'boom',
      cause: { key: 'other', label: 'Otro error', group: 'other' },
      reference: '123',
      createdAt: '2026-10-10T14:00:00.000Z',
      updatedAt: '2026-10-10T14:06:00.000Z',
    });
  });

  it('hides quality reports', () => {
    expect(toEventView({ _id: 'r1', status: 'report' })).toBeNull();
  });

  it('translates a running sync with its task', () => {
    const view = toSyncView(
      { _id: 's1', clientConfigId: 'c1', objectType: 'Product', status: null, recordsProcessed: 3, sent: 2, failed: 1, updated: 0, skipped: 0, skippedReasons: [], errors: [{ x: 1 }], startedAt: new Date('2026-10-10T06:00:00Z') },
      { _id: 'c1', clientName: 'Productos', taskType: 'SAP_SYNC', apiToken: 'nunca' }
    );

    expect(view).toEqual({
      id: 's1',
      task: { id: 'c1', name: 'Productos', type: 'record_sync' },
      objectType: 'product',
      status: 'running',
      counts: { processed: 3, sent: 2, failed: 1, updated: 0, skipped: 0 },
      skippedReasons: [],
      errorMessage: null,
      startedAt: '2026-10-10T06:00:00.000Z',
      finishedAt: null,
    });
  });
});
