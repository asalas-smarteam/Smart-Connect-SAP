import { getTenantConnection } from '../tenant/tenantDatabase.js';
import { createTicketModel } from '../models/panel/Ticket.js';
import { createTicketCounterModel } from '../models/panel/TicketCounter.js';
import { createOwnerMappingHistoryModel } from '../models/panel/OwnerMappingHistory.js';
import { createOwnerMappingModel } from '../models/tenant/OwnerMapping.js';
import { createHubspotCredentialsModel } from '../models/tenant/HubspotCredentials.js';

// Modelos del panel en la base de un tenant. Usa la misma conexión cacheada que el resto del
// backend, pero NO pasa por registerTenantModels: el registro de modelos de tenant no cambia.
// Quien llama ya validó el tenantKey (sesión del cliente o SaaSClients para staff): abrir una
// conexión con un tenantKey inventado no debe ocurrir.
//
// OwnerMapping, HubspotCredentials y OwnerMappingHistory (plan 12) se registran recién cuando
// alguien los usa: OwnerMapping y HubspotCredentials son los modelos del núcleo (mismo factory,
// que reutiliza el modelo si la conexión ya lo tiene) y al compilarse pueden crear colección e
// índices; así leer tickets (bandeja de staff) sigue sin tocar nada de eso.
export async function getPanelTenantModels(tenantKey, { getConnection = getTenantConnection } = {}) {
  const connection = await getConnection(tenantKey);
  const models = {
    connection,
    Ticket: createTicketModel(connection),
    TicketCounter: createTicketCounterModel(connection),
  };
  const lazy = {
    OwnerMapping: createOwnerMappingModel,
    HubspotCredentials: createHubspotCredentialsModel,
    OwnerMappingHistory: createOwnerMappingHistoryModel,
  };
  for (const [name, create] of Object.entries(lazy)) {
    Object.defineProperty(models, name, {
      enumerable: false,
      configurable: true,
      get: () => create(connection),
    });
  }
  return models;
}

export default getPanelTenantModels;
