import { jest } from '@jest/globals';

const mockEnsureObjectProperty = jest.fn(async (_token, field) => ({
  created: true,
  objectType: field.objectType,
  name: field.name,
  property: field,
}));

jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotMetadata.controller.js', () => ({
  ensureObjectProperty: mockEnsureObjectProperty,
  fetchDealPipelines: jest.fn().mockResolvedValue([]),
  fetchDealStages: jest.fn().mockResolvedValue([]),
  fetchOwners: jest.fn().mockResolvedValue([]),
}));

const { seedCreateFieldsHubspot } = await import(
  '../../../src/infrastructure/hubspot/tenantHubspotSeed.service.js'
);

beforeEach(() => {
  mockEnsureObjectProperty.mockClear();
});

function ensuredField(name) {
  const call = mockEnsureObjectProperty.mock.calls.find(([, field]) => field.name === name);
  return call?.[1];
}

describe('seedCreateFieldsHubspot', () => {
  // Sin esta propiedad el asesor no tiene forma de disparar un reenvío: el workflow de
  // reintento se engancha justo al cambio de valor de acá.
  it('crea la propiedad de estado de integración con sus cuatro opciones', async () => {
    await seedCreateFieldsHubspot({ hubspotCredential: { accessToken: 'token-1', _id: 'cred-1' } });

    const field = ensuredField('sap_integration_status');

    expect(field).toMatchObject({
      objectType: 'deal',
      type: 'enumeration',
      fieldType: 'select',
    });
    expect(field.options.map((option) => option.value)).toEqual([
      'completed',
      'error_retry',
      'error_support',
      'retry',
    ]);
  });

  it('sigue creando las propiedades que ya existían', async () => {
    await seedCreateFieldsHubspot({ hubspotCredential: { accessToken: 'token-1', _id: 'cred-1' } });

    expect(ensuredField('sap_docentry')).toBeDefined();
    expect(ensuredField('sap_docnum')).toBeDefined();
  });
});
