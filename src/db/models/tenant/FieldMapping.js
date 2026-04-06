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
      enum: ['businessPartner', 'contactEmployee', 'product', 'ItemWarehouseInfoCollection'],
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
