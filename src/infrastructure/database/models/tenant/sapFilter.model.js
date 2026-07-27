import mongoose from 'mongoose';
import { SAP_FILTER_OPERATORS } from '#domain/sap/sap-filter.constants.js';

const { Schema } = mongoose;

export const sapFilterSchema = new Schema(
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
      enum: SAP_FILTER_OPERATORS,
    },
    // Mixed rather than String: the 'in' operator carries an array of values.
    value: {
      type: Schema.Types.Mixed,
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
    dynamicType: {
      type: String,
      enum: ['datetime', 'date', 'time'],
      default: 'datetime',
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    collection: 'SapFilters',
    timestamps: true,
  }
);

export function createSapFilterModel(connection) {
  return connection.models.SapFilter || connection.model('SapFilter', sapFilterSchema);
}
