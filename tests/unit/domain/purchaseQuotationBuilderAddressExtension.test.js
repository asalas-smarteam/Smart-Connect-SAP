import { buildPurchaseQuotationPayload } from '../../../src/domain/purchases/purchase-quotation-builder.service.js';

const base = {
  mappedDealFields: { CardCode: 'PR000123' },
  documentLines: [{ ItemCode: 'A01', Quantity: 1 }],
};

describe('buildPurchaseQuotationPayload — AddressExtension', () => {
  it('adds AddressExtension to the header when the payload brought one', () => {
    const addressExtension = { BillToStreet: 'Calle 1', ShipToStreet: 'Calle 2', ShipToCountry: 'GT' };

    const payload = buildPurchaseQuotationPayload({ ...base, addressExtension });

    expect(payload.AddressExtension).toEqual(addressExtension);
  });

  it('does not add AddressExtension when it is null, empty or absent', () => {
    expect(buildPurchaseQuotationPayload({ ...base, addressExtension: null }))
      .not.toHaveProperty('AddressExtension');
    expect(buildPurchaseQuotationPayload({ ...base, addressExtension: {} }))
      .not.toHaveProperty('AddressExtension');
    expect(buildPurchaseQuotationPayload(base)).not.toHaveProperty('AddressExtension');
  });
});
