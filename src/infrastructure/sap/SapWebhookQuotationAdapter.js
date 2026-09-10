import { sapServiceLayerWebhookRequest } from './sapServiceLayerWebhookRequest.js';

export class SapWebhookQuotationAdapter {
  async request(sapConfig, options) {
    return sapServiceLayerWebhookRequest(sapConfig, options);
  }

  async createQuotation({ sapConfig, quotationPayload }) {
    return this.request(sapConfig, {
      method: 'post',
      path: '/Quotations',
      data: quotationPayload,
    });
  }

  async getQuotation({ sapConfig, docEntry }) {
    return this.request(sapConfig, {
      method: 'get',
      path: `/Quotations(${encodeURIComponent(String(docEntry))})`,
    });
  }

  // `replaceCollections` prende B1S-ReplaceCollectionsOnPatch, que cambia la semantica de las
  // colecciones que vienen en el body: una fila cuyo LineNum NO viaja se ELIMINA, en vez de
  // conservarse. Es la unica via del Service Layer para borrar una linea de documento -- las
  // lineas no son una entidad direccionable, asi que no existe un DELETE para ellas.
  //
  // Medido contra SBO_DISTELSA_PROD (Service Layer 1000260, B1 10.0), porque SAP no lo documenta
  // en estos terminos (detalle en docs/superpowers/specs/2026-09-10-quotation-line-add-remove-design.md):
  // - con LineNum explicito, una fila presente se actualiza y CONSERVA los campos que el body no
  //   trae, asi que las correcciones hechas a mano en SAP no se pierden y no hace falta reenviar
  //   la linea completa;
  // - solo afecta las colecciones PRESENTES en el body: DocumentSpecialLines sobrevive intacta a
  //   un replace de DocumentLines.
  //
  // Default apagado a proposito: sin el, ningun otro llamador cambia de comportamiento.
  async updateQuotation({ sapConfig, docEntry, patchPayload, replaceCollections = false }) {
    return this.request(sapConfig, {
      method: 'patch',
      path: `/Quotations(${encodeURIComponent(String(docEntry))})`,
      data: patchPayload,
      headers: replaceCollections ? { 'B1S-ReplaceCollectionsOnPatch': 'true' } : undefined,
    });
  }
}

export default SapWebhookQuotationAdapter;
