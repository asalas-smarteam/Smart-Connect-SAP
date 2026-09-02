import FieldMappingService from '#application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
import DynamicDescriptionConfigRepository from '#infrastructure/config/DynamicDescriptionConfigRepository.js';
import PhoneNormalizationConfigRepository from '#infrastructure/config/PhoneNormalizationConfigRepository.js';

export function buildFieldMappingService() {
  return new FieldMappingService({
    fieldMappingRepository: new TenantFieldMappingRepository(),
    dynamicDescriptionConfigRepository: new DynamicDescriptionConfigRepository(),
    phoneNormalizationConfigRepository: new PhoneNormalizationConfigRepository(),
  });
}

export default buildFieldMappingService;
