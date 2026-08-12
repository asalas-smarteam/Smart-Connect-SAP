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
