import { fail, panelReasons } from './panelReasons.js';

// Tenant de una ruta del panel: el de la sesión (ruta de cliente, sin :tenantKey) o el :tenantKey
// de la ruta de staff, validado contra el directorio de empresas antes de abrir la base.
// Devuelve { ok, tenantKey } o el fallo NOT_FOUND.
export async function resolveScopeTenant(tenantDirectory, { user, routeTenantKey } = {}) {
  if (routeTenantKey === undefined) {
    return user?.tenantKey ? { ok: true, tenantKey: user.tenantKey } : fail(panelReasons.NOT_FOUND);
  }
  if (typeof routeTenantKey !== 'string' || !routeTenantKey) {
    return fail(panelReasons.NOT_FOUND);
  }
  const tenant = await tenantDirectory.findByKey(routeTenantKey);
  return tenant ? { ok: true, tenantKey: tenant.tenantKey } : fail(panelReasons.NOT_FOUND);
}
