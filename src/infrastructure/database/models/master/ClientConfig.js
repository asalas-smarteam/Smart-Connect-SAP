import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
} from '#domain/sap/sap-flavor.constants.js';
import { clientConfigSchema } from '../tenant/ClientConfig.js';

export const masterClientConfigSchema = clientConfigSchema.clone();

masterClientConfigSchema.add({
  syncInTenant: {
    type: Boolean,
    default: true,
  },
  // Which SAP flavor this template targets. Entity paths differ per flavor
  // (/Items vs /API_PRODUCT_SRV/A_Product), so each flavor has its own set.
  // Templates created before this field existed are treated as B1.
  sapFlavor: {
    type: String,
    enum: Object.values(SAP_FLAVORS),
    default: DEFAULT_SAP_FLAVOR,
    index: true,
  },
});

masterClientConfigSchema.path('active').default(false);
masterClientConfigSchema.set('collection', 'ClientConfigs');

export function createMasterClientConfigModel(connection) {
  return connection.models.MasterClientConfig
    || connection.model('MasterClientConfig', masterClientConfigSchema);
}
