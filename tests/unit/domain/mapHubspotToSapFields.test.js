import { jest } from '@jest/globals';
import { mapHubspotToSapFields } from '../../../src/domain/orders/order-builder.service.js';

describe('mapHubspotToSapFields descarta los textos "null" y "undefined"', () => {
  const mappings = [
    { sourceField: 'U_ACO_Telefono2', targetField: 'numero_de_contacto_secundario' },
  ];

  // Verificado en produccion: el workflow de noelito serializa dos propiedades vacias como
  // el TEXTO "null", y hoy eso se escribe literal en el campo de SAP.
  it.each(['null', 'undefined', 'NULL', 'Undefined', '  null  '])(
    'no produce la clave cuando el valor es %p',
    (value) => {
      const mapped = mapHubspotToSapFields(
        { numero_de_contacto_secundario: value },
        mappings
      );

      expect(mapped).not.toHaveProperty('U_ACO_Telefono2');
    }
  );

  // El descarte es por valor exacto, no por contenido: un texto legitimo que contenga la
  // palabra tiene que sobrevivir.
  it.each(['anulado', 'null y algo mas', 'nullo', 'sin undefined aqui', '0'])(
    'conserva el valor legitimo %p',
    (value) => {
      const mapped = mapHubspotToSapFields(
        { numero_de_contacto_secundario: value },
        mappings
      );

      expect(mapped.U_ACO_Telefono2).toBe(value);
    }
  );

  it('avisa en warn con el campo de SAP y la propiedad de HubSpot', () => {
    const logger = { warn: jest.fn() };

    mapHubspotToSapFields(
      { numero_de_contacto_secundario: 'null' },
      mappings,
      { logger }
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      sapField: 'U_ACO_Telefono2',
      hubspotProperty: 'numero_de_contacto_secundario',
      value: 'null',
    }));
  });

  it('no explota cuando no se le pasa logger', () => {
    expect(() => mapHubspotToSapFields(
      { numero_de_contacto_secundario: 'null' },
      mappings
    )).not.toThrow();
  });

  // Un null real es una propiedad vacia normal, no un workflow mal configurado: se descarta
  // como siempre, pero sin ruido en el log.
  it('no avisa cuando el valor es un null real', () => {
    const logger = { warn: jest.fn() };

    const mapped = mapHubspotToSapFields(
      { numero_de_contacto_secundario: null },
      mappings,
      { logger }
    );

    expect(mapped).not.toHaveProperty('U_ACO_Telefono2');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('sigue mapeando los demas campos cuando uno se descarta', () => {
    const mapped = mapHubspotToSapFields(
      { numero_de_contacto_secundario: 'null', numero_de_contacto_primario: '+50583635946' },
      [
        ...mappings,
        { sourceField: 'U_ACO_Telefono', targetField: 'numero_de_contacto_primario' },
      ]
    );

    expect(mapped).toEqual({ U_ACO_Telefono: '+50583635946' });
  });
});

// Afecta a los 4 tenants y a todos los contextos (deal/product/contact/company): un valor de
// puros espacios es la misma basura que '' o los textos "null"/"undefined" ya cubiertos arriba,
// y viene de la misma fuente (un workflow de HubSpot mal configurado).
describe('mapHubspotToSapFields descarta los valores de solo espacios en blanco', () => {
  const mappings = [
    { sourceField: 'U_ACO_Telefono2', targetField: 'numero_de_contacto_secundario' },
  ];

  it.each(['   ', '\t', '\n', ' \t\n '])(
    'no produce la clave cuando el valor es %p',
    (value) => {
      const mapped = mapHubspotToSapFields(
        { numero_de_contacto_secundario: value },
        mappings
      );

      expect(mapped).not.toHaveProperty('U_ACO_Telefono2');
    }
  );

  it('no avisa en warn: no es un texto reconocible de configuracion, es simplemente vacio', () => {
    const logger = { warn: jest.fn() };

    mapHubspotToSapFields(
      { numero_de_contacto_secundario: '   ' },
      mappings,
      { logger }
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('conserva un texto legitimo con espacio final tal cual, sin recortarlo', () => {
    const mapped = mapHubspotToSapFields(
      { numero_de_contacto_secundario: 'texto ' },
      mappings
    );

    expect(mapped.U_ACO_Telefono2).toBe('texto ');
  });

  it.each([
    ['un numero', 0],
    ['un booleano false', false],
    ['un numero comun', 42],
  ])('sigue mapeando %s aunque sea falsy', (_label, value) => {
    const mapped = mapHubspotToSapFields(
      { numero_de_contacto_secundario: value },
      mappings
    );

    expect(mapped.U_ACO_Telefono2).toBe(value);
  });

  it('sigue mapeando un array tal cual', () => {
    const value = ['a', 'b'];
    const mapped = mapHubspotToSapFields(
      { numero_de_contacto_secundario: value },
      mappings
    );

    expect(mapped.U_ACO_Telefono2).toBe(value);
  });
});
