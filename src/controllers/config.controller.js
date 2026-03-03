import logger from '../core/logger.js';
import { requireTenantModels } from '../utils/tenantModels.js';


const DEFAULT_CONTACT_EMPLOYEE_MAPPINGS = [
  { sourceField: 'Name', targetField: 'firstname' },
  { sourceField: 'InternalCode', targetField: 'internalcode' },
  { sourceField: 'Address', targetField: 'address' },
  { sourceField: 'EmailAddress', targetField: 'email' },
];

async function ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig }) {
  if (
    !FieldMapping ||
    !clientConfig?._id ||
    !clientConfig?.hubspotCredentialId ||
    clientConfig?.objectType !== 'company'
  ) {
    return;
  }

  await Promise.all(
    DEFAULT_CONTACT_EMPLOYEE_MAPPINGS.map(async (mapping) => {
      const existing = await FieldMapping.findOne({
        clientConfigId: clientConfig._id,
        hubspotCredentialId: clientConfig.hubspotCredentialId,
        objectType: 'contact',
        sourceContext: 'contactEmployee',
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
      });

      if (!existing) {
        await FieldMapping.create({
          ...mapping,
          objectType: 'contact',
          sourceContext: 'contactEmployee',
          clientConfigId: clientConfig._id,
          hubspotCredentialId: clientConfig.hubspotCredentialId,
        });
      }
    })
  );
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeServiceLayerPath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  const withoutQuery = trimmed.split('?')[0].trim();
  return `/${withoutQuery.replace(/^\/+/, '')}`;
}



const ALLOWED_OPERATORS = ['eq', 'ge', 'startswith', 'not_startswith'];
const FILTER_CONTROLLED_FIELDS = ['isDefault', 'isDynamic', 'editable'];

function normalizeFilterKey(filter) {
  return `${filter.property}::${filter.operator}::${String(filter.value ?? '')}`;
}

function sanitizeIncomingCustomFilters(filters) {
  if (filters == null) {
    return [];
  }

  if (!Array.isArray(filters)) {
    throw new Error('filters must be an array');
  }

  return filters.map((filter, index) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new Error(`filters[${index}] must be an object`);
    }

    for (const field of FILTER_CONTROLLED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(filter, field)) {
        throw new Error(`filters[${index}].${field} is not allowed`);
      }
    }

    const operator = String(filter.operator || '').trim();
    if (!ALLOWED_OPERATORS.includes(operator)) {
      throw new Error(`filters[${index}].operator must be one of: ${ALLOWED_OPERATORS.join(', ')}`);
    }

    const property = String(filter.property || '').trim();
    if (!property) {
      throw new Error(`filters[${index}].property is required`);
    }

    return {
      operator,
      property,
      value: filter.value ?? null,
      isDefault: false,
      isDynamic: false,
      editable: true,
    };
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

    const integrationMode = await IntegrationMode.findById(integrationModeId);
    if (!integrationMode) {
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

    const defaultFilterKeys = new Set(
      defaultFilters.map((filter) => normalizeFilterKey(filter))
    );
    const defaultPropertyOperatorKeys = new Set(
      defaultFilters.map((filter) => `${filter.property}::${filter.operator}`)
    );

    const dedupedCustomFilters = [];
    const seenCustomKeys = new Set();

    for (const filter of customFilters) {
      const fullKey = normalizeFilterKey(filter);
      const propertyOperatorKey = `${filter.property}::${filter.operator}`;

      if (defaultFilterKeys.has(fullKey)) {
        continue;
      }

      if (defaultPropertyOperatorKeys.has(propertyOperatorKey)) {
        return reply.code(400).send({
          ok: false,
          message: `Custom filter for ${filter.property} with operator ${filter.operator} conflicts with a default filter`,
        });
      }

      if (!seenCustomKeys.has(fullKey)) {
        dedupedCustomFilters.push(filter);
        seenCustomKeys.add(fullKey);
      }
    }

    payload.filters = [
      ...defaultFilters.map((filter) => ({
        operator: filter.operator,
        property: filter.property,
        value: filter.value,
        isDefault: true,
        isDynamic: Boolean(filter.isDynamic),
        editable: false,
      })),
      ...dedupedCustomFilters,
    ];

    logger.info({
      msg: 'Integrated default SAP filters into ClientConfig creation',
      objectType: payload.objectType,
      defaultCount: defaultFilters.length,
      customCount: dedupedCustomFilters.length,
    });

    if (integrationMode.name === 'SERVICE_LAYER') {
      const serviceLayerBaseUrl = normalizeBaseUrl(payload.serviceLayerBaseUrl);
      const serviceLayerPath = normalizeServiceLayerPath(payload.serviceLayerPath);
      const serviceLayerUsername = String(payload.serviceLayerUsername || '').trim();
      const serviceLayerPassword = String(payload.serviceLayerPassword || '').trim();

      if (!serviceLayerBaseUrl || !serviceLayerPath || !serviceLayerUsername || !serviceLayerPassword) {
        return reply.send({
          ok: false,
          message:
            'SERVICE_LAYER mode requires serviceLayerBaseUrl, serviceLayerPath, serviceLayerUsername and serviceLayerPassword',
        });
      }

      payload.serviceLayerBaseUrl = serviceLayerBaseUrl;
      payload.serviceLayerPath = serviceLayerPath;
      payload.serviceLayerUsername = serviceLayerUsername;
      payload.serviceLayerPassword = serviceLayerPassword;
      payload.apiUrl = `${serviceLayerBaseUrl}/b1s/v2${serviceLayerPath}`;
      payload.apiToken = null;
    }

    const data = await ClientConfig.create(payload);
    await ensureDefaultContactEmployeeMappings({
      FieldMapping,
      clientConfig: data,
    });

    return reply.send({
      ok: true,
      data,
    });
  } catch (error) {
    logger.error({ msg: 'Failed creating ClientConfig', error: error.message });
    const statusCode = /filters/.test(error.message) ? 400 : 500;
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
