// Builds the OData v2 query for an S/4HANA Gateway fetch, from the same
// ClientConfig + FieldMappings the B1 Service Layer builder consumes.
//
// Differences vs serviceLayerUrlBuilder (B1/v4):
//  - sourceField may be a dotted navigation path
//    ("to_BusinessPartnerAddress.to_EmailAddress.EmailAddress"), which the
//    mapping layer already resolves. Here it becomes $expand plus the
//    navigation root in $select — the shape verified against the tenant's
//    live Gateway.
//  - Edm.DateTime comparisons need datetime'...' literals; bare ISO is
//    rejected by Gateway.
//  - No /sap/opu/odata prefix and no $format: the transport owns those.

const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROLLED_FILTER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\s+(eq|ne|gt|ge|lt|le)\s+(?:'[^']*'|datetime'[^']*'|-?\d+(?:\.\d+)?|true|false)$/i;

function cleanValue(value) {
  return String(value ?? '').trim();
}

function normalizePath(path) {
  const cleaned = cleanValue(path).split('?')[0].split('#')[0];
  if (!cleaned) {
    return '';
  }
  return `/${cleaned.replace(/^\/+/, '')}`;
}

function escapeODataLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// Edm.DateTime literal: datetime'YYYY-MM-DDTHH:mm:ss' (no timezone suffix).
export function toODataV2DateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `datetime'${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    + `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}'`;
}

// Splits mapping source fields into the flat $select entries and the
// navigation paths that must be expanded.
export function splitSelectAndExpand(mappings) {
  const select = new Set();
  const expand = new Set();

  const candidates = Array.isArray(mappings) ? mappings : [];

  for (const mapping of candidates) {
    if (mapping?.includeInServiceLayerSelect === false) {
      continue;
    }

    const raw = cleanValue(mapping?.sourceField);
    if (!raw) {
      continue;
    }

    const segments = raw.split('.').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0 || !segments.every((segment) => FIELD_PATTERN.test(segment))) {
      continue;
    }

    if (segments.length === 1) {
      select.add(segments[0]);
      continue;
    }

    // Nested path: expand everything but the leaf, select the navigation root.
    expand.add(segments.slice(0, -1).join('/'));
    select.add(segments[0]);
  }

  // Expanding a deep path implies its parents, so drop any entry that is a
  // strict prefix of another ("to_X" when "to_X/to_Y" is already present).
  const expandPaths = [...expand];
  const prunedExpand = expandPaths.filter(
    (candidate) => !expandPaths.some(
      (other) => other !== candidate && other.startsWith(`${candidate}/`)
    )
  );

  return {
    select: [...select],
    expand: prunedExpand,
  };
}

function resolveDynamicValue(clientConfig, options, dynamicType) {
  const now = options?.now instanceof Date ? options.now : new Date();

  if (dynamicType === 'date') {
    const startOfDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    ));
    return startOfDay;
  }

  const intervalMinutes = Number(
    options?.dynamicIntervalMinutes ?? clientConfig?.intervalMinutes
  );

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return null;
  }

  return new Date(now.getTime() - intervalMinutes * 60000);
}

