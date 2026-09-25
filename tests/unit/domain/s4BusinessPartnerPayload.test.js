import { buildS4BusinessPartnerCreatePayload } from '../../../src/domain/business-partners/s4-business-partner-payload.service.js';

const CREATION_CONFIG = {
  findFallbackField: 'to_Customer.BPTaxLongNumber',
  defaults: {
    BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
    BusinessPartnerRole: ['FLCU00', 'FLCU01'],
    Customer: { CustomerAccountGroup: 'ZC01' },
    CustomerCompany: { CompanyCode: '1000', ReconciliationAccount: '0012100000' },
    CustomerSalesArea: { Currency: 'GTQ', PriceListType: 'ZC' },
  },
};

const SALES_AREA = { salesOrganization: 'MQGT', distributionChannel: '01', division: '00' };

describe('buildS4BusinessPartnerCreatePayload', () => {
  it('arma el deep create con roles, dirección, cliente, sociedad y área de ventas', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: {
        BusinessPartnerFullName: 'ACME S.A.',
        'to_BusinessPartnerAddress.CityName': 'Ciudad de Guatemala',
        'to_BusinessPartnerAddress.Country': 'GT',
        'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress': 'compras@acme.com',
        'to_Customer.BPTaxLongNumber': '1234567-8',
      },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload).toEqual({
      BusinessPartnerCategory: '2',
      BusinessPartnerGrouping: 'ZC01',
      OrganizationBPName1: 'ACME S.A.',
      to_BusinessPartnerRole: [
        { BusinessPartnerRole: 'FLCU00' },
        { BusinessPartnerRole: 'FLCU01' },
      ],
      to_BusinessPartnerAddress: [{
        CityName: 'Ciudad de Guatemala',
        Country: 'GT',
        to_EmailAddress: [{ EmailAddress: 'compras@acme.com' }],
      }],
      to_Customer: {
        CustomerAccountGroup: 'ZC01',
        BPTaxLongNumber: '1234567-8',
        to_CustomerCompany: [{ CompanyCode: '1000', ReconciliationAccount: '0012100000' }],
        to_CustomerSalesArea: [{
          Currency: 'GTQ',
          PriceListType: 'ZC',
          SalesOrganization: 'MQGT',
          DistributionChannel: '01',
          Division: '00',
        }],
      },
    });
  });

  // BusinessPartnerFullName es CALCULADO y de solo lectura en A_BusinessPartner. El campo
  // escribible es OrganizationBPName1. El mapeo del tenant dice BusinessPartnerFullName porque
  // ese es el nombre que sirve para LEER, así que acá se traduce.
  it('traduce BusinessPartnerFullName a OrganizationBPName1', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME S.A.' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload.OrganizationBPName1).toBe('ACME S.A.');
    expect(payload).not.toHaveProperty('BusinessPartnerFullName');
  });

  it('respeta OrganizationBPName1 cuando el mapeo ya lo trae', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { OrganizationBPName1: 'Explícito', BusinessPartnerFullName: 'Calculado' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload.OrganizationBPName1).toBe('Explícito');
  });

  // Mismo orden de precedencia que B1: el default configurado gana, el mapeo llena el resto.
  it('el default de la config gana sobre el valor mapeado', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME', BusinessPartnerGrouping: 'ZZ99' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload.BusinessPartnerGrouping).toBe('ZC01');
  });

  it('el área de ventas del documento gana sobre el default de la config', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: {
        ...CREATION_CONFIG,
        defaults: {
          ...CREATION_CONFIG.defaults,
          CustomerSalesArea: { ...CREATION_CONFIG.defaults.CustomerSalesArea, SalesOrganization: 'VIEJA' },
        },
      },
      salesArea: SALES_AREA,
    });

    expect(payload.to_Customer.to_CustomerSalesArea[0].SalesOrganization).toBe('MQGT');
  });

  it('omite to_BusinessPartnerRole cuando la config no declara roles', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: { ...CREATION_CONFIG, defaults: { ...CREATION_CONFIG.defaults, BusinessPartnerRole: [] } },
      salesArea: SALES_AREA,
    });

    expect(payload).not.toHaveProperty('to_BusinessPartnerRole');
  });

  it('omite to_CustomerCompany cuando la config no trae sociedad', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: { ...CREATION_CONFIG, defaults: { ...CREATION_CONFIG.defaults, CustomerCompany: {} } },
      salesArea: SALES_AREA,
    });

    expect(payload.to_Customer).not.toHaveProperty('to_CustomerCompany');
  });

  it('tira permanente cuando no hay nombre para el cliente', () => {
    expect(() => buildS4BusinessPartnerCreatePayload({
      mappedCompany: { 'to_Customer.BPTaxLongNumber': '1234567-8' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    })).toThrow(/nombre/i);
  });

  // Si salesArea llega incompleto, las claves faltantes quedan `undefined` dentro de
  // to_CustomerSalesArea[0] y JSON.stringify las descarta en silencio: el cliente se crearía
  // fuera del área de ventas del documento, violando la regla 3 del diseño. Fallar temprano y
  // nombrando el campo evita ese hueco.
  it('tira permanente cuando falta salesOrganization en salesArea', () => {
    expect(() => buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: CREATION_CONFIG,
      salesArea: { distributionChannel: '01', division: '00' },
    })).toThrow(/SalesOrganization/);
  });

  it('tira permanente cuando falta distributionChannel en salesArea', () => {
    expect(() => buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: CREATION_CONFIG,
      salesArea: { salesOrganization: 'MQGT', division: '00' },
    })).toThrow(/DistributionChannel/);
  });

  it('tira permanente cuando falta division en salesArea', () => {
    expect(() => buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: CREATION_CONFIG,
      salesArea: { salesOrganization: 'MQGT', distributionChannel: '01' },
    })).toThrow(/Division/);
  });

  it('tira permanente y nombra los tres campos cuando salesArea llega vacío', () => {
    expect(() => buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: CREATION_CONFIG,
      salesArea: {},
    })).toThrow(/SalesOrganization, DistributionChannel, Division/);
  });
});
