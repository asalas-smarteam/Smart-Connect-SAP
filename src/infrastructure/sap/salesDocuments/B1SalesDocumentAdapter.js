// Envoltorio fino sobre el adapter de Quotations que ya corre en producción. No cambia su
// respuesta: el caso de uso ya la sabe leer, y este puerto define esa forma como el contrato.
export class B1SalesDocumentAdapter {
  constructor({ quotationAdapter }) {
    if (!quotationAdapter) {
      throw new Error('quotationAdapter is required for B1SalesDocumentAdapter');
    }
    this.quotationAdapter = quotationAdapter;
  }

  async createQuotation({ sapConfig, quotationPayload }) {
    return this.quotationAdapter.createQuotation({ sapConfig, quotationPayload });
  }
}

export default B1SalesDocumentAdapter;
