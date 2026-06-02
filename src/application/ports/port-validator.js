function normalizeMethods(methods) {
  return Array.isArray(methods)
    ? methods.map((method) => String(method || '').trim()).filter(Boolean)
    : [];
}

export function createPort({ name, methods }) {
  const normalizedName = String(name || '').trim();
  const normalizedMethods = normalizeMethods(methods);

  if (!normalizedName) {
    throw new Error('Port name is required');
  }

  if (normalizedMethods.length === 0) {
    throw new Error(`${normalizedName} must define at least one method`);
  }

  return Object.freeze({
    name: normalizedName,
    methods: Object.freeze([...new Set(normalizedMethods)]),
  });
}

export function assertPort(adapter, port) {
  if (!port?.name) {
    throw new Error('Port definition must include a name');
  }

  const methods = normalizeMethods(port.methods);
  if (methods.length === 0) {
    throw new Error(`${port.name} must define at least one method`);
  }

  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`${port.name} missing methods: ${missing.join(', ')}`);
  }

  return adapter;
}

export function assertPorts(definitions = []) {
  return definitions.map(({ adapter, port }) => assertPort(adapter, port));
}
