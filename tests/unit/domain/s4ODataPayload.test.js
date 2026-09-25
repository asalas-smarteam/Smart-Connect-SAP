import { jest } from '@jest/globals';
import {
  S4_NAVIGATION_CARDINALITY,
  expandS4ODataKeys,
} from '../../../src/domain/sap/s4-odata-payload.service.js';

describe('expandS4ODataKeys', () => {
  it('deja intactas las claves sin punto', () => {
    expect(expandS4ODataKeys({ SoldToParty: '100053', OrganizationBPName1: 'ACME' })).toEqual({
      SoldToParty: '100053',
      OrganizationBPName1: 'ACME',
    });
  });

  it('anida una navegación 1:1 como objeto', () => {
    expect(expandS4ODataKeys({ 'to_Customer.BPTaxLongNumber': '3101' })).toEqual({
      to_Customer: { BPTaxLongNumber: '3101' },
    });
  });

  it('anida una navegación de colección como array de un elemento', () => {
    expect(expandS4ODataKeys({ 'to_BusinessPartnerAddress.CityName': 'San José' })).toEqual({
      to_BusinessPartnerAddress: [{ CityName: 'San José' }],
    });
  });

  // Dos mapeos que apuntan a la misma dirección tienen que caer en la MISMA fila, no en dos.
  // Sin esto, el gateway crearía dos direcciones, cada una a medio llenar.
  it('fusiona claves hermanas en el mismo elemento de la colección', () => {
    expect(expandS4ODataKeys({
      'to_BusinessPartnerAddress.CityName': 'San José',
      'to_BusinessPartnerAddress.Country': 'CR',
    })).toEqual({
      to_BusinessPartnerAddress: [{ CityName: 'San José', Country: 'CR' }],
    });
  });

  it('anida colecciones dentro de colecciones', () => {
    expect(expandS4ODataKeys({
      'to_BusinessPartnerAddress.CityName': 'San José',
      'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress': 'a@b.com',
      'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber': '22223333',
    })).toEqual({
      to_BusinessPartnerAddress: [{
        CityName: 'San José',
        to_EmailAddress: [{ EmailAddress: 'a@b.com' }],
        to_PhoneNumber: [{ PhoneNumber: '22223333' }],
      }],
    });
  });

  it('anida una colección dentro de una navegación 1:1', () => {
    expect(expandS4ODataKeys({
      'to_Customer.to_CustomerSalesArea.PriceListType': 'ZC',
      'to_Customer.CustomerAccountGroup': 'ZC01',
    })).toEqual({
      to_Customer: {
        CustomerAccountGroup: 'ZC01',
        to_CustomerSalesArea: [{ PriceListType: 'ZC' }],
      },
    });
  });

  // Adivinar la cardinalidad de una navegación desconocida hace que el gateway rechace el
  // POST ENTERO, y el síntoma no apunta al mapeo. Descartarla con warn deja el resto viable.
  it('descarta con warn una navegación que no está en la tabla de cardinalidad', () => {
    const logger = { warn: jest.fn() };

    expect(expandS4ODataKeys({ 'to_Inventado.Campo': 'x', SoldToParty: '1' }, { logger })).toEqual({
      SoldToParty: '1',
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      navigation: 'to_Inventado',
      field: 'to_Inventado.Campo',
    }));
  });

  it('tolera entrada nula y no revienta sin logger', () => {
    expect(expandS4ODataKeys(null)).toEqual({});
    expect(expandS4ODataKeys({ 'to_Inventado.Campo': 'x' })).toEqual({});
  });

  // El camino real de la cédula en este servicio: un socio de negocio trae varias filas
  // fiscales (una por tipo de impuesto), así que la navegación es una colección. Sin esta
  // entrada en la tabla, un mapeo real de cédula se descartaba con warn al crear el cliente.
  it('anida la cédula de to_BusinessPartnerTax como colección', () => {
    const logger = { warn: jest.fn() };

    expect(expandS4ODataKeys({
      'to_BusinessPartnerTax.BPTaxLongNumber': '3101234567',
      'to_BusinessPartnerTax.BPTaxType': 'CR1',
    }, { logger })).toEqual({
      to_BusinessPartnerTax: [{ BPTaxLongNumber: '3101234567', BPTaxType: 'CR1' }],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('declara la cardinalidad de las navegaciones del spec', () => {
    expect(S4_NAVIGATION_CARDINALITY).toMatchObject({
      to_BusinessPartnerAddress: 'collection',
      'to_BusinessPartnerAddress.to_EmailAddress': 'collection',
      'to_BusinessPartnerAddress.to_PhoneNumber': 'collection',
      to_BusinessPartnerRole: 'collection',
      to_BusinessPartnerTax: 'collection',
      to_Customer: 'single',
      'to_Customer.to_CustomerCompany': 'collection',
      'to_Customer.to_CustomerSalesArea': 'collection',
      to_Item: 'collection',
      to_Partner: 'collection',
      to_PricingElement: 'collection',
    });
  });

  // Una clave plana cuyo nombre sea una navegación conocida es un mapeo mal configurado:
  // el gateway rechazaría enviar un escalar dentro de una navegación de OData.
  // Se descarta la clave plana, conservando las claves anidadas.
  it('descarta con warn una clave plana que nombra una navegación (clave plana primero)', () => {
    const logger = { warn: jest.fn() };

    expect(expandS4ODataKeys({
      'to_Customer': 'foo',
      'to_Customer.BPTaxLongNumber': '1',
    }, { logger })).toEqual({
      to_Customer: { BPTaxLongNumber: '1' },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      field: 'to_Customer',
      navigation: 'to_Customer',
    }));
  });

  it('descarta con warn una clave plana que nombra una navegación (clave anidada primero)', () => {
    const logger = { warn: jest.fn() };

    expect(expandS4ODataKeys({
      'to_Customer.BPTaxLongNumber': '1',
      'to_Customer': 'foo',
    }, { logger })).toEqual({
      to_Customer: { BPTaxLongNumber: '1' },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      field: 'to_Customer',
      navigation: 'to_Customer',
    }));
  });
});
