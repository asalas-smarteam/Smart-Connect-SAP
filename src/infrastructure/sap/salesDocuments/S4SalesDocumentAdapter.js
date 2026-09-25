import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

const SALES_QUOTATION_PATH = '/API_SALES_QUOTATION_SRV/A_SalesQuotation';

// OData v2 devuelve las colecciones como `{ results: [...] }`. S4GatewayTransport ya
// desenvuelve lo que puede (odataV2Normalizer), pero una navegación anidada en la respuesta
// de un POST puede llegar cruda, así que se contemplan las dos formas.
function readCollection(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return Array.isArray(value?.results) ? value.results : [];
}

// OJO con normalizeNumber a secas: `Number('')` y `Number(null)` valen 0, que ES finito. La
// guardia de descartar el vacío con toNonEmptyString ANTES de parsear aplica tanto al número
// de documento como al de posición: para el documento, un 0 falso guardaría un DocEntry que
// apunta a un documento inexistente; para la posición el daño es peor, porque 0 SÍ es un
// LineNum legítimo en el modelo de Business One, así que una posición corrupta (una línea
// borrada, un payload malformado del gateway) se confundiría en silencio con la primera línea
// real del documento en vez de quedar señalizada como inválida. Se extrae a una función con
// nombre para que el patrón viva en un solo sitio y no se repita el olvido.
function parseFiniteNumberOrNull(value) {
  const rawValue = toNonEmptyString(value);
  const parsed = rawValue === null ? null : normalizeNumber(rawValue, null);
  return Number.isFinite(parsed) ? parsed : null;
}

// S/4 tiene UN solo número de documento, así que DocEntry y DocNum son el mismo valor. Las
// posiciones son '000010', '000020': se guardan como 10, 20, que es lo que el modelo de
// SapDocumentLink acepta en sapLineNum (Number).
export function normalizeS4QuotationResponse(raw) {
  const documentNumber = parseFiniteNumberOrNull(raw?.SalesQuotation);

  return {
    DocEntry: documentNumber,
    DocNum: documentNumber,
    DocumentLines: readCollection(raw?.to_Item).map((item) => ({
      LineNum: parseFiniteNumberOrNull(item?.SalesQuotationItem),
    })),
    raw,
  };
}

export class S4SalesDocumentAdapter {
  constructor({ transport }) {
    if (!transport) {
      throw new Error('transport is required for S4SalesDocumentAdapter');
    }
    this.transport = transport;
  }

  // `sapConfig` se acepta y se ignora: el transporte ya se construyó con él en la factory.
  // Está en la firma porque el puerto es uno solo para los dos flavors.
  async createQuotation({ quotationPayload }) {
    const created = await this.transport.request({
      method: 'post',
      path: SALES_QUOTATION_PATH,
      body: quotationPayload,
    });

    return normalizeS4QuotationResponse(created);
  }
}

export default S4SalesDocumentAdapter;
