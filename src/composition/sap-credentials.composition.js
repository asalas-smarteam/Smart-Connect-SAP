import ManageSapCredentials from '#application/use-cases/ManageSapCredentials.js';
import MongooseObjectIdValidator from '#infrastructure/database/MongooseObjectIdValidator.js';
import TenantSapCredentialsRepository from '#infrastructure/database/repositories/TenantSapCredentialsRepository.js';

export function buildManageSapCredentials() {
  return new ManageSapCredentials({
    sapCredentialsRepository: new TenantSapCredentialsRepository(),
    objectIdValidator: new MongooseObjectIdValidator(),
  });
}

export default buildManageSapCredentials;
