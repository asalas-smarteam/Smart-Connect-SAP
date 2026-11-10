import { PermanentWebhookError } from '#shared/errors/index.js';
import { mapHubspotToSapFields } from './order-builder.service.js';

// FieldMapping rows for the document-level AddressExtension. objectType names the payload
// object these rows read (same convention as the BP address rows), so a tenant without them
// gets [] and its quotations keep the exact payload shape they have today.
export const ADDRESS_EXTENSION_OBJECT_TYPE = 'addressExtension';
export const ADDRESS_EXTENSION_SOURCE_CONTEXT = 'addressExtension';

// Tenant Configuration key that overrides the street length SAP accepts.
export const ADDRESS_STREET_MAX_LENGTH_CONFIG_KEY = 'addressStreetMaxLength';

// SAP drops the whole street, with no error, when it is longer than this. Measured on a
// production tenant: every street of 101+ characters came back empty, streets of exactly 100
// were stored. It is only the default: each tenant can set its own limit in Configuration.
export const ADDRESS_STREET_MAX_LENGTH = 100;
const STREET_FIELDS = new Set(['BillToStreet', 'ShipToStreet']);

// A usable limit is a positive integer. Anything else (missing, text, zero, a decimal) falls back
// to the default, so a typo in Configuration never switches the check off silently.
export function normalizeStreetMaxLength(value) {
  const limit = typeof value === 'string' ? Number(value.trim()) : value;

  return Number.isInteger(limit) && limit > 0 ? limit : ADDRESS_STREET_MAX_LENGTH;
}

// Builds the SAP AddressExtension object (BillToStreet, ShipToZipCode, ...) from the
// `addressExtension` object of the HubSpot payload. Every field comes from a FieldMapping row:
// nothing is hardcoded here. Returns null when there is nothing to send, so the caller can skip
// the object entirely; SAP never receives an explicit null on creation.
//
// Absent (null/undefined) is the normal case of every tenant that does not use the feature.
// Present but not a plain object is a workflow bug that repeats on every event, so it fails
// loudly instead of creating the quotation without an address and without anyone noticing.
//
// The integration only transports data: a street longer than SAP accepts is never cut. It is
// rejected before anything reaches SAP, so the address is fixed at its source.
export function buildAddressExtension({
  source,
  mappings,
  streetMaxLength = ADDRESS_STREET_MAX_LENGTH,
}) {
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

  assertStreetsFitSap(addressExtension, normalizeStreetMaxLength(streetMaxLength));

  return Object.keys(addressExtension).length > 0 ? addressExtension : null;
}

// Names the field and the lengths only, never the address text (it is personal data).
function assertStreetsFitSap(addressExtension, maxLength) {
  const tooLong = Object.entries(addressExtension)
    .filter(([field, value]) => STREET_FIELDS.has(field) && typeof value === 'string' && value.length > maxLength)
    .map(([field, value]) => `${field} has ${value.length} characters`);

  if (tooLong.length === 0) {
    return;
  }

  throw new PermanentWebhookError(
    `The address was not sent to SAP: ${tooLong.join(' and ')}, and SAP accepts at most ${maxLength}. `
    + 'SAP drops a street that is too long without raising an error, so the document would be '
    + 'created without its address. Shorten the street in HubSpot and send the deal again.'
  );
}

export default { buildAddressExtension };
