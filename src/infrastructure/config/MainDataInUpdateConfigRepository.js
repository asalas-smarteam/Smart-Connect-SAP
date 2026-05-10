import {
  DEFAULT_MAIN_DATA_IN_UPDATE,
  normalizeMainDataInUpdate,
} from '#domain/sync/main-data-in-update.constants.js';
import tenantConfigurationService from './tenantConfiguration.service.js';

export const MAIN_DATA_IN_UPDATE_CONFIG_KEY = 'mainDataInUpdate';

export class MainDataInUpdateConfigRepository {
  async getMainDataInUpdate({ tenantModels }) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      MAIN_DATA_IN_UPDATE_CONFIG_KEY,
      DEFAULT_MAIN_DATA_IN_UPDATE
    );

    return normalizeMainDataInUpdate(value);
  }
}

export default MainDataInUpdateConfigRepository;
