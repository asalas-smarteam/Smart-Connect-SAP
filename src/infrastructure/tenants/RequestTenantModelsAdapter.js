import { requireTenantModels } from './tenantModels.js';

export class RequestTenantModelsAdapter {
  resolve(req) {
    return requireTenantModels(req);
  }
}

export const requestTenantModelsAdapter = new RequestTenantModelsAdapter();

export default requestTenantModelsAdapter;
