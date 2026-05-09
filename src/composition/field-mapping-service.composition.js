import FieldMappingService from '#application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';

export function buildFieldMappingService() {
  return new FieldMappingService({
    fieldMappingRepository: new TenantFieldMappingRepository(),
  });
}

export default buildFieldMappingService;
