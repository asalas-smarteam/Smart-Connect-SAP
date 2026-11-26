import { jest } from '@jest/globals';
import SapWebhookOrderAdapter from '../../../src/infrastructure/sap/SapWebhookOrderAdapter.js';
import FullMappedBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';

const CUI = '2345678901234';
const CF_NIT = '00000000C.F.';

function notFound() {
  const error = new Error('not found');
  error.response = { status: 404 };
  return error;
}

function buildAdapter({ existing = null } = {}) {
  const adapter = new SapWebhookOrderAdapter();
  adapter.request = jest.fn(async (config, { method, path }) => {
    if (method === 'get' && path.startsWith("/BusinessPartners('")) {
      throw notFound();
    }
    if (method === 'get') {
      return { value: existing ? [existing] : [] };
    }
    return { CardCode: 'CL999' };
  });
  return adapter;
}

const BASE_ARGS = {
  sapConfig: {},
  tenantModels: {},
  company: { hs_object_id: '1', name: 'ACME' },
  contact: null,
  mappedContact: {},
  companyExists: true,
  resolveDefaultPriceListNum: async () => 1,
  resolveRequireRandCardCode: async () => false,
  resolveDefaultSeries: async () => 59,
  resolveDefaultFindSAP: async () => 'FederalTaxID',
  resolveGroupCodeDefaults: async () => null,
};

const filterOf = (adapter) => adapter.request.mock.calls
  .filter(([, o]) => o.method === 'get' && o.path === '/BusinessPartners')
  .map(([, o]) => o.params.$filter);
const postOf = (adapter) => adapter.request.mock.calls.find(([, o]) => o.method === 'post')?.[1];

describe('findOrCreateBusinessPartner with a consumer-final tax id', () => {
  it('looks up by the identity value instead of the placeholder', async () => {
    const adapter = buildAdapter({ existing: { CardCode: 'CL7' } });

    const result = await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: CF_NIT },
      consumerFinalIdentity: CUI,
    });

    expect(filterOf(adapter)).toEqual([`FederalTaxID eq '${CUI}'`]);
    expect(result).toMatchObject({ cardCode: 'CL7', created: false, matchedBy: 'FederalTaxID' });
  });

  it('creates the partner with the identity value in FederalTaxID (legacy strategy)', async () => {
    const adapter = buildAdapter();

    const result = await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: CF_NIT },
      consumerFinalIdentity: CUI,
    });

    expect(postOf(adapter).data.FederalTaxID).toBe(CUI);
    expect(result.created).toBe(true);
  });

  it('creates the partner with the identity value in FederalTaxID (fullMapped strategy)', async () => {
    const adapter = buildAdapter();

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: CF_NIT },
      payloadStrategy: new FullMappedBusinessPartnerPayloadStrategy(),
      creationDefaults: { BusinessPartner: { CardType: 'cCustomer' }, ContactEmployee: {}, BPAddress: {} },
      consumerFinalIdentity: CUI,
    });

    expect(postOf(adapter).data.FederalTaxID).toBe(CUI);
  });

  it('uses the contact tax id when the contact is the partner', async () => {
    const adapter = buildAdapter();

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      companyExists: false,
      contact: { hs_object_id: '2', firstname: 'Ana' },
      mappedCompany: {},
      mappedContact: { CardName: 'Ana', FederalTaxID: 'c.f.' },
      consumerFinalIdentity: CUI,
    });

    expect(filterOf(adapter)).toEqual([`FederalTaxID eq '${CUI}'`]);
    expect(postOf(adapter).data.FederalTaxID).toBe(CUI);
  });

  it('keeps the placeholder when no identity value is available', async () => {
    const adapter = buildAdapter();

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: CF_NIT },
      consumerFinalIdentity: null,
    });

    expect(filterOf(adapter)).toEqual([`FederalTaxID eq '${CF_NIT}'`]);
    expect(postOf(adapter).data.FederalTaxID).toBe(CF_NIT);
  });

  it('behaves as before when the parameter is omitted', async () => {
    const adapter = buildAdapter();

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: CF_NIT },
    });

    expect(filterOf(adapter)).toEqual([`FederalTaxID eq '${CF_NIT}'`]);
    expect(postOf(adapter).data.FederalTaxID).toBe(CF_NIT);
  });

  it('leaves a regular tax id untouched even with an identity value', async () => {
    const adapter = buildAdapter();

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: '1234567-8' },
      consumerFinalIdentity: CUI,
    });

    expect(filterOf(adapter)).toEqual(["FederalTaxID eq '1234567-8'"]);
    expect(postOf(adapter).data.FederalTaxID).toBe('1234567-8');
  });

  it('does not touch the lookup when the default find field is not the tax id', async () => {
    const adapter = buildAdapter();

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      resolveDefaultFindSAP: async () => 'EmailAddress',
      mappedCompany: { CardName: 'ACME', EmailAddress: 'a@b.com', FederalTaxID: CF_NIT },
      consumerFinalIdentity: CUI,
    });

    expect(filterOf(adapter)).toEqual(["EmailAddress eq 'a@b.com'"]);
    // The tax id that gets created is still the placeholder, so the identity replaces it.
    expect(postOf(adapter).data.FederalTaxID).toBe(CUI);
  });

  it('uses a tenant-specific placeholder to trigger the lookup by identity', async () => {
    const adapter = buildAdapter({ existing: { CardCode: 'CL8' } });

    const result = await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: 'CONSUMIDOR-FINAL' },
      consumerFinalIdentity: CUI,
      consumerFinalPlaceholders: ['CONSUMIDORFINAL'],
    });

    expect(filterOf(adapter)).toEqual([`FederalTaxID eq '${CUI}'`]);
    expect(result).toMatchObject({ cardCode: 'CL8', created: false });
  });

  it('does not treat the legacy placeholder as consumer final when custom ones are configured', async () => {
    const adapter = buildAdapter({ existing: { CardCode: 'CL9' } });

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', FederalTaxID: CF_NIT },
      consumerFinalIdentity: CUI,
      consumerFinalPlaceholders: ['CONSUMIDORFINAL'],
    });

    expect(filterOf(adapter)).toEqual([`FederalTaxID eq '${CF_NIT}'`]);
  });
});
