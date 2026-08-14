import { buildWebhookSapAudit } from '../../../src/infrastructure/sync/syncLog.service.js';

describe('buildWebhookSapAudit', () => {
  it('returns null when the audit trail has no SAP or HubSpot activity', () => {
    const auditTrail = {
      payload_Hubspot: { deal: {} },
      payload_SAP: { businessPartner: null, contactEmployee: null, quotation: null },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, quotation: null },
    };

    expect(buildWebhookSapAudit(auditTrail)).toBeNull();
  });

  it('returns null for a null or undefined audit trail', () => {
    expect(buildWebhookSapAudit(null)).toBeNull();
    expect(buildWebhookSapAudit(undefined)).toBeNull();
  });

  it('captures business partner, contact employee and document request/response', () => {
    const auditTrail = {
      payload_Hubspot: { deal: { hs_object_id: '1' } },
      payload_SAP: {
        businessPartner: { CardCode: 'CL001', CardName: 'Acme' },
        contactEmployee: { Name: 'Jane' },
        order: { CardCode: 'CL001', DocumentLines: [{ ItemCode: 'A1' }] },
      },
      response_hubspot: { deal: { ok: true } },
      response_SAP: {
        businessPartner: { CardCode: 'CL001' },
        contactEmployee: { InternalCode: 5 },
        order: { DocEntry: 10, DocNum: 20 },
      },
    };

    const result = buildWebhookSapAudit(auditTrail);

    expect(result).toEqual({
      payloadSap: {
        businessPartner: { CardCode: 'CL001', CardName: 'Acme' },
        contactEmployee: { Name: 'Jane' },
        order: { CardCode: 'CL001', DocumentLines: [{ ItemCode: 'A1' }] },
      },
      responseSap: {
        businessPartner: { CardCode: 'CL001' },
        contactEmployee: { InternalCode: 5 },
        order: { DocEntry: 10, DocNum: 20 },
      },
      sapCalls: [],
      skipped: null,
      responseHubspot: { deal: { ok: true } },
      responseHubspotContactEmployees: null,
      capturedAt: expect.any(String),
    });
    expect(() => new Date(result.capturedAt).toISOString()).not.toThrow();
  });

  it('captures the ContactEmployee write-back response under responseHubspotContactEmployees', () => {
    const auditTrail = {
      payload_Hubspot: { deal: { hs_object_id: '1' } },
      payload_SAP: {
        businessPartner: { CardCode: 'CL001' },
        contactEmployee: null,
        order: null,
      },
      response_hubspot: { deal: { ok: true } },
      response_hubspot_contactEmployees: [
        { id: '10' },
        { id: '20' },
      ],
      response_SAP: {
        businessPartner: { CardCode: 'CL001' },
        contactEmployee: null,
        order: null,
      },
    };

    const result = buildWebhookSapAudit(auditTrail);

    expect(result.responseHubspotContactEmployees).toEqual([
      { id: '10' },
      { id: '20' },
    ]);
  });

  it('omits keys that do not apply to this event type instead of inventing them', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, quotation: { CardCode: 'CL001' } },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, quotation: { DocEntry: 1 } },
    };

    const result = buildWebhookSapAudit(auditTrail);

    expect(result.payloadSap).not.toHaveProperty('order');
    expect(result.payloadSap.quotation).toEqual({ CardCode: 'CL001' });
  });

  it('degrades a circular SAP response to a string instead of throwing', () => {
    const circular = { CardCode: 'CL001' };
    circular.self = circular;
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, order: { CardCode: 'CL001' } },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, order: circular },
    };

    expect(() => buildWebhookSapAudit(auditTrail)).not.toThrow();
    const result = buildWebhookSapAudit(auditTrail);
    expect(result).not.toBeNull();
    expect(typeof result.responseSap.order).toBe('string');
  });

  it('returns a real record when only the HubSpot response has content', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, order: null },
      response_hubspot: { deal: { ok: true } },
      response_SAP: { businessPartner: null, contactEmployee: null, order: null },
    };

    expect(buildWebhookSapAudit(auditTrail)).not.toBeNull();
  });

  // GUARDIA DE NO-REGRESION DEL FALLO REAL: Mongo rechazo el $set completo con
  // "The dollar ($) prefixed field '$select' in 'sapAudit.sapCalls.0.params.$select' is not
  // valid for storage", y con el se perdieron status y lastError del evento. Nada de lo que
  // devuelve esta funcion puede llevar una clave que Mongo no acepte.
  describe('claves que Mongo no acepta', () => {
    function collectKeys(value, keys = []) {
      if (Array.isArray(value)) {
        value.forEach((entry) => collectKeys(entry, keys));
        return keys;
      }

      if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          keys.push(key);
          collectKeys(nested, keys);
        }
      }

      return keys;
    }

    const auditTrail = {
      payload_SAP: { businessPartner: { '$weird': 1, 'a.b': 2 }, order: null },
      response_SAP: { businessPartner: null, order: null },
      response_hubspot: { deal: { '$hubspot': true } },
      response_hubspot_contactEmployees: [{ 'con.punto': 1 }],
      sapCalls: [
        {
          method: 'GET',
          path: '/BusinessPartners',
          params: { $top: 1, $select: 'CardCode,CardName', $filter: "EmailAddress eq 'a@b.com'" },
          ok: true,
          response: { value: [], '$raro': 1 },
        },
      ],
    };

    it('no emite ninguna clave con $ al inicio ni con punto', () => {
      const keys = collectKeys(buildWebhookSapAudit(auditTrail));

      expect(keys.filter((key) => key.startsWith('$'))).toEqual([]);
      expect(keys.filter((key) => key.includes('.'))).toEqual([]);
    });

    it('aplana los params de OData en un query string legible', () => {
      const [call] = buildWebhookSapAudit(auditTrail).sapCalls;

      expect(call.params).toBe("$top=1&$select=CardCode,CardName&$filter=EmailAddress eq 'a@b.com'");
    });
  });

  // El agujero que dejaba sapAudit en null: si la primera llamada a SAP lanza, el use case
  // nunca llega a escribir payload_SAP/response_SAP, asi que sapCalls es lo unico que queda.
  it('returns a real record when the only evidence is the SAP call that failed', () => {
    const sapError = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            message: { lang: 'es-GT', value: '(1) SP - ERROR - el subgrupo NO es valido para este cliente.' },
          },
        },
      },
    });
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, order: null },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, order: null },
      sapCalls: [
        {
          method: 'POST',
          path: '/BusinessPartners',
          params: null,
          request: { CardCode: 'CDany', CardName: 'Dany Sec', GroupCode: 105 },
          ok: false,
          status: 400,
          error: sapError,
          durationMs: 42,
        },
      ],
    };

    const result = buildWebhookSapAudit(auditTrail);

    expect(result).not.toBeNull();
    expect(result.sapCalls).toEqual([
      {
        method: 'POST',
        path: '/BusinessPartners',
        params: null,
        request: { CardCode: 'CDany', CardName: 'Dany Sec', GroupCode: 105 },
        ok: false,
        status: 400,
        durationMs: 42,
        error: expect.objectContaining({
          message: '(1) SP - ERROR - el subgrupo NO es valido para este cliente.',
          status: 400,
        }),
      },
    ]);
    // `response` no aplica a una llamada fallida: no se inventa la clave.
    expect(result.sapCalls[0]).not.toHaveProperty('response');
  });

  // Sin esto, un evento saltado por idempotencia guarda sapAudit: null, que se lee igual que
  // "la auditoria se rompio". Tiene que quedar dicho que no se mando nada a SAP y por que.
  it('returns a record stating the run was skipped, even with no SAP traffic at all', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, quotation: null },
      response_SAP: { businessPartner: null, quotation: null },
      response_hubspot: null,
      sapCalls: [],
      skipped: { reason: 'quotation_already_exists', sapDocEntry: 12345, sapDocNum: 8001 },
    };

    const result = buildWebhookSapAudit(auditTrail);

    expect(result).not.toBeNull();
    expect(result.skipped).toEqual({
      reason: 'quotation_already_exists',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
    expect(result.sapCalls).toEqual([]);
  });

  it('leaves skipped as null when the run really did talk to SAP', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, order: { CardCode: 'CL001' } },
      response_SAP: { businessPartner: null, order: null },
      response_hubspot: null,
    };

    expect(buildWebhookSapAudit(auditTrail).skipped).toBeNull();
  });

  it('defaults sapCalls to an empty array for audit trails that predate it', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, order: { CardCode: 'CL001' } },
      response_hubspot: null,
      response_SAP: { businessPartner: null, contactEmployee: null, order: null },
    };

    expect(buildWebhookSapAudit(auditTrail).sapCalls).toEqual([]);
  });

  it('truncates a recorded body that is too large to persist safely', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, order: null },
      response_SAP: { businessPartner: null, order: null },
      response_hubspot: null,
      sapCalls: [
        {
          method: 'GET',
          path: "/BusinessPartners('CL001')",
          ok: true,
          response: { ContactEmployees: Array.from({ length: 4000 }, (_, i) => ({ Name: `Contacto ${i}` })) },
        },
      ],
    };

    const [call] = buildWebhookSapAudit(auditTrail).sapCalls;

    expect(call.response.truncated).toBe(true);
    expect(call.response.originalLength).toBeGreaterThan(20000);
    expect(call.response.preview).toHaveLength(20000);
  });

  it('strips @odata.* annotation keys from recorded SAP call responses too', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, order: null },
      response_SAP: { businessPartner: null, order: null },
      response_hubspot: null,
      sapCalls: [
        {
          method: 'POST',
          path: '/Orders',
          ok: true,
          request: { CardCode: 'CL001' },
          response: { '@odata.etag': 'abc', DocEntry: 10 },
        },
      ],
    };

    const [call] = buildWebhookSapAudit(auditTrail).sapCalls;

    expect(Object.keys(call.response)).not.toContain('@odata.etag');
    expect(call.response.DocEntry).toBe(10);
  });

  it('strips @odata.* annotation keys from SAP responses before persisting', () => {
    const auditTrail = {
      payload_SAP: { businessPartner: null, contactEmployee: null, order: { CardCode: 'CL001' } },
      response_hubspot: null,
      response_SAP: {
        businessPartner: null,
        contactEmployee: null,
        order: {
          '@odata.context': 'https://sap.example.com/b1s/v1/$metadata#Orders/$entity',
          '@odata.etag': 'abc123',
          DocEntry: 10,
          DocumentLines: [{ '@odata.etag': 'line-etag', ItemCode: 'A1' }],
        },
      },
    };

    const result = buildWebhookSapAudit(auditTrail);

    // toHaveProperty('@odata.context') would treat the dot as a path separator and check
    // result.responseSap.order['@odata']['context'], which trivially passes either way --
    // Object.keys is the only way to assert the literal flat key is gone.
    expect(Object.keys(result.responseSap.order)).not.toContain('@odata.context');
    expect(Object.keys(result.responseSap.order)).not.toContain('@odata.etag');
    expect(result.responseSap.order.DocEntry).toBe(10);
    expect(Object.keys(result.responseSap.order.DocumentLines[0])).not.toContain('@odata.etag');
    expect(result.responseSap.order.DocumentLines[0].ItemCode).toBe('A1');
  });
});
