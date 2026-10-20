// Consulta varios tenants en paralelo, con un tiempo máximo por tenant. Un tenant que falla o
// tarda sale en warnings y no deja sin respuesta a los demás (mismo criterio que la bandeja).
export const DEFAULT_TENANT_TIMEOUT_MS = 5000;
const TENANT_ERROR = 'No se pudo consultar la base del tenant';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Tenant query timed out after ${ms} ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function queryTenants(tenants, query, { timeoutMs = DEFAULT_TENANT_TIMEOUT_MS, logger = null, label = 'Panel' } = {}) {
  const settled = await Promise.allSettled(
    tenants.map((tenant) => withTimeout(Promise.resolve().then(() => query(tenant)), timeoutMs))
  );
  const results = [];
  const warnings = [];
  settled.forEach((outcome, index) => {
    const tenant = tenants[index];
    if (outcome.status === 'fulfilled') {
      results.push({ tenant, value: outcome.value });
      return;
    }
    warnings.push({ tenantKey: tenant.tenantKey, error: TENANT_ERROR });
    logger?.warn?.({ msg: `${label}: tenant query failed`, tenantKey: tenant.tenantKey, error: outcome.reason?.message });
  });
  return { results, warnings };
}
