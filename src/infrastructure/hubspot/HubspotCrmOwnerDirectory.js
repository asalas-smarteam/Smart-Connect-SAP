import { getPanelTenantModels } from '../database/repositories/panelTenantModels.js';
import defaultAuthService from './hubspotAuthService.js';
import { fetchOwners as defaultFetchOwners } from './hubspotClient.js';

// Responsables del CRM de un tenant para el panel (plan 12, contrato 14, O3). Reutiliza lo mismo
// que la carga inicial (fetchOwners de hubspotClient.js) y la renovación de token del núcleo
// (hubspotAuthService.getAccessToken), sin modificarlos. Nunca loguea tokens: los errores se
// propagan y el caso de uso los traduce a crm_unavailable.
export class HubspotCrmOwnerDirectory {
  constructor({
    getModels = getPanelTenantModels,
    authService = defaultAuthService,
    fetchOwners = defaultFetchOwners,
  } = {}) {
    this.getModels = getModels;
    this.authService = authService;
    this.fetchOwnersFromCrm = fetchOwners;
  }

  async listCredentials(tenantKey) {
    const { HubspotCredentials } = await this.getModels(tenantKey);
    const credentials = await HubspotCredentials.find({}, { _id: 1 }).sort({ _id: 1 }).lean();
    return credentials.map((credential) => ({ id: String(credential._id) }));
  }

  async fetchOwners(tenantKey, credentialId) {
    const { HubspotCredentials } = await this.getModels(tenantKey);
    const credential = await HubspotCredentials.findById(String(credentialId)).lean();
    if (!credential) {
      throw new Error('CRM credential not found');
    }
    // Si el token no venció lo devuelve; si no, lo renueva (refreshAccessToken busca la
    // credencial por clientConfigId o por _id, así que sirve el _id).
    const accessToken = await this.authService.getAccessToken(credential._id, credential, { HubspotCredentials });
    if (!accessToken) {
      throw new Error('CRM access token unavailable');
    }
    return this.fetchOwnersFromCrm(accessToken);
  }
}

export default HubspotCrmOwnerDirectory;
