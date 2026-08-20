export class MongooseSapDocumentLinkRepository {
  async findByDeal({ SapDocumentLink, hubspotCredentialId, dealId, documentType }) {
    if (!SapDocumentLink || !dealId || !documentType) {
      return null;
    }

    const query = SapDocumentLink.findOne({
      hubspotCredentialId,
      dealId: String(dealId),
      documentType,
    });

    return typeof query?.lean === 'function' ? query.lean() : query;
  }

  // Entrada de la reconciliación de facturas: la factura trae el DocEntry de su orden en
  // DocumentLines[].BaseEntry, y desde el link se llega al dealId. documentType va fijo en
  // 'order' porque los DocEntry de SAP son secuencias por objeto: sin ese filtro, el DocEntry
  // 500 de una cotización matchearía con la orden 500, que es otro documento.
  async findByOrderDocEntry({ SapDocumentLink, hubspotCredentialId, sapDocEntry }) {
    // Sin este chequeo, un hubspotCredentialId undefined desaparece del filtro (Mongoose
    // lo descarta) y la consulta se abre a TODOS los links de orden del tenant, lo que
    // puede mover el negocio equivocado a cerrado-ganado.
    if (!SapDocumentLink || !hubspotCredentialId || !Number.isInteger(sapDocEntry)) {
      return null;
    }

    const query = SapDocumentLink.findOne({
      hubspotCredentialId,
      documentType: 'order',
      sapDocEntry,
    });

    return typeof query?.lean === 'function' ? query.lean() : query;
  }

  async create({ SapDocumentLink, link }) {
    if (!SapDocumentLink || !link) {
      return null;
    }

    const created = await SapDocumentLink.create(link);
    return typeof created?.toObject === 'function' ? created.toObject() : created;
  }

  async updateLines({ SapDocumentLink, id, lines }) {
    if (!SapDocumentLink || !id) {
      return null;
    }

    return SapDocumentLink.updateOne(
      { _id: id },
      {
        $set: {
          lines: Array.isArray(lines) ? lines : [],
        },
      }
    );
  }
}

export default MongooseSapDocumentLinkRepository;
