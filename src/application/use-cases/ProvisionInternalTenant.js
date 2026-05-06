const provisioningReasons = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
});

export class ProvisionInternalTenant {
  constructor({ provisioningService, provisioningValidator }) {
    this.provisioningService = provisioningService;
    this.provisioningValidator = provisioningValidator;
  }

  async execute(payload) {
    const validation = this.provisioningValidator.validate(payload);

    if (!validation.valid) {
      return {
        ok: false,
        reason: provisioningReasons.BAD_REQUEST,
        error: validation.error,
      };
    }

    const { planId, billingEmail = null, hubspot = null } = payload || {};

    if (!planId) {
      return {
        ok: false,
        reason: provisioningReasons.BAD_REQUEST,
        error: 'planId is required',
      };
    }

    const { client, subscription, tenantKey } = await this.provisioningService.provisionTenant({
      companyName: validation.normalizedCompanyName,
      planId,
      billingEmail,
      hubspot,
    });

    return {
      ok: true,
      data: {
        tenantId: client._id,
        tenantKey,
        nombreColeccion: tenantKey,
        estadoSuscripcion: subscription.status,
      },
    };
  }
}

export { provisioningReasons };

export default ProvisionInternalTenant;
