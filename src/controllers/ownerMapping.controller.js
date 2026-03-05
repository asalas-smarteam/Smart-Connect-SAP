import {
  createOwnerMapping,
  deleteOwnerMappingById,
  getOwnerMappingById,
  isValidObjectId,
  listOwnerMappings,
  upsertOwnerMapping,
  updateOwnerMappingById,
} from '../services/ownerMapping.service.js';
import { requireTenantModels } from '../utils/tenantModels.js';

function duplicateKey(error) {
  return error?.code === 11000;
}

const ownerMappingController = {
  async listOwners(req, reply) {
    try {
      const { hubspotCredentialId } = req.query || {};
      if (!hubspotCredentialId) {
        return reply.code(400).send({ success: false, message: 'hubspotCredentialId is required' });
      }

      if (!isValidObjectId(hubspotCredentialId)) {
        return reply.code(400).send({ success: false, message: 'Invalid hubspotCredentialId' });
      }

      const tenantModels = requireTenantModels(req);
      const owners = await listOwnerMappings(hubspotCredentialId, tenantModels);

      return reply.send({ success: true, data: owners });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async upsertOwner(req, reply) {
    try {
      const tenantModels = requireTenantModels(req);
      const { hubspotCredentialId } = req.params;
      const { sapOwnerId, hubspotOwnerId, displayName } = req.body || {};

      if (!sapOwnerId || !hubspotOwnerId) {
        return reply.send({ success: false, message: 'sapOwnerId and hubspotOwnerId are required' });
      }

      await upsertOwnerMapping(
        hubspotCredentialId,
        sapOwnerId,
        hubspotOwnerId,
        displayName,
        tenantModels
      );

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async patchOwner(req, reply) {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return reply.code(400).send({ success: false, message: 'Invalid mapping id' });
      }

      const updatePayload = {};
      const { sapOwnerId, sapOwnerName, active } = req.body || {};
      if (Object.hasOwn(req.body || {}, 'sapOwnerId')) {
        updatePayload.sapOwnerId = sapOwnerId;
      }
      if (Object.hasOwn(req.body || {}, 'sapOwnerName')) {
        updatePayload.sapOwnerName = sapOwnerName;
      }
      if (Object.hasOwn(req.body || {}, 'active')) {
        updatePayload.active = active;
      }

      const tenantModels = requireTenantModels(req);
      const updated = await updateOwnerMappingById(id, updatePayload, tenantModels);

      if (!updated) {
        return reply.code(404).send({ success: false, message: 'Owner mapping not found' });
      }

      req.log?.info({ msg: 'Owner mapping updated', id, updatePayload });
      return reply.send({ success: true, data: updated });
    } catch (error) {
      if (duplicateKey(error)) {
        return reply.code(409).send({ success: false, message: 'Owner mapping conflict' });
      }
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async deleteOwner(req, reply) {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return reply.code(400).send({ success: false, message: 'Invalid mapping id' });
      }

      const tenantModels = requireTenantModels(req);
      const deleted = await deleteOwnerMappingById(id, tenantModels);
      if (!deleted) {
        return reply.code(404).send({ success: false, message: 'Owner mapping not found' });
      }

      req.log?.info({ msg: 'Owner mapping deleted', id });
      return reply.send({ success: true, data: deleted });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async createOwner(req, reply) {
    try {
      const {
        hubspotCredentialId,
        hubspotOwnerId,
        hubspotOwnerEmail,
        hubspotOwnerName,
        sapOwnerId,
        sapOwnerName,
      } = req.body || {};

      if (!hubspotCredentialId || !hubspotOwnerId) {
        return reply
          .code(400)
          .send({ success: false, message: 'hubspotCredentialId and hubspotOwnerId are required' });
      }

      if (!isValidObjectId(hubspotCredentialId)) {
        return reply.code(400).send({ success: false, message: 'Invalid hubspotCredentialId' });
      }

      const tenantModels = requireTenantModels(req);
      const created = await createOwnerMapping(
        {
          hubspotCredentialId,
          hubspotOwnerId,
          hubspotOwnerEmail,
          hubspotOwnerName,
          sapOwnerId,
          sapOwnerName,
        },
        tenantModels
      );

      req.log?.info({ msg: 'Owner mapping created', id: created._id });
      return reply.code(201).send({ success: true, data: created });
    } catch (error) {
      if (duplicateKey(error)) {
        return reply.code(409).send({ success: false, message: 'Owner mapping conflict' });
      }
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async getOwner(req, reply) {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return reply.code(400).send({ success: false, message: 'Invalid mapping id' });
      }

      const tenantModels = requireTenantModels(req);
      const owner = await getOwnerMappingById(id, tenantModels);
      if (!owner) {
        return reply.code(404).send({ success: false, message: 'Owner mapping not found' });
      }

      return reply.send({ success: true, data: owner });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },
};

export default ownerMappingController;
