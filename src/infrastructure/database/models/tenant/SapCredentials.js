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
    // Fixed query params appended to every S4 Gateway request (e.g. { "sap-client": "600" }).
    params: {
      type: Schema.Types.Mixed,
      default: {},
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
