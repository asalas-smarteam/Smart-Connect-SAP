import { resolveBusinessPartnerForDocument } from '../webhookQuotationSupport.js';

// Delegación PURA: el cuerpo de resolveBusinessPartnerForDocument no se toca. Esta clase solo
// existe para que el camino de B1 entre por el mismo puerto que el de S/4, y así el caso de
// uso no tenga un `if (flavor)` adentro.
export class B1DocumentBusinessPartnerResolver {
  constructor({
    hubspotWebhookAdapter,
    runtimeRepository,
    webhookReferenceRepository,
    businessPartnerPayloadStrategyFactory,
    logger,
  }) {
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.runtimeRepository = runtimeRepository;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.businessPartnerPayloadStrategyFactory = businessPartnerPayloadStrategyFactory;
    this.logger = logger;
  }

  // `sapOrderAdapter` llega por argumento, no por constructor: el caso de uso lo envuelve con
  // el grabador de auditoría por evento, así que la instancia cambia en cada ejecución.
  async findOrCreateForDocument({
    sapOrderAdapter,
    WebhookEvent,
    eventId,
    payload,
    company,
    contact,
    companyExists,
    contactExists,
    contactEmployees,
    bpAddress,
    context,
    auditTrail,
  }) {
    return resolveBusinessPartnerForDocument({
      sapOrderAdapter,
      hubspotWebhookAdapter: this.hubspotWebhookAdapter,
      runtimeRepository: this.runtimeRepository,
      webhookReferenceRepository: this.webhookReferenceRepository,
      businessPartnerPayloadStrategyFactory: this.businessPartnerPayloadStrategyFactory,
      logger: this.logger,
      WebhookEvent,
      eventId,
      payload,
      company,
      contact,
      companyExists,
      contactExists,
      contactEmployees,
      bpAddress,
      context,
      auditTrail,
    });
  }
}

export default B1DocumentBusinessPartnerResolver;
