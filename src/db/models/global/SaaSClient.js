import mongoose from 'mongoose';

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
