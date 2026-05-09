import ManageDealMappings from '#application/use-cases/ManageDealMappings.js';
import MongooseObjectIdValidator from '#infrastructure/database/MongooseObjectIdValidator.js';
import TenantDealMappingRepository from '#infrastructure/database/repositories/TenantDealMappingRepository.js';

export function buildManageDealMappings() {
  return new ManageDealMappings({
    dealMappingRepository: new TenantDealMappingRepository(),
    objectIdValidator: new MongooseObjectIdValidator(),
  });
}

export default buildManageDealMappings;
