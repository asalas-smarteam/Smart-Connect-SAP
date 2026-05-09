import mongoose from 'mongoose';

const { Schema } = mongoose;

export const defaultSapFilterSchema = new Schema(
  {
    objectType: {
      type: String,
      required: true,
      index: true,
    },
    property: {
      type: String,
      required: true,
    },
    operator: {
      type: String,
      required: true,
      enum: ['eq', 'ge', 'startswith', 'not_startswith'],
    },
    value: {
      type: String,
      default: null,
    },
    isDefault: {
      type: Boolean,
      default: true,
    },
    isDynamic: {
      type: Boolean,
      default: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    collection: 'DefaultSapFilters',
    timestamps: true,
  }
);

export function createDefaultSapFilterModel(connection) {
  return connection.models.DefaultSapFilter || connection.model('DefaultSapFilter', defaultSapFilterSchema);
}
