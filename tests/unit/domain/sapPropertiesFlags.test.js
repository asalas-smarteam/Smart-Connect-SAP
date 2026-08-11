import {
  buildSapPropertiesFlags,
  readSapPropertiesFlags,
  listSapPropertiesFieldNames,
} from '../../../src/domain/business-partners/sap-properties-flags.service.js';

const ON = {
  strategy: 'numberedMultiSelect',
  hubspotProperty: 'groupname',
  min: 1,
  max: 64,
  trueValue: 'tYES',
};

describe('buildSapPropertiesFlags', () => {
  it('convierte un multi-select separado por ; en banderas tYES', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: '1;2;3;55;64', config: ON })).toEqual({
      flags: {
        Properties1: 'tYES',
        Properties2: 'tYES',
        Properties3: 'tYES',
        Properties55: 'tYES',
        Properties64: 'tYES',
      },
      invalid: [],
    });
  });

  it('acepta tambien un array', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: [2, '7'], config: ON }).flags).toEqual({
      Properties2: 'tYES',
      Properties7: 'tYES',
    });
  });

  it('solo emite las seleccionadas, nunca las no seleccionadas', () => {
    const { flags } = buildSapPropertiesFlags({ hubspotValue: '3', config: ON });

    expect(flags).toEqual({ Properties3: 'tYES' });
    expect(Object.keys(flags)).toHaveLength(1);
  });

  it('ignora valores fuera de rango, no numericos y vacios, y los reporta', () => {
    const { flags, invalid } = buildSapPropertiesFlags({
      hubspotValue: '0;65;abc;;12.5; 9 ',
      config: ON,
    });

    expect(flags).toEqual({ Properties9: 'tYES' });
    expect(invalid).toEqual(['0', '65', 'abc', '12.5']);
  });

  it('deduplica valores repetidos', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: '5;5;5', config: ON }).flags).toEqual({
      Properties5: 'tYES',
    });
  });

  it('devuelve vacio cuando el valor de HubSpot no viene', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: undefined, config: ON })).toEqual({
      flags: {}, invalid: [],
    });
    expect(buildSapPropertiesFlags({ hubspotValue: '', config: ON }).flags).toEqual({});
  });

  it('devuelve vacio cuando la strategy esta apagada', () => {
    const off = { ...ON, strategy: 'none' };

    expect(buildSapPropertiesFlags({ hubspotValue: '1;2', config: off })).toEqual({
      flags: {}, invalid: [],
    });
  });

  it('respeta un rango personalizado', () => {
    const narrow = { ...ON, min: 10, max: 12 };

    expect(buildSapPropertiesFlags({ hubspotValue: '9;10;12;13', config: narrow })).toEqual({
      flags: { Properties10: 'tYES', Properties12: 'tYES' },
      invalid: ['9', '13'],
    });
  });
});

describe('readSapPropertiesFlags', () => {
  it('convierte las banderas de SAP en un valor de multi-select', () => {
    const sapRecord = {
      Properties1: 'tYES',
      Properties2: 'tNO',
      Properties3: 'tYES',
      Properties64: 'tYES',
    };

    expect(readSapPropertiesFlags({ sapRecord, config: ON })).toBe('1;3;64');
  });

  it('devuelve string vacio cuando ninguna esta en tYES', () => {
    expect(readSapPropertiesFlags({ sapRecord: { Properties1: 'tNO' }, config: ON })).toBe('');
  });

  it('devuelve null cuando la strategy esta apagada', () => {
    expect(readSapPropertiesFlags({ sapRecord: { Properties1: 'tYES' }, config: { ...ON, strategy: 'none' } }))
      .toBeNull();
  });
});

describe('listSapPropertiesFieldNames', () => {
  it('lista los nombres de campo del rango configurado', () => {
    expect(listSapPropertiesFieldNames({ ...ON, min: 1, max: 3 }))
      .toEqual(['Properties1', 'Properties2', 'Properties3']);
  });

  it('devuelve vacio cuando la strategy esta apagada', () => {
    expect(listSapPropertiesFieldNames({ ...ON, strategy: 'none' })).toEqual([]);
  });
});
