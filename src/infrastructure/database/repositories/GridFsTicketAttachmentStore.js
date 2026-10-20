import mongoose from 'mongoose';
import { once } from 'node:events';
import defaultLogger from '#infrastructure/logger/logger.adapter.js';
import { getPanelTenantModels } from './panelTenantModels.js';

const BUCKET_NAME = 'TicketAttachments';
const OBJECT_ID = /^[0-9a-f]{24}$/i;

function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

// Imágenes de los tickets en GridFS, en la base del tenant (bucket TicketAttachments).
// Cada archivo guarda metadata.ticketId y metadata.contentType (el tipo detectado por bytes).
export class GridFsTicketAttachmentStore {
  constructor({ getModels = getPanelTenantModels, logger = defaultLogger, createBucket } = {}) {
    this.getModels = getModels;
    this.logger = logger;
    this.createBucket = createBucket
      ?? ((connection) => new mongoose.mongo.GridFSBucket(connection.db, { bucketName: BUCKET_NAME }));
  }

  async bucketFor(tenantKey) {
    const { connection } = await this.getModels(tenantKey);
    return this.createBucket(connection);
  }

  async put(tenantKey, { ticketId, filename, contentType, data }) {
    const bucket = await this.bucketFor(tenantKey);
    const upload = bucket.openUploadStream(filename, {
      metadata: { ticketId: String(ticketId), contentType },
    });
    const finished = once(upload, 'finish');
    try {
      upload.end(data);
      await finished;
    } catch (error) {
      // Borra los chunks que alcanzaron a escribirse: si no, quedarían huérfanos sin id conocido.
      await upload.abort().catch(() => {});
      throw error;
    }

    return {
      fileId: String(upload.id),
      filename,
      contentType,
      size: data.length,
    };
  }

  // null si el archivo no existe o no es de ese ticket: el ticket ya se validó contra el tenant.
  async open(tenantKey, { ticketId, fileId }) {
    if (!isObjectId(fileId)) {
      return null;
    }
    const bucket = await this.bucketFor(tenantKey);
    const id = new mongoose.Types.ObjectId(fileId);
    const [file] = await bucket
      .find({ _id: id, 'metadata.ticketId': String(ticketId) })
      .limit(1)
      .toArray();
    if (!file) {
      return null;
    }

    return {
      stream: bucket.openDownloadStream(id),
      contentType: file.metadata?.contentType ?? 'application/octet-stream',
      size: file.length,
    };
  }

  async remove(tenantKey, fileIds = []) {
    const ids = fileIds.filter(isObjectId);
    if (ids.length === 0) {
      return;
    }
    try {
      const bucket = await this.bucketFor(tenantKey);
      await Promise.all(ids.map(async (fileId) => {
        try {
          await bucket.delete(new mongoose.Types.ObjectId(fileId));
        } catch (error) {
          this.logger.warn({ msg: 'Panel ticket attachment cleanup failed', tenantKey, fileId, error: error?.message });
        }
      }));
    } catch (error) {
      this.logger.warn({ msg: 'Panel ticket attachment cleanup failed', tenantKey, error: error?.message });
    }
  }
}

export default GridFsTicketAttachmentStore;
