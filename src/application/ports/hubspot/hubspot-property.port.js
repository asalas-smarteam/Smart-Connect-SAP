import { createPort } from '../port-validator.js';

// Metadata-level access to HubSpot properties (the schema of a field), as
// opposed to HubspotSyncTargetPort which writes record values. Used by the
// dropdown sync to read a property's current option list and rewrite it.
export const HubspotPropertyPort = createPort({
  name: 'HubspotPropertyPort',
  methods: [
    // findProperty({ accessToken, objectType, propertyName }) -> property | null
    // Resolves to null on 404 so a missing property is a decision, not an error.
    'findProperty',
    // updatePropertyOptions({ accessToken, objectType, propertyName, options })
    // -> updated property. PATCH replaces the whole option array.
    'updatePropertyOptions',
  ],
});

export default HubspotPropertyPort;
