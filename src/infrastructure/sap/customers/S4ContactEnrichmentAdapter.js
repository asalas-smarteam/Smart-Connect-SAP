import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import { S4ContactResolver } from './S4ContactResolver.js';

// Key under which resolved contact persons are attached to a company's raw SAP
// record, so HandleHubspotAssociations.syncCompanyContacts can create and
// associate them — the S/4 analogue of B1's embedded ContactEmployees.
export const S4_CONTACTS_KEY = '_s4Contacts';

// Enriches the company records of an S/4 sync with their contact persons.
// No-op for non-S/4 tenants and non-company syncs (B1 already carries embedded
// ContactEmployees in rawSapData).
export class S4ContactEnrichmentAdapter {
  constructor({ resolverFactory = null, logger = console } = {}) {
    // Overridable for tests; by default builds a resolver over an S/4 transport
    // created from the tenant's own SAP credentials.
    this.resolverFactory = resolverFactory
      || ((config) => new S4ContactResolver({
        transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config }),
      }));
    this.logger = logger;
  }

  async enrich({ mappedRecords, objectType, tenantModels }) {
    if (objectType !== 'company' || !tenantModels) {
      return;
    }

    try {
      const sapFlavor = await resolveSapFlavor({ tenantModels });
      if (sapFlavor !== SAP_FLAVORS.S4) {
        return;
      }

      const records = Array.isArray(mappedRecords) ? mappedRecords : [];
      const companyIds = records
        .map((record) => record?.rawSapData?.BusinessPartner)
        .filter(Boolean);

      if (companyIds.length === 0) {
        return;
      }

      const sapCredentialsList = typeof tenantModels.SapCredentials?.find === 'function'
        ? await tenantModels.SapCredentials.find().lean()
        : [];
      const [sapCredentials] = sapCredentialsList;
      if (!sapCredentials) {
        this.logger.warn?.('S4 contact enrichment skipped: no SAP credentials');
        return;
      }

      const resolver = this.resolverFactory(sapCredentials);
      const byCompany = await resolver.resolveContactsByCompany(companyIds);

      for (const record of records) {
        if (!record?.rawSapData) {
          continue;
        }
        const companyId = String(record.rawSapData.BusinessPartner ?? '').trim();
        record.rawSapData[S4_CONTACTS_KEY] = companyId
          ? (byCompany.get(companyId) || [])
          : [];
      }
    } catch (error) {
      // Enrichment failure must not abort the company sync; contacts just
      // won't be associated this run.
      this.logger.error?.('S4 contact enrichment failed', { error: error?.message });
    }
  }
}

export default S4ContactEnrichmentAdapter;
