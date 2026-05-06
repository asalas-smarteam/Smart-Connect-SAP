import FieldMappingService from '../application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '../infrastructure/database/repositories/TenantFieldMappingRepository.js';

const mappingService = new FieldMappingService({
  fieldMappingRepository: new TenantFieldMappingRepository(),
});

export default mappingService;
