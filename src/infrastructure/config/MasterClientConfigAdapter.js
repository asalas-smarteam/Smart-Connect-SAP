import { FeatureFlags } from '../database/master/database.js';
import {
  createMasterClientConfig,
  deleteMasterClientConfig,
  listMasterClientConfigs,
  patchMasterClientConfig,
} from './masterClientConfig.service.js';

export class MasterClientConfigAdapter {
  constructor({ masterConnection = FeatureFlags.db } = {}) {
    this.masterConnection = masterConnection;
  }

  list() {
    return listMasterClientConfigs(this.masterConnection);
  }

  create(payload) {
    return createMasterClientConfig(this.masterConnection, payload);
  }

  patch(id, payload) {
    return patchMasterClientConfig(this.masterConnection, id, payload);
  }

  delete(id) {
    return deleteMasterClientConfig(this.masterConnection, id);
  }
}

export const masterClientConfigAdapter = new MasterClientConfigAdapter();

export default masterClientConfigAdapter;
