import {
  S4SalesDocumentConfigRepository,
  S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY,
  S4_SALES_DOCUMENT_CONFIG_KEY,
} from '../../../src/infrastructure/config/S4SalesDocumentConfigRepository.js';

function buildTenantModels(documentsByKey) {
  return {
    Configuration: {
      findOne: ({ key }) => ({ lean: async () => (documentsByKey[key] ?? null) }),
    },
  };
}

describe('S4SalesDocumentConfigRepository', () => {
  const repository = new S4SalesDocumentConfigRepository();

  it('lee la config de documento de venta', async () => {
    const tenantModels = buildTenantModels({
      [S4_SALES_DOCUMENT_CONFIG_KEY]: {
        value: {
          quotationType: 'ZPQD',
          salesOrganization: 'MQGT',
          distributionChannel: '01',
          division: '00',
          salesPersonPartnerFunction: 'VE',
          priceConditionType: null,
        },
      },
    });

    await expect(repository.getSalesDocumentConfig({ tenantModels })).resolves.toEqual({
      quotationType: 'ZPQD',
      salesOrganization: 'MQGT',
      distributionChannel: '01',
      division: '00',
      salesPersonPartnerFunction: 'VE',
      priceConditionType: null,
    });
  });

  // Un tenant sin la llave tiene que recibir todo en null, no undefined ni {}: el builder
  // distingue "no configurado" de "configurado vacío" para decidir si tira o si omite.
  it('devuelve todo en null cuando la llave no existe', async () => {
    await expect(
      repository.getSalesDocumentConfig({ tenantModels: buildTenantModels({}) })
    ).resolves.toEqual({
      quotationType: null,
      salesOrganization: null,
      distributionChannel: null,
      division: null,
      salesPersonPartnerFunction: null,
      priceConditionType: null,
    });
  });

  it('normaliza cadenas vacías y valores no string a null', async () => {
    const tenantModels = buildTenantModels({
      [S4_SALES_DOCUMENT_CONFIG_KEY]: {
        value: { quotationType: '  ', salesOrganization: 42, division: ' 00 ' },
      },
    });

    const config = await repository.getSalesDocumentConfig({ tenantModels });
    expect(config.quotationType).toBeNull();
    expect(config.salesOrganization).toBe('42');
    expect(config.division).toBe('00');
  });

  it('lee la config de creación de cliente con sus defaults por sub-entidad', async () => {
    const tenantModels = buildTenantModels({
      [S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY]: {
        value: {
          findFallbackField: 'to_Customer.BPTaxLongNumber',
          defaults: {
            BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
            BusinessPartnerRole: ['FLCU00', 'FLCU01'],
            Customer: { CustomerAccountGroup: 'ZC01' },
            CustomerCompany: { CompanyCode: '1000', ReconciliationAccount: '0012100000' },
            CustomerSalesArea: { Currency: 'GTQ', PriceListType: 'ZC' },
          },
        },
      },
    });

    await expect(repository.getBusinessPartnerCreationConfig({ tenantModels })).resolves.toEqual({
      findFallbackField: 'to_Customer.BPTaxLongNumber',
      defaults: {
        BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
        BusinessPartnerRole: ['FLCU00', 'FLCU01'],
        Customer: { CustomerAccountGroup: 'ZC01' },
        CustomerCompany: { CompanyCode: '1000', ReconciliationAccount: '0012100000' },
        CustomerSalesArea: { Currency: 'GTQ', PriceListType: 'ZC' },
      },
    });
  });

  it('devuelve defaults vacíos cuando la llave de creación no existe', async () => {
    await expect(
      repository.getBusinessPartnerCreationConfig({ tenantModels: buildTenantModels({}) })
    ).resolves.toEqual({
      findFallbackField: null,
      defaults: {
        BusinessPartner: {},
        BusinessPartnerRole: [],
        Customer: {},
        CustomerCompany: {},
        CustomerSalesArea: {},
      },
    });
  });

  // Misma conducta que BusinessPartnerCreationConfigRepository: una config ilegible significa
  // "usá los defaults", nunca tumbar el webhook.
  it('no lanza cuando la lectura revienta (getSalesDocumentConfig)', async () => {
    const tenantModels = {
      Configuration: { findOne: () => { throw new Error('mongo caído'); } },
    };

    const config = await repository.getSalesDocumentConfig({ tenantModels });
    expect(config).toEqual({
      quotationType: null,
      salesOrganization: null,
      distributionChannel: null,
      division: null,
      salesPersonPartnerFunction: null,
      priceConditionType: null,
    });
  });

  // Cobertura del catch de getBusinessPartnerCreationConfig: idem, una lectura que falla
  // debe devolver la forma completa de defaults, nunca relanzar.
  it('no lanza cuando la lectura revienta (getBusinessPartnerCreationConfig)', async () => {
    const tenantModels = {
      Configuration: { findOne: () => { throw new Error('mongo caído'); } },
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });
    expect(config).toEqual({
      findFallbackField: null,
      defaults: {
        BusinessPartner: {},
        BusinessPartnerRole: [],
        Customer: {},
        CustomerCompany: {},
        CustomerSalesArea: {},
      },
    });
  });
});
