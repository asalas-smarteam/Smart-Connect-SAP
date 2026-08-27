// HubSpot returns every property as a string. Keys are compared trimmed and
// lowercased so SAP padding/casing noise cannot cause a false "not found",
// which would create a duplicate record.
export function normalizeIndexKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Properties HubSpot enforces as unique per object type, regardless of tenant
// configuration. A create that collides on one of these is rejected with 409, so
// the index has to know them even when the tenant identifies records by
// something else entirely. Companies carry no such constraint.
const HUBSPOT_UNIQUE_PROPERTIES = {
  contact: ['email'],
  company: [],
};

export function uniquePropertiesFor(objectType) {
  return HUBSPOT_UNIQUE_PROPERTIES[objectType] ?? [];
}

// In-memory view of every HubSpot record of one object type, loaded once per
// run. Replaces per-record lookup calls: the Search API is eventually
// consistent and batch/read only works with unique properties, so neither can
// decide whether a record exists.
export class CrmObjectIndex {
  constructor({ records = [], identityProperty, fallbackProperty = null, uniqueProperties = [] }) {
    this.identityProperty = identityProperty;
    // A fallback identical to the identity property adds nothing.
    this.fallbackProperty = fallbackProperty && fallbackProperty !== identityProperty
      ? fallbackProperty
      : null;
    // Properties HubSpot itself enforces as unique (contact email), independent
    // of what the tenant configured. Matching on these is not a heuristic: a
    // create that collides on one is REJECTED with 409, so failing to match here
    // does not risk a duplicate, it guarantees an error.
    this.uniqueProperties = [...new Set(uniqueProperties.filter(Boolean))]
      .filter((name) => name !== this.identityProperty && name !== this.fallbackProperty);
    this.byIdentity = new Map();
    this.byFallback = new Map();
    this.byUnique = new Map(this.uniqueProperties.map((name) => [name, new Map()]));

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

    for (const name of this.uniqueProperties) {
      const value = normalizeIndexKey(record?.properties?.[name]);
      const bucket = this.byUnique.get(name);

      if (value && !bucket.has(value)) {
        bucket.set(value, record);
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
        const hit = this.byFallback.get(fallback);

        if (hit) {
          return hit;
        }
        // Deliberately falls through instead of returning null: a fallback value
        // that matches nothing says nothing about the unique tiers below, and
        // stopping here is what sent conflicting records down the create path.
      }
    }

    // Last resort, and only for properties HubSpot enforces: a match here means
    // "a create would be rejected", so treating it as existing is the only
    // outcome that is not an error.
    for (const name of this.uniqueProperties) {
      const value = normalizeIndexKey(properties?.[name]);

      if (value) {
        const hit = this.byUnique.get(name).get(value);

        if (hit) {
          return hit;
        }
      }
    }

    return null;
  }

  get size() {
    return this.byIdentity.size;
  }
}

export default CrmObjectIndex;
