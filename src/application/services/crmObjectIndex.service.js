import { belongsToAnotherSapRecord } from '#domain/sync/sap-record-ownership.js';

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
  constructor({
    records = [],
    identityProperty,
    fallbackProperty = null,
    uniqueProperties = [],
    ownershipProperties = null,
  }) {
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
    // SAP keys that mark a record as already owned by a SAP object. A record
    // reached through a secondary tier that carries a different value in any of
    // these belongs to another SAP row and is never handed out as "existing".
    this.ownershipProperties = [...new Set((ownershipProperties ?? [identityProperty]).filter(Boolean))];
    this.byIdentity = new Map();
    // Secondary tiers keep EVERY record per key, not just the first: when the
    // first one with that phone belongs to another SAP row, a later lead with
    // the same phone is still a valid match.
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
      pushToBucket(this.byFallback, normalizeIndexKey(record?.properties?.[this.fallbackProperty]), record);
    }

    for (const name of this.uniqueProperties) {
      pushToBucket(this.byUnique.get(name), normalizeIndexKey(record?.properties?.[name]), record);
    }
  }

  // Same as match() but returns only the record, for callers that do not care
  // which tier produced it.
  find(properties) {
    return this.match(properties)?.record ?? null;
  }

  // idsap is the key between SAP and HubSpot; the tenant's configured
  // defaultFindHubspot property (email/cedula/phone) is only consulted when
  // the identity matches nothing. Returns { record, via } where via is
  // 'identity' | 'fallback' | 'unique', or null.
  match(properties) {
    const identity = normalizeIndexKey(properties?.[this.identityProperty]);

    if (identity) {
      const hit = this.byIdentity.get(identity);

      if (hit) {
        return { record: hit, via: 'identity' };
      }
    }

    if (this.fallbackProperty) {
      const hit = this.firstAdoptable(
        this.byFallback.get(normalizeIndexKey(properties?.[this.fallbackProperty])),
        properties
      );

      if (hit) {
        return { record: hit, via: 'fallback' };
      }
      // Deliberately falls through instead of returning null: a fallback value
      // that matches nothing says nothing about the unique tiers below, and
      // stopping here is what sent conflicting records down the create path.
    }

    // Last resort, and only for properties HubSpot enforces. A record owned by
    // another SAP row is not returned even here: the create it leads to is
    // answered with 409 and linked by the conflict path without writing any
    // property, which is better than overwriting the other row's record.
    for (const name of this.uniqueProperties) {
      const hit = this.firstAdoptable(
        this.byUnique.get(name).get(normalizeIndexKey(properties?.[name])),
        properties
      );

      if (hit) {
        return { record: hit, via: 'unique' };
      }
    }

    return null;
  }

  firstAdoptable(bucket, properties) {
    if (!bucket) {
      return null;
    }

    return bucket.find((record) =>
      !belongsToAnotherSapRecord(record?.properties, properties, this.ownershipProperties)
    ) ?? null;
  }

  get size() {
    return this.byIdentity.size;
  }
}

function pushToBucket(map, key, record) {
  if (!key) {
    return;
  }

  const bucket = map.get(key);

  if (bucket) {
    bucket.push(record);
  } else {
    map.set(key, [record]);
  }
}

export default CrmObjectIndex;
