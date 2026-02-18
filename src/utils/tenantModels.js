export function requireTenantModels(req) {
  const tenantModels = req?.tenantModels;
  if (!tenantModels) {
    throw new Error('Tenant models are not available on the request');
  }
  return tenantModels;
}
