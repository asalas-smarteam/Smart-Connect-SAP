import { buildExchange, exchangeView, isHiddenKey, sanitizeForClient } from '../../../src/domain/panel/exchangeView.js';

// Forma del Excel de errores pendientes de Printer (columnas Recibido / Enviado / Respuesta).
const raw = {
  payload: { portalId: '50082681', deal: { dealname: 'Renta', address: '7ma. avenida 6-53 Zona 4' }, line_items: [] },
  sapAudit: {
    payloadSap: { businessPartner: null, contactEmployee: [], quotation: { Address: '7ma. avenida 6-53 Zona 4', Comments: 'ver https://intra.local/x' } },
    responseSap: {
      businessPartner: {
        matchedBy: 'cardCode',
        businessPartner: {
          CardCode: 'CLO017007',
          EmailAddress: 'mperezmt@gmail.com',
          ContactEmployees: [{ Name: 'Mario', E_Mail: 'mario@cliente.com', Password: '12017' }],
        },
      },
      error: { message: 'connect ETIMEDOUT 18.213.238.80:443' },
    },
    sapCalls: [{ path: '/b1s/v1/Quotations', ok: false }],
  },
};

describe('exchange (plan 5c, H1)', () => {
  it('builds received, sent and response from payload and the audit', () => {
    expect(buildExchange(raw)).toEqual({ received: raw.payload, sent: raw.sapAudit.payloadSap, response: raw.sapAudit.responseSap });
    expect(buildExchange({ payload: { deal: {} } })).toEqual({ received: { deal: {} }, sent: null, response: null });
    expect(buildExchange({})).toBeNull();
  });

  it('gives Smarteam the exchange untouched', () => {
    const view = exchangeView(raw, { side: 'smarteam' });
    expect(view.response.businessPartner.businessPartner.ContactEmployees[0].Password).toBe('12017');
  });

  it('removes credentials at any depth for the client and keeps business data', () => {
    const view = exchangeView(raw);

    expect(JSON.stringify(view)).not.toContain('12017');
    expect(JSON.stringify(view)).not.toMatch(/"Password"/);
    expect(view.response.businessPartner.businessPartner.ContactEmployees[0]).toEqual({ Name: 'Mario', E_Mail: 'mario@cliente.com' });
    expect(view.response.businessPartner.businessPartner.EmailAddress).toBe('mperezmt@gmail.com');
    expect(view.sent.quotation.Address).toBe('7ma. avenida 6-53 Zona 4');
    expect(view.sent.quotation.Comments).toBe('ver [enlace]');
    expect(view.response.error.message).toBe('connect ETIMEDOUT [servidor]');
    expect(view.received).toEqual(raw.payload);
    expect(raw.sapAudit.responseSap.businessPartner.businessPartner.ContactEmployees[0].Password).toBe('12017');
  });

  it.each([
    'Password', 'password', 'DBPassword', 'passwd', 'pwd', 'PIN', 'token', 'accessToken', 'refresh_token', 'secret',
    'clientSecret', 'apiKey', 'api_key', 'Authorization', 'auth', 'Cookie', 'session', 'SessionId', 'credentials',
    'privateKey', 'sapCalls', 'path', 'URL', 'uri', 'endpoint', 'host', 'hostname', 'baseUrl', 'serviceLayerUrl',
    '@odata.context', 'odata.metadata',
  ])('hides %s', (key) => {
    expect(isHiddenKey(key)).toBe(true);
    expect(sanitizeForClient({ [key]: 'x', keep: 1 })).toEqual({ keep: 1 });
  });

  it.each(['CardCode', 'EmailAddress', 'Address', 'Author', 'Pinned', 'Passport'])('keeps %s', (key) => {
    expect(isHiddenKey(key)).toBe(false);
  });

  it('cuts very deep documents, long texts and huge arrays', () => {
    let deep = { leaf: 'x' };
    for (let index = 0; index < 30; index += 1) {
      deep = { next: deep };
    }
    expect(JSON.stringify(sanitizeForClient(deep))).toContain('[…]');
    expect(sanitizeForClient('a'.repeat(6000))).toHaveLength(5000 + 3);
    expect(sanitizeForClient(Array.from({ length: 1200 }, () => 1))).toHaveLength(1001);
    expect(sanitizeForClient(new Date('2026-10-14T00:00:00Z'))).toBe('2026-10-14T00:00:00.000Z');
  });
});
