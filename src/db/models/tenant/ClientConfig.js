import mongoose from 'mongoose';

const { Schema } = mongoose;

export const clientConfigSchema = new Schema(
  {
    clientName: {
      type: String,
    },
    integrationModeId: {
      type: Schema.Types.ObjectId,
      ref: 'IntegrationMode',
    },
    apiUrl: {
      type: String,
    },
    apiToken: {
      type: String,
    },
    serviceLayerBaseUrl: {
      type: String,
    },
    serviceLayerPath: {
      type: String,
    },
    serviceLayerUsername: {
      type: String,
    },
    serviceLayerPassword: {
      type: String,
    },
    serviceLayerCompanyDB: {
      type: String,
    },
    storeProcedureName: {
      type: String,
    },
    sqlQuery: {
      type: String,
    },
    intervalMinutes: {
      type: Number,
    },
    externalDbHost: {
      type: String,
    },
    externalDbPort: {
      type: Number,
    },
    externalDbUser: {
      type: String,
    },
    externalDbPassword: {
      type: String,
    },
    externalDbName: {
      type: String,
    },
    externalDbDialect: {
      type: String,
    },
    associationFetchEnabled: {
      type: Boolean,
      default: false,
    },
    associationFetchConfig: {
      type: Schema.Types.Mixed,
      default: null,
    },
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      default: null,
    },
    objectType: {
      type: String,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    lastRun: {
      type: Date,
    },
    lastError: {
      type: String,
    },
    requireUpdateHubspotID: {
      type: Boolean,
      default: false,
    },
    updateMethod: {
      type: String,
    },
    updateSpName: {
      type: String,
    },
    updateTableName: {
      type: String,
    },
  },
  {
    timestamps: false,
    collection: 'ClientConfigs',
  }
);

export function createClientConfigModel(connection) {
  return connection.models.ClientConfig || connection.model('ClientConfig', clientConfigSchema);
}
