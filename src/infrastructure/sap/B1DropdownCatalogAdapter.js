import { B1ServiceLayerTransport } from './transport/B1ServiceLayerTransport.js';

async function resolveSapCredentials(tenantContext) {
  const { SapCredentials } = tenantContext?.tenantModels ?? {};

  if (typeof SapCredentials?.find !== 'function') {
    throw new Error('Tenant context with SapCredentials model is required to read SAP catalogs');
  }

  const query = SapCredentials.find();
  const credentialsList = typeof query?.lean === 'function' ? await query.lean() : await query;
  const [credentials] = Array.isArray(credentialsList) ? credentialsList : [];

  if (!credentials) {
    throw new Error('SAP credentials not found for this tenant');
  }

  return credentials;
}

// The transport forwards query values untouched (its callers pre-encode OData
// options), and the config stores them raw so a human can read the $filter --
// so the encoding happens here.
function encodeQuery(query) {
  return Object.entries(query ?? {}).reduce((accumulator, [key, value]) => {
    accumulator[key] = encodeURIComponent(String(value));
    return accumulator;
  }, {});
}

// Reads the rows behind a dropdown from the B1 Service Layer. Only B1: the
// dropdown flow is gated on sapFlavor before it gets here.
export class B1DropdownCatalogAdapter {
  constructor({ createTransport = (config) => new B1ServiceLayerTransport({ config }) } = {}) {
    this.createTransport = createTransport;
  }

  async fetchRows({ tenantContext, serviceLayerPath, query = {} }) {
    if (!serviceLayerPath) {
      throw new Error('serviceLayerPath is required to read a SAP catalog');
    }

    const credentials = await resolveSapCredentials(tenantContext);
    const transport = this.createTransport({
      ...credentials,
      tenantKey: tenantContext?.tenantKey ?? credentials?.tenantKey ?? null,
    });
    const rows = await transport.fetchAll({
      path: serviceLayerPath,
      query: encodeQuery(query),
    });

    return Array.isArray(rows) ? rows : [];
  }
}

export default B1DropdownCatalogAdapter;
