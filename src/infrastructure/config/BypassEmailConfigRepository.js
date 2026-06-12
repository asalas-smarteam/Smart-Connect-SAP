export const BYPASS_EMAIL_CONFIG_KEY = 'bypassEmail';

export class BypassEmailConfigRepository {
  async isBypassEmailEnabled({ tenantModels }) {
    const Configuration = tenantModels?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return false;
    }

    const query = Configuration.findOne({ key: BYPASS_EMAIL_CONFIG_KEY });
    const configuration = typeof query?.lean === 'function'
      ? await query.lean()
      : await query;

    return configuration?.value === true;
  }
}

export default BypassEmailConfigRepository;
