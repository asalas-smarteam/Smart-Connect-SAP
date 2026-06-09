import MappingSyncRepository from '#infrastructure/repositories/MappingSyncRepository.js';
import TenantFieldMappingRepository from './TenantFieldMappingRepository.js';

const mappingRepository = new MappingSyncRepository();
const fieldMappingRepository = new TenantFieldMappingRepository();

const mappingService = {
  async getMappingsByObjectType(hubspotCredentialId, objectType, sourceContext, tenantModels) {
    let mappings = await fieldMappingRepository.findByCredentialObjectAndContext({
      tenantModels,
      hubspotCredentialId,
      objectType,
      sourceContext,
      activeOnly: true,
    });

    if (mappings.length === 0 && sourceContext !== 'businessPartner') {
      mappings = await fieldMappingRepository.findByCredentialObjectAndContext({
        tenantModels,
        hubspotCredentialId,
        objectType,
        sourceContext: 'businessPartner',
        activeOnly: true,
      });
    }

    return mappings;
  },

  async mapRecords(records, hubspotCredentialId, objectType, tenantModels, sourceContext) {
    return mappingRepository.mapRecords({
      sapRecords: records,
      hubspotCredentialId,
      objectType,
      tenantContext: { tenantModels },
      sourceContext,
    });
  },
};

export default mappingService;
