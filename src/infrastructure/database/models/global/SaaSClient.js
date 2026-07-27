import mongoose from 'mongoose';
import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
} from '#domain/sap/sap-flavor.constants.js';

const { Schema } = mongoose;

const hubspotMetadataSchema = new Schema(
  {
    portalId: { type: String },
    appID: { type: String },
    accessToken: { type: String },
    refreshToken: { type: String },
    expiresAt: { type: Date },
    scope: { type: String },
    appMetadata: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const saasClientSchema = new Schema(
  {
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    tenantKey: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'suspended'],
      default: 'inactive',
    },
    billingEmail: {
      type: String,
      default: null,
    },
    // SAP product family the tenant connects to. Existing documents predate
    // this field; runtime reads the tenant Configuration key instead, so a
    // missing value here is informational only and implies B1.
    sapFlavor: {
      type: String,
      enum: Object.values(SAP_FLAVORS),
      default: DEFAULT_SAP_FLAVOR,
    },
    hubspot: {
      type: hubspotMetadataSchema,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: 'SaaSClients',
  }
);

saasClientSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('SaaSClient', saasClientSchema);
