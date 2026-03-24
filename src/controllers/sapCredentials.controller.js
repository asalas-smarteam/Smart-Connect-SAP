import mongoose from 'mongoose';
import { requireTenantModels } from '../utils/tenantModels.js';

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizePayload(payload = {}, { partial = false } = {}) {
  const data = {};

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'clientConfigId')) {
    data.clientConfigId = payload.clientConfigId;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'serviceLayerBaseUrl')) {
    data.serviceLayerBaseUrl = normalizeBaseUrl(payload.serviceLayerBaseUrl);
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'serviceLayerUsername')) {
    data.serviceLayerUsername = String(payload.serviceLayerUsername || '').trim();
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'serviceLayerPassword')) {
    data.serviceLayerPassword = String(payload.serviceLayerPassword || '').trim();
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'serviceLayerTopFilter')) {
    if (payload.serviceLayerTopFilter === null || typeof payload.serviceLayerTopFilter === 'undefined') {
      data.serviceLayerTopFilter = null;
    } else {
      const parsed = Number(payload.serviceLayerTopFilter);
      if (Number.isNaN(parsed)) {
        throw new Error('serviceLayerTopFilter must be a number');
      }
      data.serviceLayerTopFilter = parsed;
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'serviceLayerCompanyDB')) {
    const companyDb = String(payload.serviceLayerCompanyDB || '').trim();
    data.serviceLayerCompanyDB = companyDb || null;
  }

  return data;
}

function validateRequiredOnCreate(payload) {
  const requiredFields = [
    'clientConfigId',
    'serviceLayerBaseUrl',
    'serviceLayerUsername',
    'serviceLayerPassword',
  ];

  const missing = requiredFields.filter((field) => !payload[field]);
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  if (!isValidObjectId(payload.clientConfigId)) {
    throw new Error('clientConfigId is invalid');
  }
}

const sapCredentialsController = {
  async createSapCredentials(req, reply) {
    try {
      const { SapCredentials, ClientConfig } = requireTenantModels(req);
      const payload = normalizePayload(req.body, { partial: false });
      validateRequiredOnCreate(payload);

      const clientConfig = await ClientConfig.findById(payload.clientConfigId).lean();
      if (!clientConfig) {
        return reply.code(404).send({ ok: false, message: 'ClientConfig not found' });
      }

      const created = await SapCredentials.create(payload);
      return reply.code(201).send({ ok: true, data: created });
    } catch (error) {
      if (error?.code === 11000) {
        return reply.code(409).send({ ok: false, message: 'SAP credentials already exist for this clientConfigId' });
      }
      const status = /required|invalid|must be a number|Missing required fields/.test(error.message)
        ? 400
        : 500;
      return reply.code(status).send({ ok: false, message: error.message });
    }
  },

  async listSapCredentials(req, reply) {
    try {
      const { SapCredentials } = requireTenantModels(req);
      const { clientConfigId } = req.query || {};
      const filter = {};

      if (clientConfigId) {
        if (!isValidObjectId(clientConfigId)) {
          return reply.code(400).send({ ok: false, message: 'clientConfigId is invalid' });
        }
        filter.clientConfigId = clientConfigId;
      }

      const data = await SapCredentials.find(filter).sort({ createdAt: -1 });
      return reply.send({ ok: true, data });
    } catch (error) {
      return reply.code(500).send({ ok: false, message: error.message });
    }
  },

  async getSapCredentials(req, reply) {
    try {
      const { SapCredentials } = requireTenantModels(req);
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return reply.code(400).send({ ok: false, message: 'Invalid SAP credentials id' });
      }

      const data = await SapCredentials.findById(id);
      if (!data) {
        return reply.code(404).send({ ok: false, message: 'SAP credentials not found' });
      }

      return reply.send({ ok: true, data });
    } catch (error) {
      return reply.code(500).send({ ok: false, message: error.message });
    }
  },

  async patchSapCredentials(req, reply) {
    try {
      const { SapCredentials, ClientConfig } = requireTenantModels(req);
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return reply.code(400).send({ ok: false, message: 'Invalid SAP credentials id' });
      }

      const payload = normalizePayload(req.body, { partial: true });
      delete payload._id;

      if (Object.prototype.hasOwnProperty.call(payload, 'clientConfigId')) {
        if (!isValidObjectId(payload.clientConfigId)) {
          return reply.code(400).send({ ok: false, message: 'clientConfigId is invalid' });
        }

        const clientConfig = await ClientConfig.findById(payload.clientConfigId).lean();
        if (!clientConfig) {
          return reply.code(404).send({ ok: false, message: 'ClientConfig not found' });
        }
      }

      const updated = await SapCredentials.findByIdAndUpdate(id, payload, {
        new: true,
        runValidators: true,
      });

      if (!updated) {
        return reply.code(404).send({ ok: false, message: 'SAP credentials not found' });
      }

      return reply.send({ ok: true, data: updated });
    } catch (error) {
      if (error?.code === 11000) {
        return reply.code(409).send({ ok: false, message: 'SAP credentials already exist for this clientConfigId' });
      }
      const status = /required|invalid|must be a number/.test(error.message) ? 400 : 500;
      return reply.code(status).send({ ok: false, message: error.message });
    }
  },

  async deleteSapCredentials(req, reply) {
    try {
      const { SapCredentials } = requireTenantModels(req);
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return reply.code(400).send({ ok: false, message: 'Invalid SAP credentials id' });
      }

      const deleted = await SapCredentials.findByIdAndDelete(id);
      if (!deleted) {
        return reply.code(404).send({ ok: false, message: 'SAP credentials not found' });
      }

      return reply.send({ ok: true, data: deleted });
    } catch (error) {
      return reply.code(500).send({ ok: false, message: error.message });
    }
  },
};

export default sapCredentialsController;
