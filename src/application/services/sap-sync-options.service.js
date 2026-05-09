export function normalizeMode(mode) {
  const value = String(mode || 'INCREMENTAL').trim().toUpperCase();
  return value === 'FULL' ? 'FULL' : 'INCREMENTAL';
}

export function hasDynamicFilters(config) {
  if (!Array.isArray(config?.filters)) {
    return false;
  }

  return config.filters.some((filter) => filter?.isDynamic === true);
}

export function buildSapFetchOptions(config, dateProvider = () => new Date()) {
  const mode = normalizeMode(config?.mode);
  const now = dateProvider();

  if (mode === 'FULL') {
    return {
      mode,
      now,
      skipDynamicFilters: true,
      controlledFilter: null,
      dynamicIntervalMinutes: null,
    };
  }

  const intervalMinutes = Number(config?.intervalMinutes);
  const hasDynamic = hasDynamicFilters(config);
  const hasValidInterval = Number.isFinite(intervalMinutes) && intervalMinutes > 0;
  const controlledFilter = hasDynamic
    ? null
    : (hasValidInterval
      ? `UpdateDate ge ${new Date(now.getTime() - intervalMinutes * 60000).toISOString().split('.')[0]}`
      : null);

  return {
    mode,
    now,
    skipDynamicFilters: false,
    dynamicIntervalMinutes: hasValidInterval ? intervalMinutes : null,
    controlledFilter,
  };
}

