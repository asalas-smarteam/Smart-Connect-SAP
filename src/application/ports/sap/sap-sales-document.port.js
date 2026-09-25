import { createPort } from '../port-validator.js';

// Envío de documentos de venta. Toda implementación devuelve la MISMA forma, la de B1
// (`{ DocEntry, DocNum, DocumentLines: [{LineNum}], raw }`), para que el caso de uso, el
// repositorio de SapDocumentLink y el write-back a HubSpot no sepan de qué SAP se trata.
export const SapSalesDocumentPort = createPort({
  name: 'SapSalesDocumentPort',
  methods: [
    // createQuotation({ sapConfig, quotationPayload }) -> { DocEntry, DocNum, DocumentLines, raw }
    'createQuotation',
  ],
});

export default SapSalesDocumentPort;
