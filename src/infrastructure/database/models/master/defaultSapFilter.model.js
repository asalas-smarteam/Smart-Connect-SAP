import mongoose from 'mongoose';
import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
} from '#domain/sap/sap-flavor.constants.js';
import { SAP_FILTER_OPERATORS } from '#domain/sap/sap-filter.constants.js';

const { Schema } = mongoose;

export const defaultSapFilterSchema = new Schema(
  {
    objectType: {
      type: String,
      required: true,
      index: true,
    },
    // SAP flavor this default applies to. Documents created before this
    // field existed have no value and are treated as B1 on replication.
    sapFlavor: {
      type: String,
      enum: Object.values(SAP_FLAVORS),
      default: DEFAULT_SAP_FLAVOR,
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
    collection: 'DefaultSapFilters',
    timestamps: true,
  }
);

export function createDefaultSapFilterModel(connection) {
  return connection.models.DefaultSapFilter || connection.model('DefaultSapFilter', defaultSapFilterSchema);
}
