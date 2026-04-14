function normalizeKey(key) {
  return String(key ?? '').trim();
}

function normalizeValue(value) {
  return String(value ?? '').trim();
}

const tenantConfigurationService = {
  async getValue(tenantModels, key, defaultValue, options = {}) {
    const Configuration = tenantModels?.Configuration;
    const normalizedKey = normalizeKey(key);
    const normalizedDefaultValue = normalizeValue(defaultValue);
    const userUpdated = normalizeValue(options.userUpdated || 'admin') || 'admin';

    if (!Configuration) {
      return normalizedDefaultValue;
    }

    const filter = { key: normalizedKey };
    const update = {
      $setOnInsert: {
        key: normalizedKey,
        value: normalizedDefaultValue,
        userUpdated,
      },
    };

    const configuration = await Configuration.findOneAndUpdate(filter, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    });

    return normalizeValue(configuration?.value) || normalizedDefaultValue;
  },
};

export default tenantConfigurationService;
