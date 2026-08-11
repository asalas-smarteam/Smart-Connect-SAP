import {
  ensureDefaultCompanyEmployeeMappings,
  ensureDefaultContactEmployeeMappings,
  ensureDefaultDealMappings,
  ensureDefaultInvoiceMappings,
  ensureDefaultProductMappings,
} from '#application/services/defaultClientConfigMappings.service.js';
import { DEFAULT_SAP_FLAVOR } from '#domain/sap/sap-flavor.constants.js';

export class DefaultClientConfigMappingInitializer {
  // sapFlavor was not propagated before: an API-created ClientConfig always
  // fell back to each ensureDefault*Mappings function's own B1 default,
  // regardless of the tenant's actual flavor. Passing it through here is what
  // lets ensureDefaultProductMappings skip seeding for S/4 (see its own
  // comment) and lets company/contact get the right shape for S/4 tenants
  // created through this path instead of only through tenant replication.
  async ensureAll({ FieldMapping, clientConfig, sapFlavor = DEFAULT_SAP_FLAVOR }) {
    await ensureDefaultCompanyEmployeeMappings({ FieldMapping, clientConfig, sapFlavor });
    await ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig, sapFlavor });
    await ensureDefaultDealMappings({ FieldMapping, clientConfig, sapFlavor });
    await ensureDefaultProductMappings({ FieldMapping, clientConfig, sapFlavor });
    await ensureDefaultInvoiceMappings({ FieldMapping, clientConfig });
  }
}

export default DefaultClientConfigMappingInitializer;
