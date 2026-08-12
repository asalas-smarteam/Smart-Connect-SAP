// Las constantes viven en el dominio (ver el comentario de diseño allá). Se
// re-exportan acá para no romper a quien ya las importa desde este módulo
// (`tenantProvisioning.js` usa REQUIRE_ADDRESS_CONFIG_KEY).
import {
  REQUIRE_ADDRESS_CONFIG_KEY,
  ADDRESS_SYNC_NOT_IMPLEMENTED,
} from '#domain/business-partners/address-sync.constants.js';

export { REQUIRE_ADDRESS_CONFIG_KEY, ADDRESS_SYNC_NOT_IMPLEMENTED };

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

export class AddressSyncConfigRepository {
  // Nunca lanza: una config ilegible no debe tumbar una sincronización.
  async getAddressSyncConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, REQUIRE_ADDRESS_CONFIG_KEY);

      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { required: false };
      }

      return { required: raw.required === true };
    } catch (error) {
      console.error('requireAddress config read error:', error);
      return { required: false };
    }
  }
}

export default AddressSyncConfigRepository;
