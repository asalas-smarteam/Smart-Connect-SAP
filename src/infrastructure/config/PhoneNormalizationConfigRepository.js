import {
  DEFAULT_PHONE_NORMALIZATION_CONFIG,
  PHONE_NORMALIZATION_CONFIG_KEY,
  isIncompletePhoneNormalizationConfig,
  normalizePhoneNormalizationConfig,
} from '#domain/sap/hubspot-phone-fields.constants.js';

export { PHONE_NORMALIZATION_CONFIG_KEY };

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

export class PhoneNormalizationConfigRepository {
  constructor({ logger = console } = {}) {
    this.logger = logger;
  }

  // Nunca lanza: si la config no se puede leer, el sync sigue con la conducta
  // histórica (solo se limpia lo cosmético de `phone`) en vez de caerse. Lee con
  // findOne directo, sin el upsert de tenantConfiguration.service.js, para no
  // crearle documentos vacíos a un tenant que nunca configuró esto.
  async getPhoneNormalizationConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const rawValue = await readConfiguration(Configuration, PHONE_NORMALIZATION_CONFIG_KEY);
      const config = normalizePhoneNormalizationConfig(rawValue);

      // El tenant pidió prefijar y no se va a prefijar nada. Sin este aviso, el
      // síntoma es "los teléfonos siguen saliendo vacíos" y el motivo real
      // (falta defaultCountryCode o nationalNumberLengths) no aparece por
      // ningún lado.
      if (isIncompletePhoneNormalizationConfig(rawValue, config)) {
        this.logger?.warn?.(
          `${PHONE_NORMALIZATION_CONFIG_KEY}: enabled=true ignorado, `
          + 'faltan defaultCountryCode (+502) y/o nationalNumberLengths ([8]).'
        );
      }

      return config;
    } catch (error) {
      this.logger?.error?.('Phone normalization config read error:', error);
      return DEFAULT_PHONE_NORMALIZATION_CONFIG;
    }
  }
}

export default PhoneNormalizationConfigRepository;
