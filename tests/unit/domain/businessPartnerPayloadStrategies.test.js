import { jest } from '@jest/globals';
import BusinessPartnerPayloadStrategyFactory
  from '../../../src/domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import { BP_PAYLOAD_STRATEGIES }
  from '../../../src/domain/business-partners/business-partner-creation.constants.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { BusinessPartnerPayloadStrategyPort }
  from '../../../src/application/ports/sap/business-partner-payload-strategy.port.js';

describe('LegacyWhitelistBusinessPartnerPayloadStrategy', () => {
  const strategy = new LegacyWhitelistBusinessPartnerPayloadStrategy();

  it('cumple el puerto', () => {
    expect(() => assertPort(strategy, BusinessPartnerPayloadStrategyPort)).not.toThrow();
  });

  it('no incluye ContactEmployees en la creacion', () => {
    expect(strategy.includesContactEmployeesInCreate()).toBe(false);
  });

  // GUARDIA DE REGRESION: este objeto es literalmente el que armaba
  // SapWebhookOrderAdapter.js:268-299 antes del refactor.
  it('reproduce el payload historico cuando el BP es una company con CardCode', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { GroupCode: 105, U_TIPO: 'N' },
      resolved: {
        cardName: 'ACME',
        cardCode: 'CL123',
        defaultSeries: 59,
        priceListNum: 1,
        payTermsGrpCode: 13,
        federalTaxId: '0003004080-9',
        mappedEmail: 'ac@example.com',
        phone1: '+50259877130',
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload).toEqual({
      CardName: 'ACME',
      CardType: 'C',
      CompanyPrivate: 'C',
      EmailAddress: 'ac@example.com',
      Phone1: '+50259877130',
      PriceListNum: 1,
      FederalTaxID: '0003004080-9',
      Frozen: 'tNO',
      Valid: 'tYES',
      CardCode: 'CL123',
      PayTermsGrpCode: 13,
    });
  });

  it('descarta los campos mapeados que no estan en el whitelist', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { GroupCode: 105, U_TIPO_IND: 'IP', Currency: 'GTQ' },
      resolved: {
        cardName: 'ACME', cardCode: null, defaultSeries: null, priceListNum: 1,
        payTermsGrpCode: null, federalTaxId: null, mappedEmail: null, phone1: null,
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload).not.toHaveProperty('GroupCode');
    expect(payload).not.toHaveProperty('U_TIPO_IND');
    expect(payload).not.toHaveProperty('Currency');
  });

  it('usa Series cuando no hay CardCode, y CompanyPrivate I cuando el BP es un contact', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      resolved: {
        cardName: 'Juan Perez', cardCode: null, defaultSeries: 59, priceListNum: 2,
        payTermsGrpCode: null, federalTaxId: null, mappedEmail: null, phone1: null,
        isCompanyBusinessPartner: false,
      },
    });

    expect(payload.Series).toBe(59);
    expect(payload).not.toHaveProperty('CardCode');
    expect(payload.CompanyPrivate).toBe('I');
    expect(payload.EmailAddress).toBe('');
    expect(payload).not.toHaveProperty('PayTermsGrpCode');
  });

  it('omite Phone1 y FederalTaxID cuando vienen vacios', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      resolved: {
        cardName: 'ACME', cardCode: 'X', defaultSeries: null, priceListNum: 1,
        payTermsGrpCode: null, federalTaxId: '  ', mappedEmail: null, phone1: '   ',
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload).not.toHaveProperty('Phone1');
    expect(payload).not.toHaveProperty('FederalTaxID');
  });

  it('conserva PayTermsGrpCode y PriceListNum en cero', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      resolved: {
        cardName: 'ACME', cardCode: 'X', defaultSeries: null, priceListNum: 0,
        payTermsGrpCode: 0, federalTaxId: null, mappedEmail: null, phone1: null,
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload.PriceListNum).toBe(0);
    expect(payload.PayTermsGrpCode).toBe(0);
  });

  // GUARDIA DE REGRESION (Finding 1 del review): el adapter real resuelve
  // Phone1 con `mappedCompany?.Phone1 || mappedContact?.Phone1` ANTES de
  // fusionar objetos. Si mappedCompany.Phone1 es un falsy-pero-presente no
  // string (0, false), un merge `{ ...mappedContact, ...mappedCompany }`
  // produciria "0"/"false" en vez de caer al telefono del contacto. Por eso
  // resolved.phone1 debe llegar YA resuelto con esa misma logica OR, nunca
  // leido de mappedBusinessPartner.
  it('usa el telefono del contacto cuando el de la company es 0 (falsy no vacio)', () => {
    const mappedCompany = { Phone1: 0 };
    const mappedContact = { Phone1: '+50259877130' };
    const phone1 = mappedCompany.Phone1 || mappedContact.Phone1;

    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { ...mappedContact, ...mappedCompany },
      resolved: {
        cardName: 'ACME', cardCode: 'X', defaultSeries: null, priceListNum: 1,
        payTermsGrpCode: null, federalTaxId: null, mappedEmail: null, phone1,
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload.Phone1).toBe('+50259877130');
  });
});

describe('BusinessPartnerPayloadStrategyFactory', () => {
  const legacyStrategy = { name: 'legacy' };
  const fullMappedStrategy = { name: 'full' };

  it('resuelve la strategy legacy por nombre', () => {
    const factory = new BusinessPartnerPayloadStrategyFactory({ legacyStrategy, fullMappedStrategy });

    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST)).toBe(legacyStrategy);
  });

  it('resuelve la strategy fullMapped por nombre', () => {
    const factory = new BusinessPartnerPayloadStrategyFactory({ legacyStrategy, fullMappedStrategy });

    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.FULL_MAPPED)).toBe(fullMappedStrategy);
  });

  it('lanza con la lista de validas ante un nombre desconocido', () => {
    const logger = { error: jest.fn() };
    const factory = new BusinessPartnerPayloadStrategyFactory({ legacyStrategy, fullMappedStrategy, logger });

    expect(() => factory.getStrategy('nope'))
      .toThrow('BusinessPartner payload strategy not supported: nope');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      strategyName: 'nope',
      validStrategies: Object.values(BP_PAYLOAD_STRATEGIES),
    }));
  });
});
