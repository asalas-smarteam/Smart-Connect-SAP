import mappingService from '../services/mapping.service.js';
import { requireTenantModels } from '../utils/tenantModels.js';

function duplicateConflictReply(reply) {
  return reply.code(409).send({
    ok: false,
    message: 'Mapping already exists for this sourceField and objectType.',
  });
}

export const createMapping = async (req, reply) => {
  try {
    const tenantModels = requireTenantModels(req);
    const { FieldMapping, ClientConfig } = tenantModels;
    const {
      sourceField,
      targetField,
      objectType,
      clientConfigId,
      sourceContext,
      includeInServiceLayerSelect,
    } = req.body;
    const resolvedSourceContext = sourceContext || (objectType === 'product' ? 'product' : 'businessPartner');

    const config = await ClientConfig.findOne({
      objectType,
      active: true,
    }).lean();

    if (!config) {
      return reply.code(400).send({
        ok: false,
        message: 'You must create a client task before creating mappings.',
      });
    }

    const hubspotCredentialId = config.hubspotCredentialId;

    if (!hubspotCredentialId) {
      return reply.code(400).send({
        ok: false,
        message: 'You must create a client task before creating mappings.',
      });
    }

    const existing = await FieldMapping.findOne({
      hubspotCredentialId,
      objectType,
      sourceContext: resolvedSourceContext,
      sourceField,
    }).lean();

    if (existing) {
      return duplicateConflictReply(reply);
    }

    const data = await FieldMapping.create({
      sourceField,
      targetField,
      objectType,
      clientConfigId,
      hubspotCredentialId,
      sourceContext: resolvedSourceContext,
      includeInServiceLayerSelect,
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
      includeInServiceLayerSelect,
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
      includeInServiceLayerSelect,
    });

    return reply.send({ ok: true, data });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return duplicateConflictReply(reply);
    }

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
