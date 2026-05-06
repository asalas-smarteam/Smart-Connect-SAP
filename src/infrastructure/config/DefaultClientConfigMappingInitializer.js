import {
  ensureDefaultCompanyEmployeeMappings,
  ensureDefaultContactEmployeeMappings,
  ensureDefaultDealMappings,
  ensureDefaultProductMappings,
} from '../../application/services/defaultClientConfigMappings.service.js';

export class DefaultClientConfigMappingInitializer {
  async ensureAll({ FieldMapping, clientConfig }) {
    await ensureDefaultCompanyEmployeeMappings({ FieldMapping, clientConfig });
    await ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig });
    await ensureDefaultDealMappings({ FieldMapping, clientConfig });
    await ensureDefaultProductMappings({ FieldMapping, clientConfig });
  }
}

export default DefaultClientConfigMappingInitializer;
