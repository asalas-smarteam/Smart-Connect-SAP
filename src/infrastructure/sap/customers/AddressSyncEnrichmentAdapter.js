import {
  isAddressSyncEnabled,
  readSapAddressesToProperties,
} from '#domain/business-partners/address-sync.service.js';

// Writes the address of a SAP B1 BusinessPartner into the HubSpot properties that
// Configurations.requireAddress.addresses names, one rule per property.
// Same contract as PropertiesFlagsEnrichmentAdapter and the other enrichers: it works on the set
// of mapped records in place and fails quietly, so a broken config never aborts the sync.
//
// It cannot be a FieldMapping: the source is a row of a list that has to be picked by its type,
// and a mapping reads one field of the record.
//
// B1 only comes for free: the repository clears addresses on any other flavor, so there is nothing
// to write and the isAddressSyncEnabled check below returns early.
//
// A BusinessPartner is a company or a person (contact) in HubSpot, and both carry BPAddresses.
const ENRICHED_OBJECT_TYPES = new Set(['company', 'contact']);

export class AddressSyncEnrichmentAdapter {
  constructor({ configRepository, logger = console }) {
    this.configRepository = configRepository;
    this.logger = logger;
  }

  async enrich({ mappedRecords, objectType, tenantModels }) {
    if (!ENRICHED_OBJECT_TYPES.has(objectType) || !tenantModels) {
      return;
    }

    const records = Array.isArray(mappedRecords) ? mappedRecords : [];

    try {
      // Read once for the whole run, not once per record.
      const config = await this.configRepository.getAddressSyncConfig({ tenantModels });

      if (!isAddressSyncEnabled(config)) {
        return;
      }

      for (const record of records) {
        if (!record?.rawSapData || !record?.properties) {
          continue;
        }

        // Only properties that got a value come back, so nothing here can blank a property in
        // HubSpot. They are written after the mapped ones on purpose: when a mapping and the config
        // name the same property, the address of SAP is the one that counts.
        const properties = readSapAddressesToProperties({ sapRecord: record.rawSapData, config });

        if (properties) {
          Object.assign(record.properties, properties);
        }
      }
    } catch (error) {
      this.logger.error?.('Address sync enrichment failed', { error: error?.message });
    }
  }
}

export default AddressSyncEnrichmentAdapter;
