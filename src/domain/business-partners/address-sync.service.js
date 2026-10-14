import { ADDRESS_SYNC_ISSUE_CODES, BP_ADDRESS_TYPES } from './address-sync.constants.js';

// Reads the value of Configurations.requireAddress, the gate of the address sync SAP -> HubSpot:
//
//   { required: true,
//     addresses: [
//       { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
//       { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' } ] }
//
// `addresses` is a list of rules and one rule is one HubSpot property: it picks a row of the
// BPAddresses list by `AddressType` and/or `AddressName`, and says which field of that row
// (`sourceField`) goes to which HubSpot property (`targetField`). Several rules can share the same
// row, say Street and City of the ship-to. This is the direction SAP -> HubSpot, unlike the
// addresses of businessPartnerCreation, which carry fixed values for SAP.
//
// Pure and total: any value comes back as something usable, and what was left out is listed in
// `issues` so the caller can report it. Nothing here throws, because a config nobody can read must
// never stop a sync.

const SAP_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ADDRESS_TYPE_BY_LOWERCASE = new Map(
  Object.values(BP_ADDRESS_TYPES).map((addressType) => [addressType.toLowerCase(), addressType])
);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAddressType(value) {
  return ADDRESS_TYPE_BY_LOWERCASE.get(cleanString(value).toLowerCase()) ?? null;
}

// Turns the raw rules into normalized ones: `{ addressType, addressName, sourceField, targetField }`.
// A BPAddresses field is a plain SAP identifier. The HubSpot property is kept exactly as written
// (trimmed): it has to equal the internal name, which is the one that exists in the portal.
// A rule that cannot be used is left out and reported by its position in the list.
export function normalizeAddressSyncConfig(rawValue) {
  if (!isPlainObject(rawValue)) {
    return { required: false, addresses: [], issues: [] };
  }

  const addresses = [];
  const issues = [];
  // Two rules writing the same HubSpot property would overwrite each other without an error and
  // leave, say, the bill-to address in the ship-to field. The first one keeps it.
  const claimedProperties = new Set();
  const rawRules = Array.isArray(rawValue.addresses) ? rawValue.addresses : [];

  rawRules.forEach((rawRule, entry) => {
    if (!isPlainObject(rawRule)) {
      issues.push({ entry, code: ADDRESS_SYNC_ISSUE_CODES.INVALID_ENTRY });
      return;
    }

    const addressType = normalizeAddressType(rawRule.AddressType);
    const addressName = cleanString(rawRule.AddressName).toLowerCase() || null;

    if (!addressType && !addressName) {
      issues.push({ entry, code: ADDRESS_SYNC_ISSUE_CODES.NO_MATCH_CRITERIA });
      return;
    }

    const sourceField = cleanString(rawRule.sourceField);
    const targetField = cleanString(rawRule.targetField);

    if (!SAP_FIELD_PATTERN.test(sourceField) || !targetField) {
      issues.push({ entry, code: ADDRESS_SYNC_ISSUE_CODES.INVALID_FIELD });
      return;
    }

    const claimKey = targetField.toLowerCase();

    if (claimedProperties.has(claimKey)) {
      issues.push({ entry, code: ADDRESS_SYNC_ISSUE_CODES.DUPLICATE_PROPERTY, property: targetField });
      return;
    }

    claimedProperties.add(claimKey);
    addresses.push({ addressType, addressName, sourceField, targetField });
  });

  return { required: rawValue.required === true, addresses, issues };
}

// The feature runs only when it was asked for and there is something to write.
export function isAddressSyncEnabled(config) {
  return config?.required === true
    && Array.isArray(config.addresses)
    && config.addresses.length > 0;
}

// A BPAddresses row belongs to a rule when every criterion the rule sets agrees. The type is
// compared ignoring case; the name the way the config keys are, lowercased and trimmed.
function rowMatchesRule(row, rule) {
  if (!isPlainObject(row) || !isPlainObject(rule)) {
    return false;
  }

  // A rule that sets neither criterion matches nothing. The normalizer never lets one through,
  // but this function is exported and only checks that the feature is on, so a config that never
  // went through the normalizer must not make every rule match the first row: that would pick the
  // address by position and write the wrong one into HubSpot with no error.
  if (!rule.addressType && !rule.addressName) {
    return false;
  }

  if (rule.addressType && cleanString(row.AddressType).toLowerCase() !== rule.addressType.toLowerCase()) {
    return false;
  }

  if (rule.addressName && cleanString(row.AddressName).toLowerCase() !== rule.addressName) {
    return false;
  }

  return true;
}

// What can be written into a HubSpot property: a scalar with something in it. A value SAP leaves
// empty is dropped, never sent blank, because a blank would erase what someone typed by hand in
// HubSpot. An object or an array is not a property value and HubSpot would reject the whole batch.
function toWritableValue(value) {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value;
  }

  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }

  return null;
}

// Projects the BPAddresses of a SAP BusinessPartner into the HubSpot properties the config names.
//
//   null  the feature is off for this tenant (not asked for, or nothing valid to write)
//   {}    the feature is on and this BusinessPartner has nothing to write
//
// The row is picked by type or name, never by position, and the first match wins. Only properties
// that got a value are in the result, so no caller can blank a property by accident.
export function readSapAddressesToProperties({ sapRecord, config }) {
  if (!isAddressSyncEnabled(config)) {
    return null;
  }

  const rows = Array.isArray(sapRecord?.BPAddresses) ? sapRecord.BPAddresses : [];
  const properties = {};

  for (const rule of config.addresses) {
    if (!isPlainObject(rule) || !rule.sourceField || !rule.targetField) {
      continue;
    }

    const row = rows.find((candidate) => rowMatchesRule(candidate, rule));

    if (!row) {
      continue;
    }

    const value = toWritableValue(row[rule.sourceField]);

    if (value !== null) {
      properties[rule.targetField] = value;
    }
  }

  return properties;
}

export default { normalizeAddressSyncConfig, isAddressSyncEnabled, readSapAddressesToProperties };
