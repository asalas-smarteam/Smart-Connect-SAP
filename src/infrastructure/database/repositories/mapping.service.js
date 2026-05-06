import FieldMappingService from '../../../application/services/field-mapping.service.js';
import TenantFieldMappingRepository from './TenantFieldMappingRepository.js';

const mappingService = new FieldMappingService({
  fieldMappingRepository: new TenantFieldMappingRepository(),
});

export default mappingService;
