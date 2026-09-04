import { createOwnerDirectory } from '#domain/owners/owner-directory.service.js';
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';

// Carga la tabla de homologación de usuarios del tenant (OwnerMappings) una vez
// por corrida.
//
// Devolver null significa "no traduzcas": es lo que deja a un tenant con la
// conducta que tenía antes de que existiera `userField`. Pasa cuando el tenant
// es S/4 (la homologación se acordó SOLO para B1: en S/4 el propietario se
// resuelve por el BusinessPartner del Gateway, no por SalesPersonCode), cuando
// no hay credencial de HubSpot, o cuando la colección está vacía.
//
// Nunca lanza: un fallo leyendo esta tabla no puede tumbar un sync ni un
// webhook. En el peor caso no se traduce, que es exactamente lo que pasaba
// antes de esta funcionalidad.
export class OwnerDirectoryRepository {
  async loadOwnerDirectory({ tenantModels, tenantContext, hubspotCredentialId } = {}) {
    const models = tenantModels ?? tenantContext?.tenantModels;
    const OwnerMapping = models?.OwnerMapping;

    if (!hubspotCredentialId || typeof OwnerMapping?.find !== 'function') {
      return null;
    }

    try {
      const sapFlavor = await resolveSapFlavor({ tenantModels: models });

      if (sapFlavor !== SAP_FLAVORS.B1) {
        return null;
      }

      const query = OwnerMapping.find({ hubspotCredentialId, active: true });
      const rows = typeof query?.lean === 'function' ? await query.lean() : await query;
      const directory = createOwnerDirectory(rows);

      // Sin una sola fila homologada el directorio no puede traducir nada, y
      // devolverlo igual solo lograría que TODO campo `userField` se omitiera
      // en silencio. Null deja la conducta anterior intacta.
      return directory.size > 0 ? directory : null;
    } catch (error) {
      console.error('Owner directory read error:', error);
      return null;
    }
  }
}

export default OwnerDirectoryRepository;
