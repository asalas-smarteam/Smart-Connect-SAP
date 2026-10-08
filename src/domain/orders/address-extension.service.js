import { PermanentWebhookError } from '#shared/errors/index.js';
import { mapHubspotToSapFields } from './order-builder.service.js';

// FieldMapping rows for the document-level AddressExtension. objectType names the payload
// object these rows read (same convention as the BP address rows), so a tenant without them
// gets [] and its quotations keep the exact payload shape they have today.
export const ADDRESS_EXTENSION_OBJECT_TYPE = 'addressExtension';
export const ADDRESS_EXTENSION_SOURCE_CONTEXT = 'addressExtension';

// Builds the SAP AddressExtension object (BillToStreet, ShipToZipCode, ...) from the
// `addressExtension` object of the HubSpot payload. Every field comes from a FieldMapping row:
// nothing is hardcoded here. Returns null when there is nothing to send, so the caller can skip
// the object entirely; SAP never receives an explicit null on creation.
//
// Absent (null/undefined) is the normal case of every tenant that does not use the feature.
// Present but not a plain object is a workflow bug that repeats on every event, so it fails
// loudly instead of creating the quotation without an address and without anyone noticing.
export function buildAddressExtension({ source, mappings }) {
  if (source === null || typeof source === 'undefined') {
    return null;
  }

  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new PermanentWebhookError(
      'addressExtension must be an object, with the street, zip and country fields of the '
      + `billing and shipping addresses. The workflow sent ${Array.isArray(source) ? 'an array' : typeof source}.`
    );
  }

  const mapped = mapHubspotToSapFields(source, mappings);
  const addressExtension = {};

  for (const [field, value] of Object.entries(mapped)) {
    if (value === null || typeof value === 'undefined' || value === '') {
      continue;
    }

    addressExtension[field] = value;
  }

  return Object.keys(addressExtension).length > 0 ? addressExtension : null;
}

export default { buildAddressExtension };
