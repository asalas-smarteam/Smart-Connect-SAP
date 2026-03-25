const SAP_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\s+(eq|ne|gt|ge|lt|le)\s+(?:'[^']*'|-?\d+(?:\.\d+)?|true|false|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?)$/i;

function cleanValue(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(baseUrl) {
  return cleanValue(baseUrl).replace(/\/+$/, '');
}

function normalizePath(path) {
  const cleaned = cleanValue(path).split('?')[0].split('#')[0];
  if (!cleaned) {
    return '';
  }

  return `/${cleaned.replace(/^\/+/, '')}`;
}

function sanitizeSelectFields(mappings) {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return [];
  }

  const unique = new Set();

  mappings.filter((mapping) => mapping.sourceContext !== "contactEmployee")
    .forEach((mapping) => {
      const field = cleanValue(mapping.sourceField);

      if (field && SAP_FIELD_PATTERN.test(field)) {
        unique.add(field);
      }
    });

  return Array.from(unique);
}

const additionalFieldsEnvByObjectType = {
  company: 'COMPANY_ADD_FIELDS_URL_SAP',
  product: 'PRODUCT_ADD_FIELDS_URL_SAP',
};

function getAdditionalFieldsByObjectType(objectType) {
  const envName = additionalFieldsEnvByObjectType[objectType];
  if (!envName) {
    return [];
  }

  const rawFields = cleanValue(process.env[envName]);
  if (!rawFields) {
    return [];
  }

  return rawFields
    .split(',')
    .map((field) => cleanValue(field))
    .filter((field) => field && SAP_FIELD_PATTERN.test(field));
}

function sanitizeControlledFilter(filter) {
  const value = cleanValue(filter);
  if (!value) return '';

  const pattern = new RegExp(FILTER_PATTERN.source); // evita estado compartido
  if (!pattern.test(value)) {
    throw new Error(`Controlled $filter has invalid format: ${value}`);
  }

  return value;
}

function resolveDynamicFilterValue(clientConfig, options) {
  const intervalMinutes = Number(options?.dynamicIntervalMinutes ?? clientConfig?.intervalMinutes);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return null;
  }

  const nowDate = options?.now instanceof Date ? options.now : new Date();
  const past = new Date(nowDate.getTime() - intervalMinutes * 60000);
  return past.toISOString().split('.')[0];
}

export function buildServiceLayerUrl(clientConfig, mappings, options = {}) {
  const modeName = clientConfig?.integrationModeId?.name || clientConfig?.integrationModeName;
  if (modeName !== 'SERVICE_LAYER') {
    throw new Error('buildServiceLayerUrl only supports SERVICE_LAYER mode');
  }

  const baseUrl = normalizeBaseUrl(clientConfig?.serviceLayerBaseUrl);
  const path = normalizePath(clientConfig?.serviceLayerPath);

  if (!baseUrl || !path) {
    throw new Error('serviceLayerBaseUrl and serviceLayerPath are required');
  }

  const selectFields = sanitizeSelectFields(mappings);
  const additionalFields = getAdditionalFieldsByObjectType(clientConfig?.objectType);
  const mergedSelectFields = Array.from(new Set([...selectFields, ...additionalFields]));
  if (mergedSelectFields.length === 0) {
    throw new Error('At least one active mapping with a valid sourceField is required');
  }

  const queryParts = [`$select=${mergedSelectFields.join(',')}`];
  const configFilters = clientConfig?.filters;
  const controlledFilter = sanitizeControlledFilter(options.controlledFilter);
  const conditions = [];

  if (Array.isArray(configFilters) && configFilters.length > 0) {
    configFilters.forEach((filter, index) => {
      const property = cleanValue(filter?.property);
      const operator = cleanValue(filter?.operator).toLowerCase();

      if (!property) {
        throw new Error(`Filter at index ${index} has an empty property`);
      }

      let value = filter?.value;
      if (filter?.isDynamic === true) {
        if (options?.skipDynamicFilters === true) {
          return;
        }

        value = resolveDynamicFilterValue(clientConfig, options);
      }

      if (value === null || typeof value === 'undefined') {
        throw new Error(`Filter at index ${index} requires a value`);
      }

      const stringValue = String(value);

      switch (operator) {
        case 'eq': {
          const normalizedValue = typeof value === 'string'
            ? `'${stringValue.replace(/'/g, "''")}'`
            : stringValue;
          conditions.push(`${property} eq ${normalizedValue}`);
          return;
        }
        case 'ge':
          conditions.push(`${property} ge ${stringValue}`);
          return;
        case 'startswith':
          conditions.push(`startswith(${property},'${stringValue.replace(/'/g, "''")}')`);
          return;
        case 'not_startswith':
          conditions.push(`not startswith(${property},'${stringValue.replace(/'/g, "''")}')`);
          return;
        default:
          throw new Error(`Unsupported SAP filter operator: ${operator}`);
      }
    });

  }

  if (controlledFilter) {
    conditions.push(controlledFilter);
  }

  if (conditions.length > 0) {
    const filterString = conditions.join(' and ');
    queryParts.push(`$filter=${encodeURIComponent(filterString)}`);
  }

  return `${baseUrl}/b1s/v2${path}?${queryParts.join('&')}`;
}

export default {
  buildServiceLayerUrl,
};
