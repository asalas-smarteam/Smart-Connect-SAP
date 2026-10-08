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

describe('resolveEventPayload — addressExtension', () => {
  it('exposes the addressExtension object from payload', () => {
    const result = resolveEventPayload({
      payload: { addressExtension: { billing_street: 'Calle 1', zip: '01010' } },
    });

    expect(result.addressExtension).toEqual({ billing_street: 'Calle 1', zip: '01010' });
  });

  it('reads it from payload.data too', () => {
    const result = resolveEventPayload({
      payload: { data: { addressExtension: { shipping_street: 'Calle 2' } } },
    });

    expect(result.addressExtension).toEqual({ shipping_street: 'Calle 2' });
  });

  it('is null when the workflow does not send it (legacy payload)', () => {
    const result = resolveEventPayload({ payload: { deal: { hs_object_id: '1' } } });

    expect(result.addressExtension).toBeNull();
  });

  // Not normalized here on purpose: buildAddressExtension rejects a malformed value inside the
  // use case's try block, where the failure keeps its audit trail. Coercing it to null here would
  // hide the workflow bug.
  it('passes a malformed value through untouched so the domain can reject it', () => {
    expect(resolveEventPayload({ payload: { addressExtension: [] } }).addressExtension).toEqual([]);
    expect(resolveEventPayload({ payload: { addressExtension: 'x' } }).addressExtension).toBe('x');
    expect(resolveEventPayload({ payload: { addressExtension: '' } }).addressExtension).toBe('');
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
