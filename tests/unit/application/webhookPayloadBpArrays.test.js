import { resolveEventPayload } from '../../../src/application/services/webhook-payload.service.js';

describe('resolveEventPayload — arrays de BusinessPartner', () => {
  it('expone contactEmployees y bpAddress desde payload', () => {
    const result = resolveEventPayload({
      payload: {
        deal: { hs_object_id: '1' },
        company: { hs_object_id: '2' },
        contact: null,
        contactEmployees: [{ hs_object_id: '3' }],
        bpAddress: [{ AddressName: 'factura' }],
        line_items: [],
      },
    });

    expect(result.contactEmployees).toEqual([{ hs_object_id: '3' }]);
    expect(result.bpAddress).toEqual([{ AddressName: 'factura' }]);
  });

  it('los lee tambien desde payload.data', () => {
    const result = resolveEventPayload({
      payload: {
        data: {
          contactEmployees: [{ hs_object_id: '3' }],
          bpAddress: [{ AddressName: 'entrega' }],
        },
      },
    });

    expect(result.contactEmployees).toEqual([{ hs_object_id: '3' }]);
    expect(result.bpAddress).toEqual([{ AddressName: 'entrega' }]);
  });

  it('envuelve un objeto suelto en array', () => {
    const result = resolveEventPayload({
      payload: { contactEmployees: { hs_object_id: '3' } },
    });

    expect(result.contactEmployees).toEqual([{ hs_object_id: '3' }]);
  });

  it('devuelve arrays vacios cuando no vienen (payload legacy)', () => {
    const result = resolveEventPayload({
      payload: { deal: { hs_object_id: '1' }, company: { hs_object_id: '2' } },
    });

    expect(result.contactEmployees).toEqual([]);
    expect(result.bpAddress).toEqual([]);
  });

  it('no rompe los campos que ya devolvia', () => {
    const result = resolveEventPayload({
      payload: {
        deal: { hs_object_id: '1' },
        company: { hs_object_id: '2' },
        contact: { hs_object_id: '3' },
        line_items: [{ hs_object_id: '4' }],
      },
    });

    expect(result.deal).toEqual({ hs_object_id: '1' });
    expect(result.company).toEqual({ hs_object_id: '2' });
    expect(result.contact).toEqual({ hs_object_id: '3' });
    expect(result.lineItems).toEqual([{ hs_object_id: '4' }]);
  });
});
