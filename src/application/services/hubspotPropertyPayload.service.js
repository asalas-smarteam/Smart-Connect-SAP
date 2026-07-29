// Property names that are never valid in a batch write payload, whatever the
// allow-list says. `associations` is a real key inside `item.properties` in this
// codebase (the association phase reads `properties.associations.companies`) and
// `hs_object_id` is HubSpot's own read-only id: either one would 400 an entire
// 100-record chunk on the null-allow-list path.
const NEVER_WRITABLE = new Set(['associations', 'hs_object_id']);

// HubSpot property values are scalars. An object or an array (again:
// `associations`, or any mapping that resolved to a nested SAP node) is rejected
// with 400 PROPERTY_DOESNT_EXIST / INVALID_PROPERTY, taking the whole batch with
// it, so non-scalars are dropped unconditionally too. Dates are the exception:
// they serialize to the ISO string HubSpot accepts for date properties.
function isWritableValue(value) {
  if (typeof value !== 'object') {
    return true;
  }

  return value instanceof Date;
}

// HubSpot rejects an entire batch (400 PROPERTY_DOESNT_EXIST) when a single
// input carries a property the portal does not have or cannot write, so one
// stale mapping would cost all 100 records of a chunk. Unresolved mappings
// also arrive as null, which is noise on create.
export function sanitizeProperties(properties, allowedNames = null) {
  const sanitized = {};

  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value === null || value === undefined) {
      continue;
    }

    // Unconditional, allow-list or not: a null allow-list means "we could not
    // read the catalog", never "anything goes".
    if (NEVER_WRITABLE.has(key) || !isWritableValue(value)) {
      continue;
    }

    if (allowedNames && !allowedNames.has(key)) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export default { sanitizeProperties };
