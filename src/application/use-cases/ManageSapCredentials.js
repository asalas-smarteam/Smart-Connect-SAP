const reasons = Object.freeze({
  INVALID_CLIENT_CONFIG_ID: 'INVALID_CLIENT_CONFIG_ID',
  INVALID_CREDENTIALS_ID: 'INVALID_CREDENTIALS_ID',
  CLIENT_CONFIG_NOT_FOUND: 'CLIENT_CONFIG_NOT_FOUND',
  SAP_CREDENTIALS_NOT_FOUND: 'SAP_CREDENTIALS_NOT_FOUND',
  DUPLICATE: 'DUPLICATE',
  BAD_REQUEST: 'BAD_REQUEST',
});

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

function validateRequiredOnCreate(payload, objectIdValidator) {
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

  if (!objectIdValidator.isValid(payload.clientConfigId)) {
    return {
      ok: false,
      reason: reasons.INVALID_CLIENT_CONFIG_ID,
      message: 'clientConfigId is invalid',
    };
  }

  return null;
}

function isValidationError(error) {
  return /required|invalid|must be a number|Missing required fields/.test(error.message);
}

export class ManageSapCredentials {
  constructor({ sapCredentialsRepository, objectIdValidator }) {
    this.sapCredentialsRepository = sapCredentialsRepository;
    this.objectIdValidator = objectIdValidator;
  }

  async create({ tenantModels, payload }) {
    try {
      const normalized = normalizePayload(payload, { partial: false });
      const validation = validateRequiredOnCreate(normalized, this.objectIdValidator);

      if (validation) {
        return validation;
      }

      const clientConfig = await this.sapCredentialsRepository.findClientConfigById({
        tenantModels,
        id: normalized.clientConfigId,
      });

      if (!clientConfig) {
        return {
          ok: false,
          reason: reasons.CLIENT_CONFIG_NOT_FOUND,
          message: 'ClientConfig not found',
        };
      }

      const data = await this.sapCredentialsRepository.create({ tenantModels, payload: normalized });
      return { ok: true, statusCode: 201, data };
    } catch (error) {
      return this.handleMutationError(error);
    }
  }

  async list({ tenantModels, query }) {
    const { clientConfigId } = query || {};
    const filter = {};

    if (clientConfigId) {
      if (!this.objectIdValidator.isValid(clientConfigId)) {
        return {
          ok: false,
          reason: reasons.INVALID_CLIENT_CONFIG_ID,
          message: 'clientConfigId is invalid',
        };
      }
      filter.clientConfigId = clientConfigId;
    }

    const data = await this.sapCredentialsRepository.list({ tenantModels, filter });
    return { ok: true, data };
  }

  async get({ tenantModels, id }) {
    if (!this.objectIdValidator.isValid(id)) {
      return {
        ok: false,
        reason: reasons.INVALID_CREDENTIALS_ID,
        message: 'Invalid SAP credentials id',
      };
    }

    const data = await this.sapCredentialsRepository.findById({ tenantModels, id });
    if (!data) {
      return {
        ok: false,
        reason: reasons.SAP_CREDENTIALS_NOT_FOUND,
        message: 'SAP credentials not found',
      };
    }

    return { ok: true, data };
  }

  async patch({ tenantModels, id, payload }) {
    try {
      if (!this.objectIdValidator.isValid(id)) {
        return {
          ok: false,
          reason: reasons.INVALID_CREDENTIALS_ID,
          message: 'Invalid SAP credentials id',
        };
      }

      const normalized = normalizePayload(payload, { partial: true });
      delete normalized._id;

      if (Object.prototype.hasOwnProperty.call(normalized, 'clientConfigId')) {
        if (!this.objectIdValidator.isValid(normalized.clientConfigId)) {
          return {
            ok: false,
            reason: reasons.INVALID_CLIENT_CONFIG_ID,
            message: 'clientConfigId is invalid',
          };
        }

        const clientConfig = await this.sapCredentialsRepository.findClientConfigById({
          tenantModels,
          id: normalized.clientConfigId,
        });
        if (!clientConfig) {
          return {
            ok: false,
            reason: reasons.CLIENT_CONFIG_NOT_FOUND,
            message: 'ClientConfig not found',
          };
        }
      }

      const data = await this.sapCredentialsRepository.updateById({
        tenantModels,
        id,
        payload: normalized,
      });

      if (!data) {
        return {
          ok: false,
          reason: reasons.SAP_CREDENTIALS_NOT_FOUND,
          message: 'SAP credentials not found',
        };
      }

      return { ok: true, data };
    } catch (error) {
      return this.handleMutationError(error);
    }
  }

  async delete({ tenantModels, id }) {
    if (!this.objectIdValidator.isValid(id)) {
      return {
        ok: false,
        reason: reasons.INVALID_CREDENTIALS_ID,
        message: 'Invalid SAP credentials id',
      };
    }

    const data = await this.sapCredentialsRepository.deleteById({ tenantModels, id });
    if (!data) {
      return {
        ok: false,
        reason: reasons.SAP_CREDENTIALS_NOT_FOUND,
        message: 'SAP credentials not found',
      };
    }

    return { ok: true, data };
  }

  handleMutationError(error) {
    if (error?.code === 11000) {
      return {
        ok: false,
        reason: reasons.DUPLICATE,
        message: 'SAP credentials already exist for this clientConfigId',
      };
    }

    if (isValidationError(error)) {
      return {
        ok: false,
        reason: reasons.BAD_REQUEST,
        message: error.message,
      };
    }

    throw error;
  }
}

export const sapCredentialsReasons = reasons;

export default ManageSapCredentials;
