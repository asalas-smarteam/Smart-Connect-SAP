import mongoose from 'mongoose';

const { Schema } = mongoose;

const clientFilterSchema = new Schema(
  {
    operator: {
      type: String,
      enum: ['eq', 'ge', 'startswith', 'not_startswith'],
      required: true,
    },
    property: {
      type: String,
      required: true,
    },
    value: {
      type: Schema.Types.Mixed,
      default: null,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    isDynamic: {
      type: Boolean,
      default: false,
    },
    editable: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

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
    serviceLayerPath: {
      type: String,
    },
    storeProcedureName: {
      type: String,
    },
    sqlQuery: {
      type: String,
    },
    mode: {
      type: String,
      enum: ['FULL', 'INCREMENTAL'],
      required: true,
      default: 'INCREMENTAL',
    },
    intervalMinutes: {
      type: Number,
      default: null,
    },
    executionTime: {
      type: String,
      default: null,
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
    hubspotBatchSize: {
      type: Number,
      default: 1,
    },
    objectType: {
      type: String,
      default: null,
    },
    filters: {
      type: [clientFilterSchema],
      default: [],
    },
    active: {
      type: Boolean,
      default: false,
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