function buildFilterConditions(clientConfig, options) {
  const conditions = [];
  const configFilters = clientConfig?.filters;

  if (!Array.isArray(configFilters)) {
    return conditions;
  }

  configFilters.forEach((filter, index) => {
    const property = cleanValue(filter?.property);
    const operator = cleanValue(filter?.operator).toLowerCase();

    if (!property) {
      throw new Error(`Filter at index ${index} has an empty property`);
    }

    if (!FIELD_PATTERN.test(property)) {
      throw new Error(`Filter at index ${index} has an invalid property: ${property}`);
    }

    let value = filter?.value;
    const isDynamic = filter?.isDynamic === true;
    const dynamicType = isDynamic ? (cleanValue(filter?.dynamicType) || 'datetime') : null;

    if (isDynamic) {
      if (options?.skipDynamicFilters === true) {
        return;
      }

      const resolved = resolveDynamicValue(clientConfig, options, dynamicType);
      if (resolved === null) {
        return;
      }

      // S/4 exposes a single LastChangeDate/LastChangeTime pair, so dynamic
      // filters always compare as Edm.DateTime literals.
      conditions.push(`${property} ${operator === 'eq' ? 'eq' : 'ge'} ${toODataV2DateTime(resolved)}`);
      return;
    }

    if (value === null || typeof value === 'undefined') {
      throw new Error(`Filter at index ${index} requires a value`);
    }

    const stringValue = String(value);

    switch (operator) {
      case 'eq':
      case 'ne':
      case 'ge':
      case 'gt':
      case 'le':
      case 'lt': {
        const literal = typeof value === 'number' || typeof value === 'boolean'
          ? stringValue
          : `'${escapeODataLiteral(stringValue)}'`;
        conditions.push(`${property} ${operator} ${literal}`);
        return;
      }
      case 'in': {
        // OData v2 has no `in` operator; it renders as an OR group.
        // Used for multi-value business filters such as
        // BusinessPartnerGrouping in [ZC01, ZC02].
        const values = Array.isArray(value) ? value : [value];
        const members = values
          .map((entry) => cleanValue(entry))
          .filter(Boolean)
          .map((entry) => `${property} eq '${escapeODataLiteral(entry)}'`);

        if (members.length === 0) {
          throw new Error(`Filter at index ${index} requires at least one value for 'in'`);
        }

        conditions.push(members.length === 1 ? members[0] : `(${members.join(' or ')})`);
        return;
      }
      case 'startswith':
        conditions.push(`startswith(${property},'${escapeODataLiteral(stringValue)}')`);
        return;
      case 'not_startswith':
        conditions.push(`not startswith(${property},'${escapeODataLiteral(stringValue)}')`);
        return;
      default:
        throw new Error(`Unsupported SAP filter operator: ${operator}`);
    }
  });

  return conditions;
}

function buildOrderBy(orderBy) {
  if (!Array.isArray(orderBy) || orderBy.length === 0) {
    return '';
  }

  return orderBy
    .map((entry) => {
      const property = cleanValue(entry?.property);
      if (!property || !FIELD_PATTERN.test(property)) {
        return null;
      }
      const direction = cleanValue(entry?.direction).toLowerCase() === 'asc' ? 'asc' : 'desc';
      return `${property} ${direction}`;
    })
    .filter(Boolean)
    .join(',');
}

// Returns { path, query } ready for SapTransportPort.fetchAll.
export function buildS4ODataQuery(clientConfig, mappings, options = {}) {
  const path = normalizePath(clientConfig?.serviceLayerPath);

  if (!path) {
    throw new Error('serviceLayerPath is required for S4_ODATA mode');
  }

  const { select, expand } = splitSelectAndExpand(mappings);

  if (select.length === 0) {
    throw new Error('At least one active mapping with a valid sourceField is required');
  }

  const query = { $select: select.join(',') };

  if (expand.length > 0) {
    query.$expand = expand.join(',');
  }

  const conditions = buildFilterConditions(clientConfig, options);

  const controlledFilter = cleanValue(options?.controlledFilter);
  if (controlledFilter) {
    // Reused verbatim, so it must already be a valid v2 expression. Tenants
    // on S/4 should express incremental windows as dynamic SapFilters
    // instead, which this builder renders with proper datetime literals.
    if (!CONTROLLED_FILTER_PATTERN.test(controlledFilter)) {
      throw new Error(`Controlled $filter has invalid format for OData v2: ${controlledFilter}`);
    }
    conditions.push(controlledFilter);
  }

  if (conditions.length > 0) {
    query.$filter = encodeURIComponent(conditions.join(' and '));
  }

  const orderBy = buildOrderBy(clientConfig?.orderBy);
  if (orderBy) {
    query.$orderby = encodeURIComponent(orderBy);
  }

  return { path, query };
}

export default { buildS4ODataQuery, splitSelectAndExpand, toODataV2DateTime };
