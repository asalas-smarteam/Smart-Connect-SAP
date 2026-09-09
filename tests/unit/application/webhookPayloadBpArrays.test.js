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

describe('resolveEventPayload — coleccion de line items', () => {
  it('acepta lineItems (camelCase), que es como la manda el workflow de conversion a orden', () => {
    const result = resolveEventPayload({
      payload: {
        deal: { hs_object_id: '64836790697' },
        lineItems: [{ hs_object_id: '58786797171', departamento: 'CCD-0004' }],
      },
    });

    expect(result.lineItems).toEqual([{ hs_object_id: '58786797171', departamento: 'CCD-0004' }]);
  });

  it('acepta lineItems tambien bajo payload.data', () => {
    const result = resolveEventPayload({
      payload: { data: { lineItems: [{ hs_object_id: '1' }] } },
    });

    expect(result.lineItems).toEqual([{ hs_object_id: '1' }]);
  });

  it('line_items gana sobre lineItems cuando el workflow manda las dos', () => {
    const result = resolveEventPayload({
      payload: {
        line_items: [{ hubspot_id: 'snake' }],
        lineItems: [{ hs_object_id: 'camel' }],
      },
    });

    expect(result.lineItems).toEqual([{ hubspot_id: 'snake' }]);
  });

  it('devuelve [] cuando no viene ninguna de las dos', () => {
    expect(resolveEventPayload({ payload: { deal: { hs_object_id: '1' } } }).lineItems).toEqual([]);
  });
});
