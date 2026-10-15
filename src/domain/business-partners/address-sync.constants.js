// Configurations key of the address sync SAP -> HubSpot. A SAP BusinessPartner has N addresses
// (BPAddresses) and a FieldMapping copies one field, so the sync is driven by
// requireAddress.addresses: each rule picks one row of the list and maps one field of it to one
// HubSpot property of the company or the contact. required: true turns it on.
//
// They live in the domain, not in the repository, because both layers consume them: the
// infrastructure repository reads the key, and the application use case uses the code in its
// warning. With the constants here no application layer has to import from `#infrastructure/*`
// just to name a string, which would be the repository's only dependency inversion.
export const REQUIRE_ADDRESS_CONFIG_KEY = 'requireAddress';
// Warning code of a tenant that asked for the address sync (required: true) and gave nothing valid
// to write: no addresses, every rule invalid, or a tenant that is not B1. It replaces the old "not
// implemented" warning now that the feature exists.
export const ADDRESS_SYNC_MISCONFIGURED = 'ADDRESS_SYNC_MISCONFIGURED';

// AddressType values of a SAP B1 BusinessPartner address (BPAddresses[].AddressType).
export const BP_ADDRESS_TYPES = Object.freeze({
  SHIP_TO: 'bo_ShipTo',
  BILL_TO: 'bo_BillTo',
});

// Why a rule of requireAddress.addresses was left out. They are reported, never thrown: a
// broken rule must not stop the sync of the others.
export const ADDRESS_SYNC_ISSUE_CODES = Object.freeze({
  INVALID_ENTRY: 'INVALID_ENTRY',
  NO_MATCH_CRITERIA: 'NO_MATCH_CRITERIA',
  INVALID_FIELD: 'INVALID_FIELD',
  DUPLICATE_PROPERTY: 'DUPLICATE_PROPERTY',
});
