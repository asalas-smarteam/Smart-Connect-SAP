import ManageFieldMappings from '#application/use-cases/ManageFieldMappings.js';
import FieldMappingService from '#application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '#infrastructure/database/repositories/TenantFieldMappingRepository.js';
import TenantMappingManagementRepository from '#infrastructure/database/repositories/TenantMappingManagementRepository.js';

export function buildManageFieldMappings() {
  const fieldMappingRepository = new TenantFieldMappingRepository();
  const fieldMappingService = new FieldMappingService({
    fieldMappingRepository,
  });
  const mappingManagementRepository = new TenantMappingManagementRepository();

  return new ManageFieldMappings({
    mappingManagementRepository,
    fieldMappingService,
  });
}

export default buildManageFieldMappings;
