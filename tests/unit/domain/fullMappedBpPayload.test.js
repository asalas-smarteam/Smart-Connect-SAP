import FullMappedBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { BusinessPartnerPayloadStrategyPort }
  from '../../../src/application/ports/sap/business-partner-payload-strategy.port.js';

const strategy = new FullMappedBusinessPartnerPayloadStrategy();

const RESOLVED = {
  cardName: 'EMPRESA DE PRUEBA 29052026',
  cardCode: null,
  defaultSeries: 59,
  priceListNum: 1,
  payTermsGrpCode: 13,
  federalTaxId: '0003004080-9',
  mappedEmail: 'ac123@gmail.com',
  isCompanyBusinessPartner: true,
};

const DEFAULTS = {
  BusinessPartner: { CardType: 'cCustomer', PayTermsGrpCode: 13, Series: 59, PriceListNum: 1 },
  ContactEmployee: { Active: 'tYES' },
  BPAddress: { TaxCode: 'IVA' },
};

describe('FullMappedBusinessPartnerPayloadStrategy', () => {
  it('cumple el puerto e incluye ContactEmployees en la creacion', () => {
    expect(() => assertPort(strategy, BusinessPartnerPayloadStrategyPort)).not.toThrow();
    expect(strategy.includesContactEmployeesInCreate()).toBe(true);
  });

  // TEST DE ACEPTACION: reproduce el JSON objetivo del spec.
  it('produce el payload objetivo del cliente', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {
        CardName: 'EMPRESA DE PRUEBA 29052026',
        GroupCode: 105,
        Phone1: '+50259877130',
        FederalTaxID: '0003004080-9',
        SalesPersonCode: 1,
        EmailAddress: 'ac123@gmail.com',
        U_TIPO_IND: 'IP',
        U_SUBGRUPO: 'EMPRESAS MERCANTILES',
        U_TIPO: 'N',
        U_VENDEQUI: 'CHIEQP - Luis Lee',
        U_CORREO_FACTURA: 'asalas@smarteamcr.com',
      },
      addresses: [
        { AddressName: 'factura', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_BillTo' },
        { AddressName: 'Entrega', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_ShipTo' },
      ],
      contactEmployees: [
        { Name: 'Juan Mazariegos', Position: 'Sr.', Phone1: '3038-5327', Title: 'Lic.', Active: 'tYES', FirstName: 'Juan', LastName: 'Mazariegos', U_SUCURSAL: 'central' },
      ],
      propertiesFlags: { Properties1: 'tYES' },
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload).toEqual({
      CardName: 'EMPRESA DE PRUEBA 29052026',
      CardType: 'cCustomer',
      GroupCode: 105,
      Phone1: '+50259877130',
      PayTermsGrpCode: 13,
      FederalTaxID: '0003004080-9',
      PriceListNum: 1,
      SalesPersonCode: 1,
      EmailAddress: 'ac123@gmail.com',
      Properties1: 'tYES',
      U_TIPO_IND: 'IP',
      Series: 59,
      U_SUBGRUPO: 'EMPRESAS MERCANTILES',
      U_TIPO: 'N',
      U_VENDEQUI: 'CHIEQP - Luis Lee',
      U_CORREO_FACTURA: 'asalas@smarteamcr.com',
      BPAddresses: [
        { AddressName: 'factura', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_BillTo' },
        { AddressName: 'Entrega', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_ShipTo' },
      ],
      ContactEmployees: [
        { Name: 'Juan Mazariegos', Position: 'Sr.', Phone1: '3038-5327', Title: 'Lic.', Active: 'tYES', FirstName: 'Juan', LastName: 'Mazariegos', U_SUCURSAL: 'central' },
      ],
    });
  });

  it('el valor mapeado gana sobre el default de config', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { PriceListNum: 7, CardType: 'cSupplier' },
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload.PriceListNum).toBe(7);
    expect(payload.CardType).toBe('cSupplier');
  });

  it('cae al default de config cuando no hay valor mapeado', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload.CardType).toBe('cCustomer');
    expect(payload.PayTermsGrpCode).toBe(13);
  });

  it('omite el campo cuando no hay valor en ningun lado', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: { ...RESOLVED, priceListNum: null, payTermsGrpCode: null, defaultSeries: null },
    });

    expect(payload).not.toHaveProperty('PriceListNum');
    expect(payload).not.toHaveProperty('PayTermsGrpCode');
    expect(payload).not.toHaveProperty('Series');
  });

  it('nunca manda null: los valores vacios se omiten', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { U_TIPO: null, U_SUBGRUPO: '', GroupCode: 105 },
      defaults: { BusinessPartner: { Currency: null }, ContactEmployee: {}, BPAddress: {} },
      resolved: RESOLVED,
    });

    expect(payload).not.toHaveProperty('U_TIPO');
    expect(payload).not.toHaveProperty('U_SUBGRUPO');
    expect(payload).not.toHaveProperty('Currency');
    expect(payload.GroupCode).toBe(105);
  });

  it('conserva PriceListNum y PayTermsGrpCode en cero', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: { ...RESOLVED, priceListNum: 0, payTermsGrpCode: 0 },
    });

    expect(payload.PriceListNum).toBe(0);
    expect(payload.PayTermsGrpCode).toBe(0);
  });

  it('usa CardCode y omite Series cuando hay CardCode', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: { ...RESOLVED, cardCode: 'CL999' },
    });

    expect(payload.CardCode).toBe('CL999');
    expect(payload).not.toHaveProperty('Series');
  });

  it('cae a CardType C cuando nadie lo define', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: RESOLVED,
    });

    expect(payload.CardType).toBe('C');
  });

  it('no manda arrays vacios', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      addresses: [],
      contactEmployees: [],
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload).not.toHaveProperty('BPAddresses');
    expect(payload).not.toHaveProperty('ContactEmployees');
  });

  it('ignora BPAddresses y ContactEmployees que vengan de un mapping', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { BPAddresses: 'basura', ContactEmployees: 'basura' },
      addresses: [{ AddressName: 'factura' }],
      contactEmployees: [],
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload.BPAddresses).toEqual([{ AddressName: 'factura' }]);
    expect(payload).not.toHaveProperty('ContactEmployees');
  });
});
