import mongoose from 'mongoose';

const { Schema } = mongoose;

export const sapCredentialsSchema = new Schema(
  {
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
      required: true,
    },
    serviceLayerBaseUrl: {
      type: String,
      required: true,
    },
    serviceLayerUsername: {
      type: String,
      required: true,
    },
    serviceLayerPassword: {
      type: String,
      required: true,
    },
    serviceLayerTopFilter: {
      type: Number,
      default: null,
    },
    serviceLayerCompanyDB: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'SapCredentials',
  }
);

sapCredentialsSchema.index(
  { clientConfigId: 1 },
  { unique: true, name: 'uniq_client_config_sap_credentials' }
);

export function createSapCredentialsModel(connection) {
  return (
    connection.models.SapCredentials
    || connection.model('SapCredentials', sapCredentialsSchema)
  );
}
