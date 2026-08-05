import { DROPDOWN_OPTIONS_CONFIG_KEY } from '#domain/sync/dropdown-options.constants.js';
import { normalizeDropdownOptionsConfig } from '#domain/sync/dropdown-options.service.js';

export { DROPDOWN_OPTIONS_CONFIG_KEY };

// Reads the `dropdownOptionsSync` key from the tenant Configurations
// collection. A tenant that never opted in has no document, which normalizes to
// { enabled: false } -- so the flow is off unless the client asked for it.
export class DropdownOptionsConfigRepository {
  async getDropdownOptionsConfig({ tenantContext, tenantModels } = {}) {
    const Configuration = (tenantContext?.tenantModels ?? tenantModels)?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return normalizeDropdownOptionsConfig(null);
    }

    const query = Configuration.findOne({ key: DROPDOWN_OPTIONS_CONFIG_KEY });
    const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

    return normalizeDropdownOptionsConfig(configuration?.value);
  }
}

export default DropdownOptionsConfigRepository;
