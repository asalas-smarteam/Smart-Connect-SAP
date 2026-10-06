import { internalKeyAuthOnly } from './internalAuth.js';
import { adminTenantResolver } from './tenantResolver.js';

// Rutas administrativas de un tenant (configuración, credenciales, mappings, corridas
// manuales). Las llama solo el equipo desde Postman: la llave interna prueba quién llama y
// el tenant sale únicamente del header x-tenant-id. Un x-tenant-id solo, sin llave, ya no
// abre la configuración ni las credenciales SAP de nadie.
//
// No sirve para un panel de clientes: INTERNAL_KEY abre todos los tenants y nunca debe
// llegar a un navegador. El panel necesita login propio con un token por tenant y rol.
export const adminTenantAuth = [internalKeyAuthOnly, adminTenantResolver];

export default adminTenantAuth;
