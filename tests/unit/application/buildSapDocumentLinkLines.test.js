import { buildSapDocumentLinkLines } from '../../../src/application/use-cases/webhookQuotationSupport.js';

const LINE_ITEMS = [
  { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '2' },
  { hubspot_id: 'li-2', hs_sku: 'A02', quantity: '3' },
];

describe('buildSapDocumentLinkLines: sapLineNum', () => {
  // Camino de Business One: la respuesta trae LineNum entero. 0 es una posición legítima y
  // tiene que guardarse como 0, no caer al índice.
  it('B1: usa el LineNum que devolvió SAP, incluido el 0', () => {
    const lines = buildSapDocumentLinkLines({
      lineItems: LINE_ITEMS,
      documentLines: [{ ItemCode: 'A01' }, { ItemCode: 'A02' }],
      responseLines: [{ LineNum: 0 }, { LineNum: 5 }],
    });

    expect(lines.map((line) => line.sapLineNum)).toEqual([0, 5]);
  });

  // En B1 la clave llega AUSENTE cuando no hay posición: ese caso ya caía al índice y sigue
  // cayendo al índice.
  it('B1: sin la clave LineNum cae al índice, como hasta ahora', () => {
    const lines = buildSapDocumentLinkLines({
      lineItems: LINE_ITEMS,
      documentLines: [],
      responseLines: [{}, {}],
    });

    expect(lines.map((line) => line.sapLineNum)).toEqual([0, 1]);
  });

  it('B1: sin responseLines cae al índice', () => {
    const lines = buildSapDocumentLinkLines({
      lineItems: LINE_ITEMS,
      documentLines: [],
      responseLines: undefined,
    });

    expect(lines.map((line) => line.sapLineNum)).toEqual([0, 1]);
  });

  // El adapter de S/4 produce null a propósito para una posición sin número. `Number(null)` es
  // 0, que es finito: con normalizeNumber esa posición se guardaba como la posición 0 y el
  // respaldo por índice nunca corría. La segunda línea terminaba apuntando a la primera.
  it('S/4: un LineNum nulo cae al índice en vez de guardarse como 0', () => {
    const lines = buildSapDocumentLinkLines({
      lineItems: LINE_ITEMS,
      documentLines: [],
      responseLines: [{ LineNum: null }, { LineNum: null }],
    });

    expect(lines.map((line) => line.sapLineNum)).toEqual([0, 1]);
  });

  it('S/4: un LineNum vacío también cae al índice', () => {
    const lines = buildSapDocumentLinkLines({
      lineItems: LINE_ITEMS,
      documentLines: [],
      responseLines: [{ LineNum: '' }, { LineNum: '  ' }],
    });

    expect(lines.map((line) => line.sapLineNum)).toEqual([0, 1]);
  });

  it('S/4: las posiciones normalizadas (10, 20) se guardan tal cual', () => {
    const lines = buildSapDocumentLinkLines({
      lineItems: LINE_ITEMS,
      documentLines: [],
      responseLines: [{ LineNum: 10 }, { LineNum: 20 }],
    });

    expect(lines.map((line) => line.sapLineNum)).toEqual([10, 20]);
  });
});
