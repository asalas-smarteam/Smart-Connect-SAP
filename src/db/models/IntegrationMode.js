import mongoose from 'mongoose';

const { Schema } = mongoose;

const integrationModeSchema = new Schema(
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

export default mongoose.model('IntegrationMode', integrationModeSchema);
