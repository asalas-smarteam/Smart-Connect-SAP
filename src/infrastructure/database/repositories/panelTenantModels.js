import { getTenantConnection } from '../tenant/tenantDatabase.js';
import { createTicketModel } from '../models/panel/Ticket.js';
import { createTicketCounterModel } from '../models/panel/TicketCounter.js';

// Modelos del panel en la base de un tenant. Usa la misma conexión cacheada que el resto del
// backend, pero NO pasa por registerTenantModels: el registro de modelos de tenant no cambia.
// Quien llama ya validó el tenantKey (sesión del cliente o SaaSClients para staff): abrir una
// conexión con un tenantKey inventado no debe ocurrir.
export async function getPanelTenantModels(tenantKey, { getConnection = getTenantConnection } = {}) {
  const connection = await getConnection(tenantKey);
  return {
    connection,
    Ticket: createTicketModel(connection),
    TicketCounter: createTicketCounterModel(connection),
  };
}

export default getPanelTenantModels;
