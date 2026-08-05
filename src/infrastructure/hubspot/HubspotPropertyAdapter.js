import { resolveHubspotObjectType } from '#domain/hubspot/objectTypeRouter.js';
import { hubspotGet, hubspotPatch } from './hubspotClient.js';

function resolveObjectTypeOrThrow(objectType) {
  const resolved = resolveHubspotObjectType(objectType);

  if (!resolved) {
    throw new Error('objectType is required to resolve a HubSpot property');
  }

  return resolved;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value ?? '').trim());
}

// Property *metadata* access. Record values go through HubspotSyncAdapter; this
// adapter only reads and rewrites the schema of a single property.
export class HubspotPropertyAdapter {
  constructor({ get = hubspotGet, patch = hubspotPatch } = {}) {
    this.get = get;
    this.patch = patch;
  }

  buildPropertyPath({ objectType, propertyName }) {
    const resolvedObjectType = resolveObjectTypeOrThrow(objectType);
    const name = String(propertyName ?? '').trim();

    if (!name) {
      throw new Error('propertyName is required to resolve a HubSpot property');
    }

    return `/crm/v3/properties/${encodeSegment(resolvedObjectType)}/${encodeSegment(name)}`;
  }

  // A property that does not exist is an expected outcome the caller reports as
  // a warning, so it resolves to null instead of throwing. Every other failure
  // (auth, unknown object type, HubSpot outage) still propagates.
  async findProperty({ accessToken, objectType, propertyName }) {
    const path = this.buildPropertyPath({ objectType, propertyName });

    try {
      return await this.get(accessToken, path);
    } catch (error) {
      if (error?.details?.status === 404) {
        return null;
      }

      throw error;
    }
  }

  async updatePropertyOptions({ accessToken, objectType, propertyName, options }) {
    const path = this.buildPropertyPath({ objectType, propertyName });

    return this.patch(accessToken, path, { options });
  }
}

export default HubspotPropertyAdapter;
