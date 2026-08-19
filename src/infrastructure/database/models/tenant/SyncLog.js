import mongoose from 'mongoose';

const { Schema } = mongoose;

export const syncLogSchema = new Schema(
  {
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
    },
    objectType: {
      type: String,
      enum: ['Product', 'Contact', 'Deal', 'Company', 'Invoice'],
      default: null,
    },
    status: {
      type: String,
      enum: ['completed', 'errored'],
      default: null,
    },
    recordsProcessed: {
      type: Number,
      default: 0,
    },
    sent: {
      type: Number,
      default: 0,
    },
    failed: {
      type: Number,
      default: 0,
    },
    // `sent` por sí solo no dice si la corrida tuvo efecto: un handler puede
    // descartar cada registro y terminar en verde. Estos tres campos son lo que
    // permite auditar una corrida sin volver a leer el código.
    updated: {
      type: Number,
      default: 0,
    },
    skipped: {
      type: Number,
      default: 0,
    },
    skippedReasons: {
      type: [
        new Schema(
          {
            reason: { type: String, required: true },
            count: { type: Number, default: 0 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    errorMessage: {
      type: Schema.Types.Mixed,
      default: null,
    },
    errors: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    startedAt: {
      type: Date,
    },
    finishedAt: {
      type: Date,
    },
  },
  {
    timestamps: false,
    collection: 'SyncLogs',
  }
);

export function createSyncLogModel(connection) {
  return connection.models.SyncLog || connection.model('SyncLog', syncLogSchema);
}
