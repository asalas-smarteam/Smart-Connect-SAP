import {
  ensureDefaultCompanyEmployeeMappings,
  ensureDefaultContactEmployeeMappings,
  ensureDefaultDealMappings,
  ensureDefaultProductMappings,
} from '../../services/tenant/defaultClientConfigMappings.service.js';

export class DefaultClientConfigMappingInitializer {
  async ensureAll({ FieldMapping, clientConfig }) {
    await ensureDefaultCompanyEmployeeMappings({ FieldMapping, clientConfig });
    await ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig });
    await ensureDefaultDealMappings({ FieldMapping, clientConfig });
    await ensureDefaultProductMappings({ FieldMapping, clientConfig });
  }
}

export default DefaultClientConfigMappingInitializer;
