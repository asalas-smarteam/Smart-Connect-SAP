import { createPort } from '../port-validator.js';

// Interfaz uniforme que implementa cada strategy de payload de creación del
// BusinessPartner, para que SapWebhookOrderAdapter no sepa cuál le dio el
// factory. includesContactEmployeesInCreate() existe para que el use-case sepa
// si debe saltarse el PATCH posterior de ContactEmployees, en vez de inferirlo
// del nombre de la strategy.
export const BusinessPartnerPayloadStrategyPort = createPort({
  name: 'BusinessPartnerPayloadStrategyPort',
  methods: [
    'buildCreatePayload',
    'includesContactEmployeesInCreate',
  ],
});

export default BusinessPartnerPayloadStrategyPort;
