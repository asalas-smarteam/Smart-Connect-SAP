const ALLOWED_OPERATORS = ['eq', 'ge', 'startswith', 'not_startswith'];
const FILTER_CONTROLLED_FIELDS = ['isDefault', 'isDynamic', 'editable'];

export function normalizeFilterKey(filter) {
  return `${filter.property}::${filter.operator}::${String(filter.value ?? '')}`;
}

export function sanitizeIncomingCustomFilters(filters) {
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

export function buildMergedFilters({ defaultFilters, customFilters }) {
  const resolvedDefaults = Array.isArray(defaultFilters) ? defaultFilters : [];
  const resolvedCustom = Array.isArray(customFilters) ? customFilters : [];

  const defaultFilterKeys = new Set(
    resolvedDefaults.map((filter) => normalizeFilterKey(filter))
  );

  const defaultPropertyOperatorKeys = new Set(
    resolvedDefaults.map((filter) => `${filter.property}::${filter.operator}`)
  );

  const dedupedCustomFilters = [];
  const seenCustomKeys = new Set();

  for (const filter of resolvedCustom) {
    const fullKey = normalizeFilterKey(filter);
    const propertyOperatorKey = `${filter.property}::${filter.operator}`;

    if (defaultFilterKeys.has(fullKey)) {
      continue;
    }

    if (defaultPropertyOperatorKeys.has(propertyOperatorKey)) {
      throw new Error(
        `Custom filter for ${filter.property} with operator ${filter.operator} conflicts with a default filter`
      );
    }

    if (!seenCustomKeys.has(fullKey)) {
      dedupedCustomFilters.push(filter);
      seenCustomKeys.add(fullKey);
    }
  }

  return {
    filters: [
      ...resolvedDefaults.map((filter) => ({
        operator: filter.operator,
        property: filter.property,
        value: filter.value,
        isDefault: true,
        isDynamic: Boolean(filter.isDynamic),
        editable: false,
      })),
      ...dedupedCustomFilters,
    ],
    defaultCount: resolvedDefaults.length,
    customCount: dedupedCustomFilters.length,
  };
}
