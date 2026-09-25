import { jest } from '@jest/globals';
import {
  S4SalesDocumentAdapter,
  normalizeS4QuotationResponse,
} from '../../../src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js';
import { B1SalesDocumentAdapter } from '../../../src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js';
import { wrapS4TransportWithRecorder } from '../../../src/infrastructure/sap/salesDocuments/recordedS4Transport.js';
import { createSapCallRecorder } from '../../../src/infrastructure/sap/sapCallRecorder.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { SapSalesDocumentPort } from '../../../src/application/ports/sap/sap-sales-document.port.js';

describe('S4SalesDocumentAdapter', () => {
  it('cumple SapSalesDocumentPort', () => {
    expect(() => assertPort(new S4SalesDocumentAdapter({ transport: { request: () => {} } }), SapSalesDocumentPort))
      .not.toThrow();
  });

  it('postea la oferta en la ruta de API_SALES_QUOTATION_SRV', async () => {
    const request = jest.fn().mockResolvedValue({ SalesQuotation: '20000123', to_Item: [] });
    const adapter = new S4SalesDocumentAdapter({ transport: { request } });

    await adapter.createQuotation({ quotationPayload: { SoldToParty: '100053' } });

    expect(request).toHaveBeenCalledWith({
      method: 'post',
      path: '/API_SALES_QUOTATION_SRV/A_SalesQuotation',
      body: { SoldToParty: '100053' },
    });
  });

  // El caso de uso, buildSapDocumentLinkLines y updateAfterSap leen DocEntry/DocNum/LineNum
  // literalmente. Normalizar acá es lo que evita tocarlos.
  it('normaliza la respuesta a la forma de B1', async () => {
    const transport = {
      request: async () => ({
        SalesQuotation: '20000123',
        to_Item: [{ SalesQuotationItem: '000010' }, { SalesQuotationItem: '000020' }],
      }),
    };

    const result = await new S4SalesDocumentAdapter({ transport })
      .createQuotation({ quotationPayload: {} });

    expect(result).toEqual({
      DocEntry: 20000123,
      DocNum: 20000123,
      DocumentLines: [{ LineNum: 10 }, { LineNum: 20 }],
      raw: {
        SalesQuotation: '20000123',
        to_Item: [{ SalesQuotationItem: '000010' }, { SalesQuotationItem: '000020' }],
      },
    });
  });
});

describe('normalizeS4QuotationResponse', () => {
  it('lee to_Item envuelto en results, como lo devuelve OData v2 sin normalizar', () => {
    const result = normalizeS4QuotationResponse({
      SalesQuotation: '20000999',
      to_Item: { results: [{ SalesQuotationItem: '000010' }] },
    });

    expect(result.DocEntry).toBe(20000999);
    expect(result.DocumentLines).toEqual([{ LineNum: 10 }]);
  });

  it('devuelve DocumentLines vacío cuando la respuesta no trae posiciones', () => {
    expect(normalizeS4QuotationResponse({ SalesQuotation: '1' }).DocumentLines).toEqual([]);
  });

  it('deja DocEntry en null cuando el número no es numérico', () => {
    const result = normalizeS4QuotationResponse({ SalesQuotation: '' });
    expect(result.DocEntry).toBeNull();
    expect(result.DocNum).toBeNull();
  });

  // 0 es un LineNum legítimo en Business One, así que una posición sin número no puede
  // normalizarse a 0: se confundiría en silencio con la primera línea real del documento.
  it('deja LineNum en null cuando la posición viene vacía', () => {
    const result = normalizeS4QuotationResponse({
      SalesQuotation: '1',
      to_Item: [{ SalesQuotationItem: '' }],
    });
    expect(result.DocumentLines).toEqual([{ LineNum: null }]);
  });

  it('deja LineNum en null cuando la posición viene null', () => {
    const result = normalizeS4QuotationResponse({
      SalesQuotation: '1',
      to_Item: [{ SalesQuotationItem: null }],
    });
    expect(result.DocumentLines).toEqual([{ LineNum: null }]);
  });
});

describe('B1SalesDocumentAdapter', () => {
  it('delega en el adapter de Quotations de hoy, sin tocar la respuesta', async () => {
    const createQuotation = jest.fn().mockResolvedValue({ DocEntry: 55, DocNum: 900 });
    const adapter = new B1SalesDocumentAdapter({ quotationAdapter: { createQuotation } });

    const result = await adapter.createQuotation({
      sapConfig: { serviceLayerBaseUrl: 'https://b1' },
      quotationPayload: { CardCode: 'CL001' },
    });

    expect(createQuotation).toHaveBeenCalledWith({
      sapConfig: { serviceLayerBaseUrl: 'https://b1' },
      quotationPayload: { CardCode: 'CL001' },
    });
    expect(result).toEqual({ DocEntry: 55, DocNum: 900 });
  });
});

describe('wrapS4TransportWithRecorder', () => {
  // sapCallRecorder.wrap intercepta request(sapConfig, options), que es la firma de B1.
  // El transporte de S/4 recibe UN objeto, así que necesita su propio envoltorio.
  it('graba método, path, query y body de cada llamada', async () => {
    const recorder = createSapCallRecorder();
    const transport = { request: jest.fn().mockResolvedValue({ ok: true }) };
    const recorded = wrapS4TransportWithRecorder(transport, recorder);

    await recorded.request({ method: 'post', path: '/X', query: { $top: 1 }, body: { a: 1 } });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      method: 'POST',
      path: '/X',
      params: { $top: 1 },
      request: { a: 1 },
      ok: true,
    });
  });

  it('graba la llamada que falla y vuelve a lanzar', async () => {
    const recorder = createSapCallRecorder();
    const transport = { request: jest.fn().mockRejectedValue(new Error('gateway 400')) };
    const recorded = wrapS4TransportWithRecorder(transport, recorder);

    await expect(recorded.request({ method: 'post', path: '/X' })).rejects.toThrow('gateway 400');
    expect(recorder.calls[0]).toMatchObject({ ok: false, path: '/X' });
  });

  it('devuelve el transporte tal cual cuando no hay grabador', () => {
    const transport = { request: () => {} };
    expect(wrapS4TransportWithRecorder(transport, null)).toBe(transport);
  });
});
