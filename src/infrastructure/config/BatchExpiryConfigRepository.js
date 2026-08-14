import {
  BATCH_EXPIRY_CONFIG_KEY,
  DEFAULT_BATCH_SOURCE,
  DEFAULT_BATCH_PROJECTION,
} from '#domain/batches/batch-expiry.constants.js';

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

export class BatchExpiryConfigRepository {
  // Nunca lanza: un fallo leyendo la config no puede detener un sync de
  // productos, solo significa que esta corrida no escribe lotes. Lee con
  // findOne directo (no con tenantConfiguration.service.js's getValue, que
  // hace upsert) para que un tenant que no configuro nada no termine con
  // documentos vacios creados por el solo hecho de correr el sync.
  async getBatchExpiryConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const rawConfig = await readConfiguration(Configuration, BATCH_EXPIRY_CONFIG_KEY);

      return {
        sourceName: String(rawConfig?.source ?? '').trim() || DEFAULT_BATCH_SOURCE,
        projectionName: String(rawConfig?.projection ?? '').trim() || DEFAULT_BATCH_PROJECTION,
        rawConfig,
      };
    } catch (error) {
      console.error('Batch expiry config read error:', error);
      return {
        sourceName: DEFAULT_BATCH_SOURCE,
        projectionName: DEFAULT_BATCH_PROJECTION,
        rawConfig: null,
      };
    }
  }
}

export default BatchExpiryConfigRepository;
