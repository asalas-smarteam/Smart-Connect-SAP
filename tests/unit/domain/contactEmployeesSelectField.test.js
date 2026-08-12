import { withContactEmployeesSelectField }
  from '../../../src/domain/business-partners/contact-employees-select.service.js';
import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

const BASE = [
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
  { sourceField: 'CardName', targetField: 'firstname', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
];

describe('withContactEmployeesSelectField', () => {
  it('inyecta ContactEmployees cuando el objectType es contact', () => {
    const result = withContactEmployeesSelectField(BASE, { objectType: 'contact', sourceContext: 'businessPartner' });

    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      sourceField: 'ContactEmployees',
      targetField: null,
      objectType: 'contact',
      sourceContext: 'businessPartner',
      includeInServiceLayerSelect: true,
      isActive: true,
    });
  });

  it('NO inyecta para company: ese ya llega por la variable de entorno', () => {
    const result = withContactEmployeesSelectField(BASE, { objectType: 'company', sourceContext: 'businessPartner' });

    expect(result).toBe(BASE);
  });

  it('no inyecta para product ni deal', () => {
    expect(withContactEmployeesSelectField(BASE, { objectType: 'product' })).toBe(BASE);
    expect(withContactEmployeesSelectField(BASE, { objectType: 'deal' })).toBe(BASE);
  });

  it('no duplica si ya hay un mapping para ContactEmployees', () => {
    const withField = [
      ...BASE,
      { sourceField: 'ContactEmployees', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
    ];

    expect(withContactEmployeesSelectField(withField, { objectType: 'contact' })).toBe(withField);
  });

  it('SI inyecta cuando el mapping existente esta excluido del select', () => {
    const withExcluded = [
      ...BASE,
      { sourceField: 'ContactEmployees', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: false, isActive: true },
    ];

    const result = withContactEmployeesSelectField(withExcluded, { objectType: 'contact' });

    expect(result).toHaveLength(4);
  });

  it('tolera una lista de mappings vacia o invalida', () => {
    expect(withContactEmployeesSelectField([], { objectType: 'contact' })).toHaveLength(1);
    expect(withContactEmployeesSelectField(null, { objectType: 'contact' })).toHaveLength(1);
  });

  // EL TEST QUE IMPORTA: el sintetico tiene que sobrevivir a sanitizeSelectFields.
  it('el campo inyectado llega hasta la URL final del Service Layer', () => {
    const mappings = withContactEmployeesSelectField(BASE, { objectType: 'contact', sourceContext: 'businessPartner' });

    const url = buildServiceLayerUrl(
      { serviceLayerBaseUrl: 'https://sap.example.com', serviceLayerPath: '/BusinessPartners', objectType: 'contact', integrationModeName: 'SERVICE_LAYER' },
      mappings
    );

    expect(url).toContain('ContactEmployees');
  });

  it('un sintetico con sourceContext contactEmployee NO llegaria a la URL (por eso usamos businessPartner)', () => {
    const url = buildServiceLayerUrl(
      { serviceLayerBaseUrl: 'https://sap.example.com', serviceLayerPath: '/BusinessPartners', objectType: 'contact', integrationModeName: 'SERVICE_LAYER' },
      [...BASE, { sourceField: 'ContactEmployees', targetField: null, sourceContext: 'contactEmployee', includeInServiceLayerSelect: true, isActive: true }]
    );

    expect(url).not.toContain('ContactEmployees');
  });
});
