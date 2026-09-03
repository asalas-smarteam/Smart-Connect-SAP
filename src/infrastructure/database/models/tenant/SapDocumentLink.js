import mongoose from 'mongoose';

const { Schema } = mongoose;

const sapDocumentLinkLineSchema = new Schema(
  {
    hubspotLineItemId: { type: String, default: null },
    hubspotProductId: { type: String, default: null },
    sku: { type: String, default: null },
    sapLineNum: { type: Number, default: null },
    quantity: { type: Number, default: null },
    unitPrice: { type: Number, default: null },
    warehouseCode: { type: String, default: null },
  },
  { _id: false }
);

const sapDocumentLinkBaseDocumentSchema = new Schema(
  {
    documentType: { type: String, default: null },
    sapObject: { type: String, default: null },
    sapDocEntry: { type: Number, default: null },
    sapDocNum: { type: Number, default: null },
    sapBaseType: { type: Number, default: null },
  },
  { _id: false }
);

export const sapDocumentLinkSchema = new Schema(
  {
    portalId: { type: String, default: null },
    dealId: { type: String, required: true },
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
      default: null,
    },
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    cardCode: { type: String, default: null },
    documentType: {
      type: String,
      enum: ['quotation', 'order', 'inventoryTransferRequest', 'purchaseQuotation'],
      required: true,
    },
    sapObject: { type: String, default: null },
    sapDocEntry: { type: Number, default: null },
    sapDocNum: { type: Number, default: null },
    sapBaseType: { type: Number, default: null },
    status: { type: String, default: 'created' },
    lines: { type: [sapDocumentLinkLineSchema], default: [] },
    baseDocument: { type: sapDocumentLinkBaseDocumentSchema, default: null },
  },
  {
    timestamps: true,
    collection: 'SapDocumentLinks',
  }
);

sapDocumentLinkSchema.index(
  {
    hubspotCredentialId: 1,
    dealId: 1,
    documentType: 1,
  },
  { unique: true }
);

// Entrada de la reconciliación de facturas por linaje SAP. No es único: nada impide dos links
// apuntando al mismo DocEntry si algo se reprocesa, y un índice único ahí rechazaría la
// escritura entera en vez de dejarla pasar. Ante duplicados, findByOrderDocEntry hace un
// findOne sin sort: la lectura toma uno de los dos de forma arbitraria, nadie "decide".
//
// No necesita backfill: sapDocEntry se escribe desde que existe la colección, así que el
// índice cubre los links que ya están en producción. autoIndex está activo en
// mongoose.createConnection (tenantDatabase.js:38), así que se crea solo en los cuatro tenants.
sapDocumentLinkSchema.index({
  hubspotCredentialId: 1,
  documentType: 1,
  sapDocEntry: 1,
});

export function createSapDocumentLinkModel(connection) {
  return (
    connection.models.SapDocumentLink
    || connection.model('SapDocumentLink', sapDocumentLinkSchema)
  );
}

export default createSapDocumentLinkModel;
