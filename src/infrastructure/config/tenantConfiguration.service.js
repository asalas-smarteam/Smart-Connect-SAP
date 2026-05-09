const tenantConfigurationService = {
  async getValue(tenantModels, key, defaultValue, options = {}) {
    const Configuration = tenantModels?.Configuration;
    const normalizedKey = key;
    const userUpdated = options.userUpdated || 'admin';

    if (!Configuration) {
      return defaultValue;
    }

    const filter = { key: normalizedKey };
    const update = {
      $setOnInsert: {
        key: normalizedKey,
        value: defaultValue,
        userUpdated,
      },
    };

    const configuration = await Configuration.findOneAndUpdate(filter, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    });

    return configuration?.value ?? defaultValue;
  },
};

export default tenantConfigurationService;
