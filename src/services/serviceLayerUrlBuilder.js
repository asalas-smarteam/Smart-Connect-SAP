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

  mappings.forEach((mapping) => {
    const field = cleanValue(mapping?.sourceField);
    if (field && SAP_FIELD_PATTERN.test(field)) {
      unique.add(field);
    }
  });

  return Array.from(unique);
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
  if (selectFields.length === 0) {
    throw new Error('At least one active mapping with a valid sourceField is required');
  }

  const queryParts = [`$select=${selectFields.join(',')}`];
  const configFilters = clientConfig?.filters;

  if (Array.isArray(configFilters) && configFilters.length > 0) {
    const conditions = [];

    configFilters.forEach((filter, index) => {
      const property = cleanValue(filter?.property);
      const operator = cleanValue(filter?.operator).toLowerCase();

      if (!property) {
        throw new Error(`Filter at index ${index} has an empty property`);
      }

      if (!['eq', 'ge'].includes(operator)) {
        throw new Error(`Filter at index ${index} has an invalid operator: ${operator || '(empty)'}`);
      }

      let value = filter?.value;
      if (filter?.isDynamic === true) {
        const intervalMinutes = Number(clientConfig?.intervalMinutes);
        const now = new Date();
        const past = new Date(now.getTime() - intervalMinutes * 60000);
        value = past.toISOString().split('.')[0];
      }

      if (value === null || typeof value === 'undefined') {
        throw new Error(`Filter at index ${index} requires a value`);
      }

      const stringValue = String(value);
      if (operator === 'eq') {
        const normalizedValue = typeof value === 'string'
          ? `'${stringValue.replace(/'/g, "''")}'`
          : stringValue;
        conditions.push(`${property} eq ${normalizedValue}`);
        return;
      }

      conditions.push(`${property} ge ${stringValue}`);
    });

    if (conditions.length > 0) {
      const filterString = conditions.join(' and ');
      queryParts.push(`$filter=${encodeURIComponent(filterString)}`);
    }
  } else {
    const controlledFilter = sanitizeControlledFilter(options.controlledFilter);
    if (controlledFilter) {
      queryParts.push(`$filter=${controlledFilter}`);
    }
  }

  return `${baseUrl}/b1s/v2${path}?${queryParts.join('&')}`;
}

export default {
  buildServiceLayerUrl,
};
