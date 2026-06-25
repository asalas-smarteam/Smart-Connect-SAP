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
