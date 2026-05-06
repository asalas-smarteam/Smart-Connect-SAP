import mongoose from 'mongoose';

const { Schema } = mongoose;

export const integrationModeSchema = new Schema(
  {
    name: {
      type: String,
      unique: true,
    },
    description: {
      type: String,
    },
  },
  {
    timestamps: false,
    collection: 'IntegrationModes',
  }
);

export function createIntegrationModeModel(connection) {
  return (
    connection.models.IntegrationMode
    || connection.model('IntegrationMode', integrationModeSchema)
  );
}
