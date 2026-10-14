// Las constantes viven en el dominio (ver el comentario de diseño allá). Se
// re-exportan acá para no romper a quien ya las importa desde este módulo
// (`tenantProvisioning.js` usa REQUIRE_ADDRESS_CONFIG_KEY).
import { REQUIRE_ADDRESS_CONFIG_KEY } from '#domain/business-partners/address-sync.constants.js';

import { normalizeAddressSyncConfig } from '#domain/business-partners/address-sync.service.js';
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';

export { REQUIRE_ADDRESS_CONFIG_KEY };

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
  //
  // Devuelve `{ required, addresses }`. `addresses` es la lista de reglas que dicen qué campo de qué
  // dirección va a qué propiedad de HubSpot y llega vacía cuando no hay nada válido, que es lo que
  // tiene hoy cualquier tenant.
  async getAddressSyncConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, REQUIRE_ADDRESS_CONFIG_KEY);
      const { required, addresses, issues } = normalizeAddressSyncConfig(raw);

      if (issues.length > 0) {
        console.warn('requireAddress: reglas ignoradas', { issues });
      }

      // BPAddresses anidado es forma de SAP B1. En S/4 es otra entidad, así que `addresses` se ignora
      // en vez de pedirle a un servicio un campo que no existe. Se vacía solo `addresses` y `required`
      // queda como el tenant lo escribió: quien lo pidió sigue viendo "pidió la función y no hay
      // nada que escribir", igual que con `required: true` y un `addresses` vacío.
      if (addresses.length > 0) {
        const sapFlavor = await resolveSapFlavor({ tenantModels: { Configuration } });

        if (sapFlavor !== SAP_FLAVORS.B1) {
          console.warn('requireAddress.addresses ignorada: solo aplica a SAP B1', { sapFlavor });
          return { required, addresses: [] };
        }
      }

      return { required, addresses };
    } catch (error) {
      console.error('requireAddress config read error:', error);
      return { required: false, addresses: [] };
    }
  }
}

export default AddressSyncConfigRepository;
