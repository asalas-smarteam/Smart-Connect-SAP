import { requireTenantModels } from '../utils/tenantModels.js';

export const createClientConfig = async (req, reply) => {
  try {
    const { ClientConfig } = requireTenantModels(req);
    const data = await ClientConfig.create(req.body);

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};

export const getClientConfig = async (req, reply) => {
  try {
    const { ClientConfig } = requireTenantModels(req);
    const data = await ClientConfig.find().populate('integrationModeId');

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};

export const createIntegrationMode = async (req, reply) => {
  try {
    const { name, description } = req.body;
    const allowedNames = ['API', 'STORE_PROCEDURE', 'SQL_SCRIPT'];

    if (name && !allowedNames.includes(name)) {
      return reply.send({
        ok: false,
        message: `Integration mode must be one of: ${allowedNames.join(', ')}`,
      });
    }

    const { IntegrationMode } = requireTenantModels(req);
    const data = await IntegrationMode.create({ name, description });

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};

export const getIntegrationModes = async (req, reply) => {
  try {
    const { IntegrationMode } = requireTenantModels(req);
    const data = await IntegrationMode.find();

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};
