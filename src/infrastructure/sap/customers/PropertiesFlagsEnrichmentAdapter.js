import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';
import {
  readSapPropertiesFlags,
  PROPERTIES_FLAGS_OBJECT_TYPES,
} from '#domain/business-partners/sap-properties-flags.service.js';

// Traduce las 64 banderas booleanas PropertiesN del BusinessPartner de SAP B1 a
// UNA propiedad multi-select de HubSpot, unida por ';'. Mismo contrato que
// S4ContactEnrichmentAdapter y WarehouseStockEnrichmentAdapter: enriquece el set
// de registros mapeados en el lugar y falla en silencio, para que una config
// rota nunca aborte la sincronización.
//
// No puede ser un FieldMapping: son N campos de SAP -> 1 propiedad de HubSpot, y
// el índice único del modelo es por sourceField.
//
// Mismo set que withPropertiesFlagsSelectFields (sap-properties-flags.service.js)
// usa para gatear el $select: una sola fuente de verdad para qué objectType
// tiene PropertiesN.
const ENRICHED_OBJECT_TYPES = PROPERTIES_FLAGS_OBJECT_TYPES;

export class PropertiesFlagsEnrichmentAdapter {
  constructor({
    configRepository,
    // Overridable para los tests.
    flavorResolver = ({ tenantModels }) => resolveSapFlavor({ tenantModels }),
    logger = console,
  }) {
    this.configRepository = configRepository;
    this.flavorResolver = flavorResolver;
    this.logger = logger;
  }

  async enrich({ mappedRecords, objectType, tenantModels }) {
    // Un BusinessPartner puede ser jurídico (company) o persona (contact); las
    // PropertiesN son campos de la cabecera del BP, así que existen en ambos.
    if (!ENRICHED_OBJECT_TYPES.has(objectType) || !tenantModels) {
      return;
    }

    const records = Array.isArray(mappedRecords) ? mappedRecords : [];

    try {
      const config = await this.configRepository.getPropertiesFlagsConfig({ tenantModels });

      if (!config?.hubspotProperty) {
        return;
      }

      // Properties1..64 son campos de BusinessPartners de B1; A_BusinessPartner
      // de S/4 no los tiene.
      const sapFlavor = await this.flavorResolver({ tenantModels });

      if (sapFlavor !== SAP_FLAVORS.B1) {
        this.logger.warn?.('PropertiesN enrichment skipped: solo aplica a SAP B1', { sapFlavor });
        return;
      }

      for (const record of records) {
        if (!record?.rawSapData || !record?.properties) {
          continue;
        }

        const value = readSapPropertiesFlags({ sapRecord: record.rawSapData, config });

        // null = la strategy está apagada, no se toca la propiedad.
        // '' = la strategy está activa y no hay ninguna marcada: se escribe para
        // DESELECCIONAR todo en HubSpot. SAP es la fuente de la verdad, y
        // sanitizeProperties descarta null/undefined pero conserva ''.
        if (value !== null) {
          record.properties[config.hubspotProperty] = value;
        }
      }
    } catch (error) {
      this.logger.error?.('PropertiesN enrichment failed', { error: error?.message });
    }
  }
}

export default PropertiesFlagsEnrichmentAdapter;
