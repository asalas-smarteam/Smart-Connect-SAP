import mappingService from '../database/repositories/mapping.service.js';

export class MappingSyncRepository {
  async mapRecords({ sapRecords, hubspotCredentialId, objectType, tenantModels }) {
    return mappingService.mapRecords(
      sapRecords,
      hubspotCredentialId,
      objectType,
      tenantModels
    );
  }
}

export default MappingSyncRepository;

