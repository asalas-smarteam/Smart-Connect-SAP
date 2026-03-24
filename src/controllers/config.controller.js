import logger from '../core/logger.js';
import { requireTenantModels } from '../utils/tenantModels.js';
import {
  buildMergedFilters,
  sanitizeIncomingCustomFilters,
} from '../services/tenant/clientConfigFilters.service.js';


const DEFAULT_CONTACT_EMPLOYEE_MAPPINGS = [
  { sourceField: 'Name', targetField: 'firstname', sourceContext: 'contactEmployee'  },
  { sourceField: 'InternalCode', targetField: 'internalcode', sourceContext: 'contactEmployee'  },
  { sourceField: 'Address', targetField: 'address', sourceContext: 'contactEmployee'  },
  { sourceField: 'EmailAddress', targetField: 'email', sourceContext: 'contactEmployee'  },
];

const DEFAULT_PRODUCT_MAPPINGS = [
  { sourceField: 'OnHand', targetField: 'OnHand', sourceContext: 'ItemWarehouseInfoCollection' },
  { sourceField: 'OnHold', targetField: 'OnHold', sourceContext: 'ItemWarehouseInfoCollection' },
  { sourceField: 'Committed', targetField: 'Committed', sourceContext: 'ItemWarehouseInfoCollection' },
  { sourceField: 'ItemCode', targetField: 'hs_sku', sourceContext: 'product' },
];

async function ensureDefaultMappings({
  FieldMapping,
  clientConfig,
  mappings,
  objectType,
  editable = true,
}) {
  if (!FieldMapping || !clientConfig?._id || !clientConfig?.hubspotCredentialId) {
    return;
  }

  if (!Array.isArray(mappings) || mappings.length === 0) {
    return;
  }

  await Promise.all(
    mappings.map(async (mapping) => {
      const existing = await FieldMapping.findOne({
        clientConfigId: clientConfig._id,
        hubspotCredentialId: clientConfig.hubspotCredentialId,
        objectType,
        sourceContext: mapping.sourceContext,
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
      });

      if (!existing) {
        await FieldMapping.create({
          ...mapping,
          objectType,
          sourceContext: mapping.sourceContext,
          clientConfigId: clientConfig._id,
          hubspotCredentialId: clientConfig.hubspotCredentialId,
          editable,
        });
      }
    })
  );
}

async function ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig }) {
  if (clientConfig?.objectType !== 'company') {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: DEFAULT_CONTACT_EMPLOYEE_MAPPINGS,
    objectType: 'contact',
    sourceContext: 'contactEmployee',
  });
}

async function ensureDefaultProductMappings({ FieldMapping, clientConfig }) {
  if (clientConfig?.objectType !== 'product') {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: DEFAULT_PRODUCT_MAPPINGS,
    objectType: 'product',
    editable: false,
  });
}

function applyCustomFilterPatch(existingCustomFilters, incomingFilters) {
  const customByProperty = new Map(existingCustomFilters.map((f) => [f.property, f]));

  for (const filter of incomingFilters) {
    customByProperty.set(filter.property, {
      operator: filter.operator,
      property: filter.property,
      value: filter.value ?? null,
      isDefault: false,
      isDynamic: false,
      editable: true,
    });
  }

  return Array.from(customByProperty.values());
}

export const createClientConfig = async (req, reply) => {
  try {
    const { ClientConfig, FieldMapping, IntegrationMode, SapFilter } = requireTenantModels(req);
    const { integrationModeId } = req.body;

    if (!integrationModeId) {
      return reply.send({
        ok: false,
        message: 'integrationModeId is required',
      });
    }

    const integrationModeExists = await IntegrationMode.exists({ _id: integrationModeId });
    if (!integrationModeExists) {
      return reply.send({
        ok: false,
        message: 'integrationModeId is invalid',
      });
    }

    const payload = { ...req.body };

    const customFilters = sanitizeIncomingCustomFilters(payload.filters);
    const defaultFilters = await SapFilter.find({
      objectType: payload.objectType,
      active: true,
    }).lean();

    const merged = buildMergedFilters({
      defaultFilters,
      customFilters,
    });
    payload.filters = merged.filters;

    logger.info({
      msg: 'Integrated default SAP filters into ClientConfig creation',
      objectType: payload.objectType,
      defaultCount: merged.defaultCount,
      customCount: merged.customCount,
    });

    const data = await ClientConfig.create(payload);
    await ensureDefaultContactEmployeeMappings({
      FieldMapping,
      clientConfig: data,
    });
    await ensureDefaultProductMappings({
      FieldMapping,
      clientConfig: data,
    });

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    logger.error({ msg: 'Failed creating ClientConfig', error: error.message });
    const statusCode = /filters|Custom filter/.test(error.message) ? 400 : 500;
    return reply.code(statusCode).send({
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
    const allowedNames = ['API', 'STORE_PROCEDURE', 'SQL_SCRIPT', 'SERVICE_LAYER'];

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
    const data = await IntegrationMode.find().lean();
    const payload = data.map((mode) => ({
      id: mode._id,
      name: mode.name,
      description: mode.description,
    }));

    return reply.send({
      ok: true,
      data: payload,
    });
  } catch (error) {
    return reply.send({
      ok: false,
      message: error.message,
    });
  }
};


export const patchClientConfig = async (req, reply) => {
  try {
    const { ClientConfig } = requireTenantModels(req);
    const { id } = req.params;
    const payload = { ...req.body };


    const config = await ClientConfig.findById(id);
    if (!config) {
      return reply.code(404).send({
        ok: false,
        message: 'ClientConfig not found',
      });
    }

    const existingFilters = Array.isArray(config.filters) ? config.filters : [];
    const existingDefaults = existingFilters.filter((filter) => filter?.isDefault === true);
    const existingCustom = existingFilters.filter((filter) => filter?.isDefault !== true);

    if (Object.prototype.hasOwnProperty.call(payload, 'filters')) {
      if (!Array.isArray(payload.filters)) {
        return reply.code(400).send({ ok: false, message: 'filters must be an array' });
      }

      if (payload.filters.some((filter) => filter?.isDefault === true)) {
        logger.warn({ msg: 'Client attempted to modify default filters', clientConfigId: id });
        return reply.code(403).send({
          ok: false,
          message: 'Default filters cannot be modified or removed',
        });
      }

      const incomingCustomFilters = sanitizeIncomingCustomFilters(payload.filters);
      const updatedCustomFilters = applyCustomFilterPatch(existingCustom, incomingCustomFilters);

      payload.filters = [
        ...existingDefaults.map((filter) => ({
          operator: filter.operator,
          property: filter.property,
          value: filter.value,
          isDefault: true,
          isDynamic: Boolean(filter.isDynamic),
          editable: false,
        })),
        ...updatedCustomFilters,
      ];
    }

    delete payload._id;
    delete payload.integrationModeId;

    Object.assign(config, payload);
    await config.save();

    return reply.send({ ok: true, data: config });
  } catch (error) {
    logger.error({ msg: 'Failed patching ClientConfig', error: error.message });
    const statusCode = /filters/.test(error.message) ? 400 : 500;
    return reply.code(statusCode).send({
      ok: false,
      message: error.message,
    });
  }
};
