import mappingService from '../services/mapping.service.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export const createMapping = async (req, reply) => {
  try {
    const { FieldMapping } = requireTenantModels(req);
    const {
      sourceField,
      targetField,
      objectType,
      clientConfigId,
      hubspotCredentialId,
      sourceContext = 'businessPartner',
    } = req.body;

    const data = await FieldMapping.create({
      sourceField,
      targetField,
      objectType,
      clientConfigId,
      hubspotCredentialId,
      sourceContext,
    });

    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.send({ ok: false, message: error.message });
  }
};


export const createAdminMapping = async (req, reply) => {
  try {
    const { FieldMapping } = requireTenantModels(req);
    const {
      sourceField,
      targetField,
      objectType,
      sourceContext,
      clientConfigId,
      hubspotCredentialId,
    } = req.body;

    if (!sourceContext) {
      return reply.code(400).send({
        ok: false,
        message: 'sourceContext is required',
      });
    }

    const data = await FieldMapping.create({
      sourceField,
      targetField,
      objectType,
      sourceContext,
      clientConfigId,
      hubspotCredentialId,
    });

    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.send({ ok: false, message: error.message });
  }
};

export const getMappings = async (req, reply) => {
  try {
    const { FieldMapping } = requireTenantModels(req);
    const { hubspotCredentialId, objectType } = req.query;
    const filter = {};

    if (hubspotCredentialId && objectType) {
      filter.hubspotCredentialId = hubspotCredentialId;
      filter.objectType = objectType;
    }

    const data = await FieldMapping.find(filter).sort({ _id: 1 });

    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.send({ ok: false, message: error.message });
  }
};

export const applyMappingTest = async (req, reply) => {
  try {
    const { data, hubspotCredentialId, objectType } = req.body;
    const tenantModels = requireTenantModels(req);
    const mapped = await mappingService.applyMapping(
      data,
      hubspotCredentialId,
      objectType,
      tenantModels
    );

    return reply.send({ ok: true, mapped });
  } catch (error) {
    return reply.send({ ok: false, message: error.message });
  }
};
