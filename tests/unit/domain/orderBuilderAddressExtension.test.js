import { buildOrderPayload } from '../../../src/domain/orders/order-builder.service.js';

const base = {
  cardCode: 'CL00129',
  documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
};

describe('buildOrderPayload — AddressExtension', () => {
  it('adds AddressExtension to the header when the payload brought one', () => {
    const addressExtension = { BillToStreet: 'Calle 1', ShipToStreet: 'Calle 2', ShipToCountry: 'GT' };

    const payload = buildOrderPayload({ ...base, addressExtension });

    expect(payload.AddressExtension).toEqual(addressExtension);
  });

  it('does not add AddressExtension when it is null, empty or absent', () => {
    expect(buildOrderPayload({ ...base, addressExtension: null })).not.toHaveProperty('AddressExtension');
    expect(buildOrderPayload({ ...base, addressExtension: {} })).not.toHaveProperty('AddressExtension');
    expect(buildOrderPayload(base)).not.toHaveProperty('AddressExtension');
  });
});
