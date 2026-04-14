import mongoose from 'mongoose';

const { Schema } = mongoose;

export const configurationSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: String,
      required: true,
      trim: true,
    },
    userUpdated: {
      type: String,
      default: 'admin',
      trim: true,
    },
  },
  {
    timestamps: {
      createdAt: 'createAt',
      updatedAt: 'updateAt',
    },
    collection: 'Configurations',
  }
);

configurationSchema.index(
  { key: 1 },
  { unique: true, name: 'uniq_configuration_key' }
);

export function createConfigurationModel(connection) {
  return (
    connection.models.Configuration
    || connection.model('Configuration', configurationSchema)
  );
}
