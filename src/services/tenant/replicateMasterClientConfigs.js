import logger from '../../core/logger.js';
import { createMasterClientConfigModel } from '../../../models/master/ClientConfig.js';
import { buildMergedFilters } from './clientConfigFilters.service.js';
import {
  ensureDefaultContactEmployeeMappings,
  ensureDefaultDealMappings,
  ensureDefaultProductMappings,
  ensureDefaultCompanyEmployeeMappings,
} from './defaultClientConfigMappings.service.js';

function buildClientConfigPayload({
  masterConfig,
  integrationModeId,
  defaultFilters,
  hubspotCredentialId,
}) {
  const merged = buildMergedFilters({
    defaultFilters,
    customFilters: [],
  });

  return {
    clientName: masterConfig.clientName,
    objectType: masterConfig.objectType,
    mode: masterConfig.mode || 'INCREMENTAL',
    intervalMinutes: masterConfig.intervalMinutes,
    executionTime: masterConfig.executionTime || null,
    serviceLayerPath: masterConfig.serviceLayerPath,
    integrationModeId,
    hubspotCredentialId: hubspotCredentialId || null,
    active: false,
    filters: merged.filters,
  };
}

export async function replicateMasterClientConfigs({
  masterConnection,
  tenantModels,
  hubspotCredentialId = null,
}) {
  const {
    ClientConfig,
    FieldMapping,
    IntegrationMode,
    SapFilter,
  } = tenantModels;

  try {
    const MasterClientConfig = createMasterClientConfigModel(masterConnection);
    const masterConfigs = await MasterClientConfig.find({ syncInTenant: true }).lean();

    if (!masterConfigs.length) {
      logger.info({ msg: 'No master ClientConfigs marked for tenant synchronization' });
      return;
    }

    const serviceLayerMode = await IntegrationMode.findOne({ name: 'SERVICE_LAYER' }).lean();
    if (!serviceLayerMode?._id) {
      throw new Error('SERVICE_LAYER integration mode not found in tenant database');
    }

    const existingClientNames = new Set(
      (await ClientConfig.find({}, { clientName: 1 }).lean())
        .map((config) => String(config.clientName || '').trim())
        .filter(Boolean)
    );

    for (const masterConfig of masterConfigs) {
      const clientName = String(masterConfig.clientName || '').trim();
      const objectType = String(masterConfig.objectType || '').trim();

      if (!clientName || !objectType) {
        continue;
      }

      if (existingClientNames.has(clientName)) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const defaultFilters = await SapFilter.find({
        objectType,
        active: true,
      }).lean();

      const payload = buildClientConfigPayload({
        masterConfig,
        integrationModeId: serviceLayerMode._id,
        defaultFilters,
        hubspotCredentialId,
      });

     
      const createdConfig = await ClientConfig.create(payload);
      
      await ensureDefaultCompanyEmployeeMappings({
        FieldMapping,
        clientConfig: createdConfig,
      });

      await ensureDefaultContactEmployeeMappings({
        FieldMapping,
        clientConfig: createdConfig,
      });

      await ensureDefaultDealMappings({
        FieldMapping,
        clientConfig: createdConfig,
      });
      
      await ensureDefaultProductMappings({
        FieldMapping,
        clientConfig: createdConfig,
      });
      existingClientNames.add(clientName);
    }

    logger.info({
      msg: 'Replicated master ClientConfigs into tenant database',
      sourceCount: masterConfigs.length,
    });
  } catch (error) {
    logger.error({
      msg: 'Failed to replicate master ClientConfigs into tenant database',
      error,
    });
    throw error;
  }
}

export default replicateMasterClientConfigs;
