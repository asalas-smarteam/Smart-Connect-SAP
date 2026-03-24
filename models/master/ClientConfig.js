import { clientConfigSchema } from '../../src/db/models/tenant/ClientConfig.js';

export const masterClientConfigSchema = clientConfigSchema.clone();

masterClientConfigSchema.add({
  syncInTenant: {
    type: Boolean,
    default: true,
  },
});

masterClientConfigSchema.path('active').default(false);
masterClientConfigSchema.set('collection', 'ClientConfigs');

export function createMasterClientConfigModel(connection) {
  return connection.models.MasterClientConfig
    || connection.model('MasterClientConfig', masterClientConfigSchema);
}
