const tenantConfigurationService = {
  async getValue(tenantModels, key, defaultValue, options = {}) {
    const Configuration = tenantModels?.Configuration;
    const normalizedKey = key;
    const userUpdated = options.userUpdated || 'admin';

    if (!Configuration) {
      return defaultValue;
    }

    const filter = { key: normalizedKey };

    // Fast path: plain lean read. getValue runs on hot paths (per item in some flows),
    // so the write-locking upsert below must only happen the first time a key is missing.
    if (typeof Configuration.findOne === 'function') {
      const query = Configuration.findOne(filter);
      const existing = typeof query?.lean === 'function' ? await query.lean() : await query;

      if (existing) {
        return existing.value ?? defaultValue;
      }
    }

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
