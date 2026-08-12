import { withPropertiesFlagsSelectFields }
  from '../../../src/domain/business-partners/sap-properties-flags.service.js';

const BASE = [
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
];

const ON = { strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 64, trueValue: 'tYES' };
const OFF = { ...ON, strategy: 'none' };

describe('withPropertiesFlagsSelectFields', () => {
  it('inyecta los 64 campos', () => {
    const result = withPropertiesFlagsSelectFields(BASE, ON, { objectType: 'company', sourceContext: 'businessPartner' });

    expect(result).toHaveLength(1 + 64);
    const injected = result.slice(1).map((mapping) => mapping.sourceField);
    expect(injected[0]).toBe('Properties1');
    expect(injected[63]).toBe('Properties64');
  });

  it('los sinteticos llevan targetField null y no escriben propiedades', () => {
    const result = withPropertiesFlagsSelectFields(BASE, ON, { objectType: 'company', sourceContext: 'businessPartner' });

    for (const mapping of result.slice(1)) {
      expect(mapping.targetField).toBeNull();
      expect(mapping.includeInServiceLayerSelect).toBe(true);
      expect(mapping.isActive).toBe(true);
      expect(mapping.sourceContext).toBe('businessPartner');
    }
  });

  it('devuelve la misma referencia cuando la strategy esta apagada', () => {
    expect(withPropertiesFlagsSelectFields(BASE, OFF, { objectType: 'company' })).toBe(BASE);
    expect(withPropertiesFlagsSelectFields(BASE, null, { objectType: 'company' })).toBe(BASE);
  });

  it('respeta un rango personalizado', () => {
    const result = withPropertiesFlagsSelectFields(BASE, { ...ON, min: 10, max: 12 }, { objectType: 'company' });

    expect(result.slice(1).map((mapping) => mapping.sourceField))
      .toEqual(['Properties10', 'Properties11', 'Properties12']);
  });

  it('deduplica contra un mapping que ya declare Properties5', () => {
    const withFive = [
      ...BASE,
      { sourceField: 'Properties5', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
    ];

    const result = withPropertiesFlagsSelectFields(withFive, { ...ON, min: 1, max: 6 }, { objectType: 'company' });

    const injected = result.slice(2).map((mapping) => mapping.sourceField);
    expect(injected).toEqual(['Properties1', 'Properties2', 'Properties3', 'Properties4', 'Properties6']);
  });

  it('un mapping excluido del select NO cuenta como cubierto', () => {
    const withExcluded = [
      ...BASE,
      { sourceField: 'Properties5', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: false, isActive: true },
    ];

    const result = withPropertiesFlagsSelectFields(withExcluded, { ...ON, min: 5, max: 5 }, { objectType: 'company' });

    expect(result.slice(2).map((mapping) => mapping.sourceField)).toEqual(['Properties5']);
  });

  it('tolera una lista de mappings vacia', () => {
    expect(withPropertiesFlagsSelectFields([], { ...ON, min: 1, max: 2 }, { objectType: 'company' }))
      .toHaveLength(2);
  });
});
