import { listOwnerMappings, upsertOwnerMapping } from '../services/dealOwnerMapping.service.js';
import { requireTenantModels } from '../utils/tenantModels.js';

const dealOwnerMappingController = {
  async listOwners(req, reply) {
    try {
      const { hubspotCredentialId } = req.params;
      const tenantModels = requireTenantModels(req);
      const owners = await listOwnerMappings(hubspotCredentialId, tenantModels);

      return reply.send({ ok: true, owners });
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  },

  async upsertOwner(req, reply) {
    try {
      const tenantModels = requireTenantModels(req);
      const { hubspotCredentialId } = req.params;
      const { sapOwnerId, hubspotOwnerId, displayName } = req.body || {};

      if (!sapOwnerId || !hubspotOwnerId) {
        return reply.send({ ok: false, message: 'sapOwnerId and hubspotOwnerId are required' });
      }

      await upsertOwnerMapping(
        hubspotCredentialId,
        sapOwnerId,
        hubspotOwnerId,
        displayName,
        tenantModels
      );

      return reply.send({ ok: true });
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  },
};

export default dealOwnerMappingController;
