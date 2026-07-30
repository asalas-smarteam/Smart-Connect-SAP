import { DYNAMIC_DESCRIPTION_CONFIG_KEY } from '#domain/sync/dynamic-description.constants.js';
import { normalizeDynamicDescriptionConfig } from '#domain/sync/dynamic-description.service.js';

export { DYNAMIC_DESCRIPTION_CONFIG_KEY };

export class DynamicDescriptionConfigRepository {
  async getDynamicDescriptionConfig({ tenantContext, tenantModels } = {}) {
    const Configuration = (tenantContext?.tenantModels ?? tenantModels)?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return normalizeDynamicDescriptionConfig(null);
    }

    const query = Configuration.findOne({ key: DYNAMIC_DESCRIPTION_CONFIG_KEY });
    const configuration = typeof query?.lean === 'function'
      ? await query.lean()
      : await query;

    return normalizeDynamicDescriptionConfig(configuration?.value);
  }
}

export default DynamicDescriptionConfigRepository;
