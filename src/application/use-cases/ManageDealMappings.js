const dealMappingReasons = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_HUBSPOT_CREDENTIAL_ID: 'INVALID_HUBSPOT_CREDENTIAL_ID',
  INVALID_MAPPING_ID: 'INVALID_MAPPING_ID',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
});

function duplicateKey(error) {
  return error?.code === 11000;
}

export class ManageDealMappings {
  constructor({ dealMappingRepository, objectIdValidator }) {
    this.dealMappingRepository = dealMappingRepository;
    this.objectIdValidator = objectIdValidator;
  }

  async listPipelines({ tenantModels, hubspotCredentialId }) {
    const validation = this.validateHubspotCredentialId(hubspotCredentialId);
    if (validation) return validation;

    const data = await this.dealMappingRepository.listPipelines({
      tenantModels,
      hubspotCredentialId,
    });
    return { ok: true, data };
  }

  async listStages({ tenantModels, hubspotCredentialId, hubspotPipelineId }) {
    const validation = this.validateHubspotCredentialId(hubspotCredentialId);
    if (validation) return validation;

    const data = await this.dealMappingRepository.listStages({
      tenantModels,
      hubspotCredentialId,
      hubspotPipelineId,
    });
    return { ok: true, data };
  }

  async upsertPipeline({ tenantModels, hubspotCredentialId, payload }) {
    const { sapPipelineKey, hubspotPipelineId, hubspotPipelineLabel, description } = payload || {};
    const existing = await this.dealMappingRepository.findPipeline({
      tenantModels,
      hubspotCredentialId,
      sapPipelineKey,
    });
    const data = { hubspotPipelineId, hubspotPipelineLabel, description };

    if (existing) {
      existing.set(data);
      await existing.save();
    } else {
      await this.dealMappingRepository.createPipeline({
        tenantModels,
        payload: { ...data, hubspotCredentialId, sapPipelineKey },
      });
    }

    return { ok: true };
  }

  async upsertStage({ tenantModels, hubspotCredentialId, payload }) {
    const { sapStageKey, hubspotStageId, hubspotStageLabel, hubspotPipelineId, description } =
      payload || {};
    const existing = await this.dealMappingRepository.findStage({
      tenantModels,
      hubspotCredentialId,
      sapStageKey,
      hubspotPipelineId,
    });
    const data = { hubspotStageId, hubspotStageLabel, description };

    if (existing) {
      existing.set(data);
      await existing.save();
    } else {
      await this.dealMappingRepository.createStage({
        tenantModels,
        payload: { ...data, hubspotCredentialId, sapStageKey, hubspotPipelineId },
      });
    }

    return { ok: true };
  }

  async createPipeline({ tenantModels, payload }) {
    try {
      if (!payload?.hubspotCredentialId || !payload?.hubspotPipelineId) {
        return {
          ok: false,
          reason: dealMappingReasons.BAD_REQUEST,
          message: 'hubspotCredentialId and hubspotPipelineId are required',
        };
      }

      const validation = this.validateHubspotCredentialId(payload.hubspotCredentialId);
      if (validation) return validation;

      const data = await this.dealMappingRepository.createPipeline({ tenantModels, payload });
      return { ok: true, statusCode: 201, data };
    } catch (error) {
      return this.handleConflict(error, 'Pipeline mapping conflict');
    }
  }

  async patchPipeline({ tenantModels, id, payload }) {
    try {
      const validation = this.validateMappingId(id);
      if (validation) return validation;

      const updatePayload = this.buildPatchPayload(payload, ['sapPipelineKey', 'description']);
      const data = await this.dealMappingRepository.updatePipelineById({
        tenantModels,
        id,
        payload: updatePayload,
      });

      if (!data) {
        return this.notFound('Pipeline mapping not found');
      }

      return { ok: true, data, meta: { updatePayload } };
    } catch (error) {
      return this.handleConflict(error, 'Pipeline mapping conflict');
    }
  }

  async deletePipeline({ tenantModels, id }) {
    const validation = this.validateMappingId(id);
    if (validation) return validation;

    const data = await this.dealMappingRepository.deletePipelineById({ tenantModels, id });
    if (!data) {
      return this.notFound('Pipeline mapping not found');
    }

    return { ok: true, data };
  }

  async createStage({ tenantModels, payload }) {
    try {
      if (!payload?.hubspotCredentialId || !payload?.hubspotPipelineId || !payload?.hubspotStageId) {
        return {
          ok: false,
          reason: dealMappingReasons.BAD_REQUEST,
          message: 'hubspotCredentialId, hubspotPipelineId and hubspotStageId are required',
        };
      }

      const validation = this.validateHubspotCredentialId(payload.hubspotCredentialId);
      if (validation) return validation;

      const data = await this.dealMappingRepository.createStage({ tenantModels, payload });
      return { ok: true, statusCode: 201, data };
    } catch (error) {
      return this.handleConflict(error, 'Stage mapping conflict');
    }
  }

  async patchStage({ tenantModels, id, payload }) {
    try {
      const validation = this.validateMappingId(id);
      if (validation) return validation;

      const updatePayload = this.buildPatchPayload(payload, ['sapStageKey', 'description']);
      const data = await this.dealMappingRepository.updateStageById({
        tenantModels,
        id,
        payload: updatePayload,
      });

      if (!data) {
        return this.notFound('Stage mapping not found');
      }

      return { ok: true, data, meta: { updatePayload } };
    } catch (error) {
      return this.handleConflict(error, 'Stage mapping conflict');
    }
  }

  async deleteStage({ tenantModels, id }) {
    const validation = this.validateMappingId(id);
    if (validation) return validation;

    const data = await this.dealMappingRepository.deleteStageById({ tenantModels, id });
    if (!data) {
      return this.notFound('Stage mapping not found');
    }

    return { ok: true, data };
  }

  buildPatchPayload(payload = {}, allowedKeys) {
    return allowedKeys.reduce((updatePayload, key) => {
      if (Object.hasOwn(payload, key)) {
        updatePayload[key] = payload[key];
      }

      return updatePayload;
    }, {});
  }

  validateHubspotCredentialId(hubspotCredentialId) {
    if (!hubspotCredentialId) {
      return {
        ok: false,
        reason: dealMappingReasons.BAD_REQUEST,
        message: 'hubspotCredentialId is required',
      };
    }

    if (!this.objectIdValidator.isValid(hubspotCredentialId)) {
      return {
        ok: false,
        reason: dealMappingReasons.INVALID_HUBSPOT_CREDENTIAL_ID,
        message: 'Invalid hubspotCredentialId',
      };
    }

    return null;
  }

  validateMappingId(id) {
    if (!this.objectIdValidator.isValid(id)) {
      return {
        ok: false,
        reason: dealMappingReasons.INVALID_MAPPING_ID,
        message: 'Invalid mapping id',
      };
    }

    return null;
  }

  notFound(message) {
    return {
      ok: false,
      reason: dealMappingReasons.NOT_FOUND,
      message,
    };
  }

  handleConflict(error, message) {
    if (duplicateKey(error)) {
      return {
        ok: false,
        reason: dealMappingReasons.CONFLICT,
        message,
      };
    }

    throw error;
  }
}

export { dealMappingReasons };

export default ManageDealMappings;
