import {
  DEFAULT_SAP_FLAVOR,
  normalizeSapFlavor,
} from '#domain/sap/sap-flavor.constants.js';

export const SAP_FLAVOR_CONFIG_KEY = 'sapFlavor';

// Resolves the tenant SAP flavor from the tenant Configuration collection.
// Tenants provisioned before this key existed have no document, so any
// missing/invalid value falls back to B1 to preserve current behavior.
export async function resolveSapFlavor({ tenantModels }) {
  const Configuration = tenantModels?.Configuration;

  if (typeof Configuration?.findOne !== 'function') {
    return DEFAULT_SAP_FLAVOR;
  }

  const query = Configuration.findOne({ key: SAP_FLAVOR_CONFIG_KEY });
  const configuration = typeof query?.lean === 'function'
    ? await query.lean()
    : await query;

  return normalizeSapFlavor(configuration?.value) || DEFAULT_SAP_FLAVOR;
}

export class SapFlavorConfigRepository {
  async resolveSapFlavor({ tenantModels }) {
    return resolveSapFlavor({ tenantModels });
  }
}

export default SapFlavorConfigRepository;
