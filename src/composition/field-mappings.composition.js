import ManageFieldMappings from '#application/use-cases/ManageFieldMappings.js';
import FieldMappingService from '#application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
import TenantMappingManagementRepository from '#infrastructure/database/repositories/TenantMappingManagementRepository.js';
import DynamicDescriptionConfigRepository from '#infrastructure/config/DynamicDescriptionConfigRepository.js';
import PhoneNormalizationConfigRepository from '#infrastructure/config/PhoneNormalizationConfigRepository.js';
import OwnerDirectoryRepository from '#infrastructure/database/repositories/OwnerDirectoryRepository.js';

export function buildManageFieldMappings() {
  const fieldMappingRepository = new TenantFieldMappingRepository();
  const fieldMappingService = new FieldMappingService({
    fieldMappingRepository,
    dynamicDescriptionConfigRepository: new DynamicDescriptionConfigRepository(),
    phoneNormalizationConfigRepository: new PhoneNormalizationConfigRepository(),
    ownerDirectoryRepository: new OwnerDirectoryRepository(),
  });
  const mappingManagementRepository = new TenantMappingManagementRepository();

  return new ManageFieldMappings({
    mappingManagementRepository,
    fieldMappingService,
  });
}

export default buildManageFieldMappings;
