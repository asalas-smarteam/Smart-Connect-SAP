import { jest } from '@jest/globals';
import HubspotPropertyAdapter from '../../../src/infrastructure/hubspot/HubspotPropertyAdapter.js';
import B1DropdownCatalogAdapter from '../../../src/infrastructure/sap/B1DropdownCatalogAdapter.js';
import MongooseDropdownTargetRepository from '../../../src/infrastructure/database/repositories/MongooseDropdownTargetRepository.js';
import DropdownOptionsConfigRepository from '../../../src/infrastructure/config/DropdownOptionsConfigRepository.js';

describe('HubspotPropertyAdapter', () => {
  it('translates the internal objectType to the CRM collection name', async () => {
    const get = jest.fn(async () => ({ name: 'GroupCode', type: 'enumeration' }));
    const adapter = new HubspotPropertyAdapter({ get, patch: jest.fn() });

    await adapter.findProperty({
      accessToken: 'token',
      objectType: 'company',
      propertyName: 'GroupCode',
    });

    expect(get).toHaveBeenCalledWith('token', '/crm/v3/properties/companies/GroupCode');
  });

  it('passes a custom object type id through untouched', async () => {
    const get = jest.fn(async () => ({}));
    const adapter = new HubspotPropertyAdapter({ get, patch: jest.fn() });

    await adapter.findProperty({
      accessToken: 'token',
      objectType: '2-9876543',
      propertyName: 'moneda',
    });

    expect(get).toHaveBeenCalledWith('token', '/crm/v3/properties/2-9876543/moneda');
  });

  it('resolves a 404 to null so a missing property is a decision, not an error', async () => {
    const error = new Error('HubSpot API request failed: 404 Not Found');
    error.details = { status: 404 };
    const adapter = new HubspotPropertyAdapter({
      get: jest.fn(async () => { throw error; }),
      patch: jest.fn(),
    });

    await expect(adapter.findProperty({
      accessToken: 'token',
      objectType: 'company',
      propertyName: 'nope',
    })).resolves.toBeNull();
  });

  it('propagates failures that are not a 404', async () => {
    const error = new Error('HubSpot API request failed: 401 Unauthorized');
    error.details = { status: 401 };
    const adapter = new HubspotPropertyAdapter({
      get: jest.fn(async () => { throw error; }),
      patch: jest.fn(),
    });

    await expect(adapter.findProperty({
      accessToken: 'token',
      objectType: 'company',
      propertyName: 'GroupCode',
    })).rejects.toThrow('401');
  });

  it('PATCHes only the options array', async () => {
    const patch = jest.fn(async () => ({}));
    const adapter = new HubspotPropertyAdapter({ get: jest.fn(), patch });
    const options = [{ label: 'Nacional', value: '100', displayOrder: 0, hidden: false }];

    await adapter.updatePropertyOptions({
      accessToken: 'token',
      objectType: 'contact',
      propertyName: 'pay_terms',
      options,
    });

    expect(patch).toHaveBeenCalledWith(
      'token',
      '/crm/v3/properties/contacts/pay_terms',
      { options }
    );
  });

  it('requires an object type and a property name', () => {
    const adapter = new HubspotPropertyAdapter({ get: jest.fn(), patch: jest.fn() });

    expect(() => adapter.buildPropertyPath({ objectType: '', propertyName: 'x' }))
      .toThrow('objectType is required');
    expect(() => adapter.buildPropertyPath({ objectType: 'company', propertyName: '  ' }))
      .toThrow('propertyName is required');
  });
});

describe('B1DropdownCatalogAdapter', () => {
  function buildTenantContext(credentials = [{ serviceLayerBaseUrl: 'https://sap:50000' }]) {
    return {
      tenantKey: 'tenant-1',
      tenantModels: {
        SapCredentials: { find: () => ({ lean: async () => credentials }) },
      },
    };
  }

  it('encodes OData query values, which the transport forwards untouched', async () => {
    const fetchAll = jest.fn(async () => [{ Code: '100' }]);
    const adapter = new B1DropdownCatalogAdapter({ createTransport: () => ({ fetchAll }) });

    const rows = await adapter.fetchRows({
      tenantContext: buildTenantContext(),
      serviceLayerPath: '/UserFieldsMD',
      query: { $filter: "TableName eq 'OCRD'" },
    });

    expect(fetchAll).toHaveBeenCalledWith({
      path: '/UserFieldsMD',
      // Spaces are encoded, the apostrophe is left alone -- same treatment
      // serviceLayerUrlBuilder gives a $filter, and valid in a URL either way.
      query: { $filter: "TableName%20eq%20'OCRD'" },
    });
    expect(rows).toEqual([{ Code: '100' }]);
  });

  it('builds the transport from the tenant SAP credentials', async () => {
    const createTransport = jest.fn(() => ({ fetchAll: async () => [] }));
    const adapter = new B1DropdownCatalogAdapter({ createTransport });

    await adapter.fetchRows({
      tenantContext: buildTenantContext([{ serviceLayerBaseUrl: 'https://sap:50000', companyDB: 'SBO' }]),
      serviceLayerPath: '/Currencies',
    });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      serviceLayerBaseUrl: 'https://sap:50000',
      companyDB: 'SBO',
      tenantKey: 'tenant-1',
    }));
  });

  it('fails clearly when the tenant has no SAP credentials', async () => {
    const adapter = new B1DropdownCatalogAdapter({ createTransport: () => ({ fetchAll: async () => [] }) });

    await expect(adapter.fetchRows({
      tenantContext: buildTenantContext([]),
      serviceLayerPath: '/Currencies',
    })).rejects.toThrow('SAP credentials not found');
  });

  it('requires a serviceLayerPath', async () => {
    const adapter = new B1DropdownCatalogAdapter({ createTransport: () => ({ fetchAll: async () => [] }) });

    await expect(adapter.fetchRows({ tenantContext: buildTenantContext() }))
      .rejects.toThrow('serviceLayerPath is required');
  });
});

