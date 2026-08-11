import { jest } from '@jest/globals';
import { SapWebhookOrderAdapter } from '#infrastructure/sap/SapWebhookOrderAdapter.js';

const NO_UPSERT_CONFIG = { required: false, fieldsUpdated_BP: [], fieldsUpdated_CE: [] };

function buildRequestSpy(adapter, { getResponse, patchResponse } = {}) {
  return jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, { method }) => {
    if (method === 'patch') {
      return patchResponse ?? {};
    }
    return getResponse ?? {};
  });
}

describe('SapWebhookOrderAdapter.updateBusinessPartnerFields', () => {
  it('does nothing when there are no fields configured', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = buildRequestSpy(adapter);

    const result = await adapter.updateBusinessPartnerFields({
      sapConfig: {},
      cardCode: 'CL001',
      fields: [],
      mappedCompany: { EmailAddress: 'new@b.com' },
      mappedContact: {},
    });

    expect(result).toEqual({ updated: false, requestPayload: null, responsePayload: null });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('reads the current BusinessPartner and PATCHes only the fields that differ', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = buildRequestSpy(adapter, {
      getResponse: { CardCode: 'CL001', EmailAddress: 'old@b.com', CardName: 'Acme' },
      patchResponse: {},
    });

    const result = await adapter.updateBusinessPartnerFields({
      sapConfig: {},
      cardCode: 'CL001',
      fields: ['EmailAddress', 'CardName'],
      mappedCompany: { EmailAddress: 'new@b.com', CardName: 'Acme' },
      mappedContact: {},
    });

    const getCall = requestSpy.mock.calls.find(([, options]) => options.method === 'get');
    expect(getCall[1].path).toBe("/BusinessPartners('CL001')");
    expect(getCall[1].params.$select).toBe('CardCode,EmailAddress,CardName');

    const patchCall = requestSpy.mock.calls.find(([, options]) => options.method === 'patch');
    expect(patchCall[1].path).toBe("/BusinessPartners('CL001')");
    expect(patchCall[1].data).toEqual({ EmailAddress: 'new@b.com' });

    expect(result.updated).toBe(true);
    expect(result.requestPayload).toEqual({ EmailAddress: 'new@b.com' });
  });

  it('does not PATCH when nothing differs', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = buildRequestSpy(adapter, {
      getResponse: { CardCode: 'CL001', EmailAddress: 'same@b.com' },
    });

    const result = await adapter.updateBusinessPartnerFields({
      sapConfig: {},
      cardCode: 'CL001',
      fields: ['EmailAddress'],
      mappedCompany: { EmailAddress: 'same@b.com' },
      mappedContact: {},
    });

    expect(result).toEqual({ updated: false, requestPayload: null, responsePayload: null });
    expect(requestSpy.mock.calls.some(([, options]) => options.method === 'patch')).toBe(false);
  });

  it('swallows SAP errors and reports updated:false instead of throwing', async () => {
    const adapter = new SapWebhookOrderAdapter();
    jest.spyOn(adapter, 'request').mockRejectedValue(new Error('SAP is down'));

    const result = await adapter.updateBusinessPartnerFields({
      sapConfig: {},
      cardCode: 'CL001',
      fields: ['EmailAddress'],
      mappedCompany: { EmailAddress: 'new@b.com' },
      mappedContact: {},
    });

    expect(result.updated).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe('SapWebhookOrderAdapter.findOrCreateBusinessPartner upsert hook', () => {
  it('does not call updateBusinessPartnerFields when upsertConfig.required is false (matched by cardCode)', async () => {
    const adapter = new SapWebhookOrderAdapter();
    jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, { method }) => {
      if (method === 'get') {
        return { CardCode: 'CL001', EmailAddress: 'old@b.com' };
      }
      return {};
    });
    const updateSpy = jest.spyOn(adapter, 'updateBusinessPartnerFields');

    const result = await adapter.findOrCreateBusinessPartner({
      sapConfig: {},
      tenantModels: {},
      company: {},
      contact: null,
      mappedCompany: { CardCode: 'CL001', EmailAddress: 'new@b.com' },
      mappedContact: {},
      companyExists: true,
      resolveDefaultPriceListNum: async () => 1,
      upsertConfig: NO_UPSERT_CONFIG,
    });

    expect(result.matchedBy).toBe('cardCode');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('calls updateBusinessPartnerFields when matched by cardCode and upsert is required', async () => {
    const adapter = new SapWebhookOrderAdapter();
    jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, { method, path }) => {
      if (method === 'get' && path === "/BusinessPartners('CL001')") {
        return { CardCode: 'CL001', EmailAddress: 'old@b.com' };
      }
      return {};
    });

    const result = await adapter.findOrCreateBusinessPartner({
      sapConfig: {},
      tenantModels: {},
      company: {},
      contact: null,
      mappedCompany: { CardCode: 'CL001', EmailAddress: 'new@b.com' },
      mappedContact: {},
      companyExists: true,
      resolveDefaultPriceListNum: async () => 1,
      upsertConfig: { required: true, fieldsUpdated_BP: ['EmailAddress'], fieldsUpdated_CE: [] },
    });

    expect(result.matchedBy).toBe('cardCode');
    expect(result.updateResult.updated).toBe(true);
    expect(result.updateResult.requestPayload).toEqual({ EmailAddress: 'new@b.com' });
  });

  it('calls updateBusinessPartnerFields when matched by the configurable default field', async () => {
    const adapter = new SapWebhookOrderAdapter();
    jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, { method, path, params }) => {
      if (method === 'get' && path === '/BusinessPartners') {
        return { value: [{ CardCode: 'CL777', EmailAddress: 'old@b.com' }] };
      }
      if (method === 'get' && path === "/BusinessPartners('CL777')") {
        return { CardCode: 'CL777', EmailAddress: 'old@b.com', CardName: 'Acme' };
      }
      return {};
    });

    const result = await adapter.findOrCreateBusinessPartner({
      sapConfig: {},
      tenantModels: {},
      company: {},
      contact: null,
      mappedCompany: { EmailAddress: 'new@b.com' },
      mappedContact: {},
      companyExists: true,
      resolveDefaultPriceListNum: async () => 1,
      resolveDefaultFindSAP: async () => 'EmailAddress',
      upsertConfig: { required: true, fieldsUpdated_BP: ['EmailAddress'], fieldsUpdated_CE: [] },
    });

    expect(result.matchedBy).toBe('EmailAddress');
    expect(result.cardCode).toBe('CL777');
    expect(result.updateResult.updated).toBe(true);
    expect(result.updateResult.requestPayload).toEqual({ EmailAddress: 'new@b.com' });
  });

  it('does not call updateBusinessPartnerFields on the creation path', async () => {
    const adapter = new SapWebhookOrderAdapter();
    jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, { method }) => {
      if (method === 'get') {
        return null;
      }
      if (method === 'post') {
        return { CardCode: 'CL999' };
      }
      return {};
    });
    const updateSpy = jest.spyOn(adapter, 'updateBusinessPartnerFields');

    const result = await adapter.findOrCreateBusinessPartner({
      sapConfig: {},
      tenantModels: {},
      company: { name: 'Acme' },
      contact: null,
      mappedCompany: {},
      mappedContact: {},
      companyExists: true,
      resolveDefaultPriceListNum: async () => 1,
      upsertConfig: { required: true, fieldsUpdated_BP: ['EmailAddress'], fieldsUpdated_CE: [] },
    });

    expect(result.created).toBe(true);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
