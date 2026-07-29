// HubSpot returns every property as a string. Keys are compared trimmed and
// lowercased so SAP padding/casing noise cannot cause a false "not found",
// which would create a duplicate record.
export function normalizeIndexKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// In-memory view of every HubSpot record of one object type, loaded once per
// run. Replaces per-record lookup calls: the Search API is eventually
// consistent and batch/read only works with unique properties, so neither can
// decide whether a record exists.
export class CrmObjectIndex {
  constructor({ records = [], identityProperty, fallbackProperty = null }) {
    this.identityProperty = identityProperty;
    // A fallback identical to the identity property adds nothing.
    this.fallbackProperty = fallbackProperty && fallbackProperty !== identityProperty
      ? fallbackProperty
      : null;
    this.byIdentity = new Map();
    this.byFallback = new Map();

    for (const record of records) {
      this.add(record);
    }
  }

  add(record) {
    const identity = normalizeIndexKey(record?.properties?.[this.identityProperty]);

    // First record wins, matching the product flow's existing dedupe rule.
    if (identity && !this.byIdentity.has(identity)) {
      this.byIdentity.set(identity, record);
    }

    if (this.fallbackProperty) {
      const fallback = normalizeIndexKey(record?.properties?.[this.fallbackProperty]);

      if (fallback && !this.byFallback.has(fallback)) {
        this.byFallback.set(fallback, record);
      }
    }
  }

  // idsap is the key between SAP and HubSpot; the tenant's configured
  // defaultFindHubspot property (email/cedula/phone) is only consulted when
  // the record carries no idsap match yet.
  find(properties) {
    const identity = normalizeIndexKey(properties?.[this.identityProperty]);

    if (identity) {
      const hit = this.byIdentity.get(identity);

      if (hit) {
        return hit;
      }
    }

    if (this.fallbackProperty) {
      const fallback = normalizeIndexKey(properties?.[this.fallbackProperty]);

      if (fallback) {
        return this.byFallback.get(fallback) ?? null;
      }
    }

    return null;
  }

  get size() {
    return this.byIdentity.size;
  }
}

export default CrmObjectIndex;
