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

    if (allowedNames && !allowedNames.has(key)) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export default { sanitizeProperties };
