import { FieldMapping } from '../config/database.js';
import mappingService from '../services/mapping.service.js';

export const createMapping = async (req, reply) => {
  try {
    const { sourceField, targetField, objectType, clientConfigId, hubspotCredentialId } =
      req.body;

    const data = await FieldMapping.create({
      sourceField,
      targetField,
      objectType,
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
    const { hubspotCredentialId, objectType } = req.query;
    const options = {
      order: [['id', 'ASC']],
    };

    if (hubspotCredentialId && objectType) {
      options.where = { hubspotCredentialId, objectType };
    }

    const data = await FieldMapping.findAll(options);

    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.send({ ok: false, message: error.message });
  }
};

export const applyMappingTest = async (req, reply) => {
  try {
    const { data, hubspotCredentialId, objectType } = req.body;
    const mapped = await mappingService.applyMapping(
      data,
      hubspotCredentialId,
      objectType
    );

    return reply.send({ ok: true, mapped });
  } catch (error) {
    return reply.send({ ok: false, message: error.message });
  }
};
