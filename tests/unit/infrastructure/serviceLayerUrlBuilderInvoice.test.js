import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

describe('buildServiceLayerUrl — DocumentLines obligatorio en facturas', () => {
  const invoiceConfig = {
    serviceLayerBaseUrl: 'https://sap.example.com',
    serviceLayerPath: '/Invoices',
    objectType: 'invoice',
    integrationModeName: 'SERVICE_LAYER',
  };

  const invoiceMappings = [
    { sourceField: 'NumAtCard', sourceContext: 'businessPartner' },
    { sourceField: 'DocNum', sourceContext: 'businessPartner' },
  ];

  // La reconciliacion resuelve el negocio por DocumentLines[].BaseEntry. Si el campo
  // dependiera de una fila del admin, un tenant que la borre romperia la tarea en silencio.
  it('agrega DocumentLines al $select aunque ningun mapping lo pida', () => {
    const url = buildServiceLayerUrl(invoiceConfig, invoiceMappings);

    expect(url).toContain('DocumentLines');
    expect(url).toContain('NumAtCard');
  });

  it('no duplica DocumentLines si además viene como mapping', () => {
    const url = buildServiceLayerUrl(invoiceConfig, [
      ...invoiceMappings,
      { sourceField: 'DocumentLines', sourceContext: 'businessPartner' },
    ]);

    const select = decodeURIComponent(url.split('$select=')[1].split('&')[0]);
    const ocurrencias = select.split(',').filter((field) => field === 'DocumentLines');
    expect(ocurrencias).toHaveLength(1);
  });

  it('no agrega DocumentLines para otros objectType', () => {
    const url = buildServiceLayerUrl(
      { ...invoiceConfig, objectType: 'company', serviceLayerPath: '/BusinessPartners' },
      [{ sourceField: 'CardCode', sourceContext: 'businessPartner' }]
    );

    expect(url).not.toContain('DocumentLines');
  });

  // requiredFields (DocumentLines) no puede tapar este guard: si un tenant sin ningún
  // mapping activo de facturas igual arma una URL válida, SAP responde con datos y
  // MappingSyncRepository.mapRecords devuelve [] por falta de mappings, así que el
  // SyncLog queda "completado", con registros leídos y cero enviados, sin ningún motivo.
  it('sigue lanzando cuando invoice no tiene ningun mapping activo', () => {
    expect(() => buildServiceLayerUrl(invoiceConfig, [])).toThrow(
      'At least one active mapping with a valid sourceField is required'
    );
  });
});
