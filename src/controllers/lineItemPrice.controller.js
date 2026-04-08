import lineItemPriceService from '../services/lineItemPrice.service.js';
import { requireTenantModels } from '../utils/tenantModels.js';

function resolveStatusCode(error) {
  return /cardCode is required|lineItems must be a non-empty array|itemCode is required|\.id is required/.test(error.message)
    ? 400
    : 500;
}

const lineItemPriceController = {
  async syncPrices(req, reply) {
    try {
      const result = await lineItemPriceService.syncPrices(req.body, {
        tenantModels: requireTenantModels(req),
        tenant: req.tenant,
        tenantKey: req.tenantKey,
      });

      return reply.send({
        ok: true,
        data: result.data,
        meta: result.meta,
      });
    } catch (error) {
      req.log?.error?.({
        msg: 'Failed to sync HubSpot line item prices',
        tenantKey: req.tenantKey,
        error: error.message,
      });

      return reply.code(resolveStatusCode(error)).send({
        ok: false,
        message: error.message,
      });
    }
  },
};

export default lineItemPriceController;
