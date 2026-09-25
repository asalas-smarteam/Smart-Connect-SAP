import { createPort } from '../port-validator.js';

// Resolución (y creación) del cliente del documento. La implementación de B1 delega en
// resolveBusinessPartnerForDocument tal como está hoy; la de S/4 habla A_BusinessPartner.
export const SapDocumentBusinessPartnerPort = createPort({
  name: 'SapDocumentBusinessPartnerPort',
  methods: [
    // findOrCreateForDocument(args) -> { cardCode, businessPartnerResult, contactEmployeeResult,
    //   contactEmployeeFailures, hubspotToken, dealContactIsContactEmployee }
    'findOrCreateForDocument',
  ],
});

export default SapDocumentBusinessPartnerPort;
