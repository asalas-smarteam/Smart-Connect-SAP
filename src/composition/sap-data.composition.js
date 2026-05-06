import SapSyncDataAdapter from '#infrastructure/sap/SapSyncDataAdapter.js';

export function buildSapSyncDataAdapter() {
  return new SapSyncDataAdapter();
}

export default buildSapSyncDataAdapter;
