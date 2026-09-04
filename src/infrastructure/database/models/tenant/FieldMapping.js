import mongoose from 'mongoose';

const { Schema } = mongoose;

export const fieldMappingSchema = new Schema(
  {
    sourceField: {
      type: String,
    },
    targetField: {
      type: String,
    },
    objectType: {
      type: String,
    },
    sourceContext: {
      type: String,
      enum: [
        'businessPartner',
        'contactEmployee',
        // Campos de BPAddresses[]. Se mapean con objectType: 'address' porque el
        // array llega como entidad propia en el payload del webhook y no depende
        // de si el BusinessPartner es una company o un contact de HubSpot.
        'bpAddress',
        'product',
        'ItemWarehouseInfoCollection',
        'orders-quotations',
        'inventory-transfer-request',
        // Purchase Quotation (OPQT). Contexto propio y no reutiliza orders-quotations a
        // proposito: es un documento de COMPRA, su CardCode es un proveedor y sus campos de
        // cabecera/linea no son los mismos que los de venta.
        'purchase-quotations',
      ],
      default: '',
    },
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
    },
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    editable: {
      type: Boolean,
      default: true,
    },
    includeInServiceLayerSelect: {
      type: Boolean,
      default: true,
    },
    // El valor de este mapeo es un USUARIO, no un dato: en SAP viaja el código
    // del empleado de ventas (SalesPersonCode = 600) y en HubSpot el ownerId
    // del portal (123123123). Con el flag en true la integración traduce el
    // valor contra la colección OwnerMappings.
    //
    // Solo aplica de SAP -> HubSpot (tareas programadas) y solo en tenants B1.
    // La dirección inversa (webhooks que crean BusinessPartners o documentos)
    // queda fuera por decisión explícita, así que marcar un mapeo de esos
    // contextos no tiene efecto.
    //
    // Es una marca POR MAPEO y no una lista de campos por tenant a propósito:
    // el mismo `SalesPersonCode` alimenta `propietario_del_contacto_resma_tmk`
    // (propiedad de tipo OWNER, necesita el ownerId) y `slpcode` (un número
    // suelto que debe llegar sin tocar), así que la decisión no se puede tomar
    // por nombre de campo. Ver src/domain/owners/owner-directory.service.js.
    userField: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: false,
    collection: 'FieldMappings',
  }
);


fieldMappingSchema.index(
  {
    hubspotCredentialId: 1,
    objectType: 1,
    sourceContext: 1,
    sourceField: 1,
  },
  { unique: true }
);

export function createFieldMappingModel(connection) {
  if (connection.models.FieldMapping) {
    return connection.models.FieldMapping;
  }

  const model = connection.model('FieldMapping', fieldMappingSchema);

  model.createIndexes().catch((error) => {
    if (error?.code === 11000 || /E11000/.test(error?.message || '')) {
      console.warn('Skipping FieldMapping unique index creation due to duplicate existing documents.');
      return;
    }

    console.warn('FieldMapping index creation warning:', error?.message || error);
  });

  return model;
}
