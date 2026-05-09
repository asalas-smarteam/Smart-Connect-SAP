import ManageOwnerMappings from '#application/use-cases/ManageOwnerMappings.js';
import MongooseObjectIdValidator from '#infrastructure/database/MongooseObjectIdValidator.js';
import TenantOwnerMappingRepository from '#infrastructure/database/repositories/TenantOwnerMappingRepository.js';

export function buildManageOwnerMappings() {
  return new ManageOwnerMappings({
    ownerMappingRepository: new TenantOwnerMappingRepository(),
    objectIdValidator: new MongooseObjectIdValidator(),
  });
}

export default buildManageOwnerMappings;
