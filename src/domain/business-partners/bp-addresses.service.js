import { PermanentWebhookError } from '#shared/errors/index.js';
import { BP_ADDRESS_STRATEGIES } from './business-partner-creation.constants.js';

export const BP_ADDRESS_WARNINGS = Object.freeze({
  WITHOUT_NAME: 'BP_ADDRESS_WITHOUT_NAME',
  NAME_NOT_CONFIGURED: 'BP_ADDRESS_NAME_NOT_CONFIGURED',
});

function normalizeAddressName(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Nunca se manda null explícito a SAP en una creación: un campo vacío se omite
// y SAP aplica su propio default.
function omitBlank(source) {
  const result = {};

  for (const [field, value] of Object.entries(source || {})) {
    if (value === null || typeof value === 'undefined' || value === '') {
      continue;
    }

    result[field] = value;
  }

  return result;
}

export function buildBpAddresses({ mappedAddresses, addressesConfig, addressDefaults }) {
  if (addressesConfig?.strategy !== BP_ADDRESS_STRATEGIES.PAYLOAD_ARRAY) {
    return { addresses: [], warnings: [] };
  }

  const entries = Array.isArray(mappedAddresses) ? mappedAddresses : [];
  const byName = addressesConfig.byName || {};
  const addresses = [];
  const warnings = [];
  const presentNames = new Set();

  for (const entry of entries) {
    const addressName = String(entry?.AddressName ?? '').trim();

    if (!addressName) {
      warnings.push({ code: BP_ADDRESS_WARNINGS.WITHOUT_NAME });
      continue;
    }

    const normalizedName = normalizeAddressName(addressName);
    presentNames.add(normalizedName);

    const configuredValues = byName[normalizedName];

    if (!configuredValues) {
      warnings.push({ code: BP_ADDRESS_WARNINGS.NAME_NOT_CONFIGURED, addressName });
    }

    // Precedencia: defaults -> byName -> payload. AddressName se reafirma al
    // final porque el que va a SAP es el del payload (con trim), no el de la
    // llave normalizada de la config.
    addresses.push({
      ...omitBlank(addressDefaults),
      ...omitBlank(configuredValues),
      ...omitBlank(entry),
      AddressName: addressName,
    });
  }

  const missing = (addressesConfig.required || []).filter((name) => !presentNames.has(name));

  if (missing.length > 0) {
    throw new PermanentWebhookError(
      `El payload no trae las direcciones obligatorias (bpAddress): ${missing.join(', ')}`
    );
  }

  return { addresses, warnings };
}

export default { buildBpAddresses, BP_ADDRESS_WARNINGS };
