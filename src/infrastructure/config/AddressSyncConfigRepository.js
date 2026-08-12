// Compuerta de la sincronización de direcciones SAP -> HubSpot. Hoy siempre
// apagada: un BusinessPartner de SAP tiene N direcciones y una company de
// HubSpot un solo juego de propiedades de dirección, así que el destino correcto
// es un custom object de HubSpot y eso es un spec aparte. La clave existe para
// declarar la intención y para que un tenant no active algo que no está hecho
// sin enterarse.
export const REQUIRE_ADDRESS_CONFIG_KEY = 'requireAddress';
export const ADDRESS_SYNC_NOT_IMPLEMENTED = 'ADDRESS_SYNC_NOT_IMPLEMENTED';

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
