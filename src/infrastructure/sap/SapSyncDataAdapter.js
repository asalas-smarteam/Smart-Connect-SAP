import logger from '../logger/logger.adapter.js';
import spMode from './modes/spMode.js';
import scriptMode from './modes/scriptMode.js';
import apiMode from './modes/apiMode.js';
import serviceLayerService from './serviceLayer.service.js';
import s4ODataService from './s4ODataService.js';

export class SapSyncDataAdapter {
  async fetchData({ clientConfigId, clientConfig = null, tenantContext, fetchOptions = {} }) {
    try {
      const tenantModels = tenantContext?.tenantModels;

      if (!tenantModels) {
        throw new Error('Tenant models are required to fetch SAP data');
      }

      const { ClientConfig, SapCredentials } = tenantModels;
      const config = await ClientConfig.findById(clientConfigId).populate({
        path: 'integrationModeId',
        select: 'name',
      });

      // Devolver null acá era indistinguible de "SAP no tenía registros": el
      // sync cerraba el SyncLog en verde con 0 registros y sin error. Una config
      // que no se puede leer es una falla de configuración y tiene que quedar
      // registrada como tal, en SyncLog.errorMessage y en ClientConfig.lastError.
      if (!config) {
        throw new Error(`ClientConfig ${clientConfigId} no existe en este tenant`);
      }

      const modeName = config?.integrationModeId?.name;
      const configLabel = `"${config.clientName ?? 'sin nombre'}" (${config._id})`;

      switch (modeName) {
        case 'STORE_PROCEDURE':
          return spMode.execute(config);
        case 'SQL_SCRIPT':
          return scriptMode.execute(config);
        case 'API':
          return apiMode.execute(config);
        case 'SERVICE_LAYER':
          return this.fetchServiceLayerData({ config, SapCredentials, fetchOptions });
        case 'S4_ODATA':
          return this.fetchS4ODataData({ config, SapCredentials, fetchOptions });
        default:
          // Se distinguen los dos casos porque el arreglo es distinto: una
          // referencia rota se corrige apuntando la config al modo correcto; un
          // nombre desconocido significa que ese modo no está implementado.
          throw new Error(
            modeName
              ? `El ClientConfig ${configLabel} usa el modo de integracion "${modeName}", que este adaptador no sabe leer`
              : `El ClientConfig ${configLabel} no tiene un modo de integracion valido: integrationModeId ${config.integrationModeId ?? 'ausente'} no resuelve a ningun IntegrationMode del tenant`
          );
      }
    } catch (error) {
      logger.error('Error fetching SAP data', {
        clientConfigId,
        error: error.message,
      });
      throw new Error(`Failed to fetch SAP data: ${error.message}`);
    }
  }

  async fetchServiceLayerData({ config, SapCredentials, fetchOptions }) {
    const sapCredentials = await SapCredentials.find().lean();

    if (!sapCredentials || sapCredentials.length === 0) {
      throw new Error('SAP credentials not found for SERVICE_LAYER mode');
    }

    const mappings = Array.isArray(fetchOptions.mappings) ? fetchOptions.mappings : [];
    const mergedConfig = {
      ...sapCredentials[0],
      ...(typeof config.toObject === 'function' ? config.toObject() : config),
    };

    return serviceLayerService.execute(mergedConfig, mappings, fetchOptions);
  }

  async fetchS4ODataData({ config, SapCredentials, fetchOptions }) {
    const sapCredentials = await SapCredentials.find().lean();

    if (!sapCredentials || sapCredentials.length === 0) {
      throw new Error('SAP credentials not found for S4_ODATA mode');
    }

    const mappings = Array.isArray(fetchOptions.mappings) ? fetchOptions.mappings : [];
    const mergedConfig = {
      ...sapCredentials[0],
      ...(typeof config.toObject === 'function' ? config.toObject() : config),
    };

    return s4ODataService.execute(mergedConfig, mappings, fetchOptions);
  }
}

export default SapSyncDataAdapter;
