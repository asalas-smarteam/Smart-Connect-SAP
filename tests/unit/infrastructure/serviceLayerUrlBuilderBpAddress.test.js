import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

describe('buildServiceLayerUrl — exclusión del contexto bpAddress', () => {
  const clientConfig = {
    serviceLayerBaseUrl: 'https://sap.example.com',
    serviceLayerPath: '/BusinessPartners',
    objectType: 'company',
    integrationModeName: 'SERVICE_LAYER',
  };

  it('deja fuera del $select los mappings de contexto bpAddress', () => {
    const url = buildServiceLayerUrl(clientConfig, [
      { sourceField: 'CardCode', sourceContext: 'businessPartner', includeInServiceLayerSelect: true },
      { sourceField: 'CardName', sourceContext: 'businessPartner', includeInServiceLayerSelect: true },
      { sourceField: 'Street', sourceContext: 'bpAddress', includeInServiceLayerSelect: true },
      { sourceField: 'County', sourceContext: 'bpAddress', includeInServiceLayerSelect: true },
    ]);

    expect(url).toContain('CardCode');
    expect(url).toContain('CardName');
    expect(url).not.toContain('Street');
    expect(url).not.toContain('County');
  });

  it('sigue dejando fuera los mappings de contexto contactEmployee', () => {
    const url = buildServiceLayerUrl(clientConfig, [
      { sourceField: 'CardCode', sourceContext: 'businessPartner', includeInServiceLayerSelect: true },
      { sourceField: 'Position', sourceContext: 'contactEmployee', includeInServiceLayerSelect: true },
    ]);

    expect(url).toContain('CardCode');
    expect(url).not.toContain('Position');
  });
});
