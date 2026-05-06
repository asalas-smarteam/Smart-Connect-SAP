const ownerMappingReasons = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_HUBSPOT_CREDENTIAL_ID: 'INVALID_HUBSPOT_CREDENTIAL_ID',
  INVALID_MAPPING_ID: 'INVALID_MAPPING_ID',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
});

function duplicateKey(error) {
  return error?.code === 11000;
}

export class ManageOwnerMappings {
  constructor({ ownerMappingRepository, objectIdValidator }) {
    this.ownerMappingRepository = ownerMappingRepository;
    this.objectIdValidator = objectIdValidator;
  }

  async list({ tenantModels, hubspotCredentialId }) {
    const validation = this.validateHubspotCredentialId(hubspotCredentialId);
    if (validation) return validation;

    const data = await this.ownerMappingRepository.list({ tenantModels, hubspotCredentialId });
    return { ok: true, data };
  }

  async upsert({ tenantModels, hubspotCredentialId, payload }) {
    try {
      const { sapOwnerId, hubspotOwnerId, displayName } = payload || {};

      if (!sapOwnerId || !hubspotOwnerId) {
        return {
          ok: false,
          reason: ownerMappingReasons.BAD_REQUEST,
          message: 'sapOwnerId and hubspotOwnerId are required',
        };
      }

      const existing = await this.ownerMappingRepository.findByHubspotCredentialAndSapOwner({
        tenantModels,
        hubspotCredentialId,
        sapOwnerId,
      });

      if (existing) {
        existing.hubspotOwnerId = hubspotOwnerId;
        existing.hubspotOwnerName = displayName;
        existing.active = true;
        await existing.save();
      } else {
        await this.ownerMappingRepository.create({
          tenantModels,
          payload: {
            hubspotCredentialId,
            sapOwnerId,
            hubspotOwnerId,
            hubspotOwnerName: displayName,
          },
        });
      }

      return { ok: true };
    } catch (error) {
      return this.handleConflict(error);
    }
  }

  async patch({ tenantModels, id, payload }) {
    try {
      const validation = this.validateMappingId(id);
      if (validation) return validation;

      const updatePayload = {};
      const { sapOwnerId, sapOwnerName, active } = payload || {};
      if (Object.hasOwn(payload || {}, 'sapOwnerId')) {
        updatePayload.sapOwnerId = sapOwnerId;
      }
      if (Object.hasOwn(payload || {}, 'sapOwnerName')) {
        updatePayload.sapOwnerName = sapOwnerName;
      }
      if (Object.hasOwn(payload || {}, 'active')) {
        updatePayload.active = active;
      }

      const data = await this.ownerMappingRepository.updateById({
        tenantModels,
        id,
        payload: updatePayload,
      });

      if (!data) {
        return this.notFound();
      }

      return { ok: true, data, meta: { updatePayload } };
    } catch (error) {
      return this.handleConflict(error);
    }
  }

  async delete({ tenantModels, id }) {
    const validation = this.validateMappingId(id);
    if (validation) return validation;

    const data = await this.ownerMappingRepository.deleteById({ tenantModels, id });
    if (!data) {
      return this.notFound();
    }

    return { ok: true, data };
  }

  async create({ tenantModels, payload }) {
    try {
      const {
        hubspotCredentialId,
        hubspotOwnerId,
        hubspotOwnerEmail,
        hubspotOwnerName,
        sapOwnerId,
        sapOwnerName,
      } = payload || {};

      if (!hubspotCredentialId || !hubspotOwnerId) {
        return {
          ok: false,
          reason: ownerMappingReasons.BAD_REQUEST,
          message: 'hubspotCredentialId and hubspotOwnerId are required',
        };
      }

      const validation = this.validateHubspotCredentialId(hubspotCredentialId);
      if (validation) return validation;

      const data = await this.ownerMappingRepository.create({
        tenantModels,
        payload: {
          hubspotCredentialId,
          hubspotOwnerId,
          hubspotOwnerEmail,
          hubspotOwnerName,
          sapOwnerId,
          sapOwnerName,
        },
      });

      return { ok: true, statusCode: 201, data };
    } catch (error) {
      return this.handleConflict(error);
    }
  }

  async get({ tenantModels, id }) {
    const validation = this.validateMappingId(id);
    if (validation) return validation;

    const data = await this.ownerMappingRepository.getById({ tenantModels, id });
    if (!data) {
      return this.notFound();
    }

    return { ok: true, data };
  }

  validateHubspotCredentialId(hubspotCredentialId) {
    if (!hubspotCredentialId) {
      return {
        ok: false,
        reason: ownerMappingReasons.BAD_REQUEST,
        message: 'hubspotCredentialId is required',
      };
    }

    if (!this.objectIdValidator.isValid(hubspotCredentialId)) {
      return {
        ok: false,
        reason: ownerMappingReasons.INVALID_HUBSPOT_CREDENTIAL_ID,
        message: 'Invalid hubspotCredentialId',
      };
    }

    return null;
  }

  validateMappingId(id) {
    if (!this.objectIdValidator.isValid(id)) {
      return {
        ok: false,
        reason: ownerMappingReasons.INVALID_MAPPING_ID,
        message: 'Invalid mapping id',
      };
    }

    return null;
  }

  notFound() {
    return {
      ok: false,
      reason: ownerMappingReasons.NOT_FOUND,
      message: 'Owner mapping not found',
    };
  }

  handleConflict(error) {
    if (duplicateKey(error)) {
      return {
        ok: false,
        reason: ownerMappingReasons.CONFLICT,
        message: 'Owner mapping conflict',
      };
    }

    throw error;
  }
}

export { ownerMappingReasons };

export default ManageOwnerMappings;