describe('MongooseDropdownTargetRepository', () => {
  function buildTenantContext(mappings) {
    const find = jest.fn(() => ({ sort: () => ({ lean: async () => mappings }) }));
    return {
      context: { tenantModels: { FieldMapping: { find } } },
      find,
    };
  }

  it('returns one target per objectType that maps the field', async () => {
    const { context, find } = buildTenantContext([
      { sourceField: 'PayTermsGrpCode', objectType: 'company', targetField: 'PayTermsGrpCode', sourceContext: 'businessPartner' },
      { sourceField: 'PayTermsGrpCode', objectType: 'contact', targetField: 'pay_terms', sourceContext: 'contactEmployee' },
    ]);
    const repository = new MongooseDropdownTargetRepository();

    const targets = await repository.findTargetsBySourceFields({
      tenantContext: context,
      hubspotCredentialId: 'cred-1',
      sourceFields: ['PayTermsGrpCode'],
    });

    expect(find).toHaveBeenCalledWith({
      hubspotCredentialId: 'cred-1',
      sourceField: { $in: ['PayTermsGrpCode'] },
      isActive: true,
    });
    expect(targets).toEqual([
      { sourceField: 'PayTermsGrpCode', objectType: 'company', targetField: 'PayTermsGrpCode', sourceContext: 'businessPartner' },
      { sourceField: 'PayTermsGrpCode', objectType: 'contact', targetField: 'pay_terms', sourceContext: 'contactEmployee' },
    ]);
  });

  it('collapses the same property mapped from two sourceContexts', async () => {
    const { context } = buildTenantContext([
      { sourceField: 'GroupCode', objectType: 'company', targetField: 'GroupCode', sourceContext: 'businessPartner' },
      { sourceField: 'GroupCode', objectType: 'company', targetField: 'GroupCode', sourceContext: 'contactEmployee' },
    ]);
    const repository = new MongooseDropdownTargetRepository();

    const targets = await repository.findTargetsBySourceFields({
      tenantContext: context,
      hubspotCredentialId: 'cred-1',
      sourceFields: ['GroupCode'],
    });

    expect(targets).toHaveLength(1);
  });

  it('drops mappings missing an objectType or targetField', async () => {
    const { context } = buildTenantContext([
      { sourceField: 'GroupCode', objectType: '', targetField: 'GroupCode' },
      { sourceField: 'GroupCode', objectType: 'company', targetField: '' },
    ]);
    const repository = new MongooseDropdownTargetRepository();

    await expect(repository.findTargetsBySourceFields({
      tenantContext: context,
      hubspotCredentialId: 'cred-1',
      sourceFields: ['GroupCode'],
    })).resolves.toEqual([]);
  });

  it('short-circuits with no fields and requires a credential otherwise', async () => {
    const { context } = buildTenantContext([]);
    const repository = new MongooseDropdownTargetRepository();

    await expect(repository.findTargetsBySourceFields({
      tenantContext: context,
      sourceFields: [],
    })).resolves.toEqual([]);

    await expect(repository.findTargetsBySourceFields({
      tenantContext: context,
      sourceFields: ['GroupCode'],
    })).rejects.toThrow('hubspotCredentialId is required');
  });
});

describe('DropdownOptionsConfigRepository', () => {
  it('reads the dropdownOptionsSync key and normalizes it', async () => {
    const findOne = jest.fn(() => ({
      lean: async () => ({
        value: {
          enabled: true,
          sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
        },
      }),
    }));
    const repository = new DropdownOptionsConfigRepository();

    const config = await repository.getDropdownOptionsConfig({
      tenantContext: { tenantModels: { Configuration: { findOne } } },
    });

    expect(findOne).toHaveBeenCalledWith({ key: 'dropdownOptionsSync' });
    expect(config.enabled).toBe(true);
    expect(config.sources[0].serviceLayerPath).toBe('/Currencies');
  });

  it('is disabled when the tenant has no such configuration document', async () => {
    const repository = new DropdownOptionsConfigRepository();

    const config = await repository.getDropdownOptionsConfig({
      tenantContext: { tenantModels: { Configuration: { findOne: () => ({ lean: async () => null }) } } },
    });

    expect(config).toEqual({ enabled: false, sources: [], invalidSources: [] });
  });

  it('is disabled when there is no Configuration model at all', async () => {
    const repository = new DropdownOptionsConfigRepository();

    await expect(repository.getDropdownOptionsConfig({ tenantContext: {} }))
      .resolves.toEqual({ enabled: false, sources: [], invalidSources: [] });
  });
});
