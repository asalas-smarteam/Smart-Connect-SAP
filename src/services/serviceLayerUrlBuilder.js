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

  const controlledFilter = sanitizeControlledFilter(options.controlledFilter);
  if (controlledFilter) {
    queryParts.push(`$filter=${controlledFilter}`);
  }

  return `${baseUrl}/b1s/v2${path}?${queryParts.join('&')}`;
}

export default {
  buildServiceLayerUrl,
};
