import lineItemPriceService from "../services/lineItemPrice.service.js";
import lineItemPriceWebhookService from "../services/lineItemPriceWebhook.service.js";
import { requireTenantModels } from "../utils/tenantModels.js";
const SUPPORTED_ASSOCIATION_TYPE = "DEAL_TO_LINE_ITEM";

function resolveStatusCode(error) {
  return /cardCode is required|lineItems must be a non-empty array|itemCode is required|\.id is required|portalId is required|eventId is required|subscriptionId is required|appId is required|occurredAt is required|fromObjectId is required/.test(
    error.message,
  )
    ? 400
    : 500;
}

const lineItemPriceController = {
  async syncPrices(req, reply) {
    let tenantModels = null;
    let executionId = null;

    try {

      tenantModels = requireTenantModels(req);

      const preparedPayload = await lineItemPriceWebhookService.preparePayload(
        req.body[0],
        {
          tenantModels,
          tenant: req.tenant,
        },
      );

      if (preparedPayload.skip) {
        return reply.send({
          ok: true,
          data: null,
          meta: preparedPayload.meta,
        });
      }

      executionId = preparedPayload.executionId;

      const result = await lineItemPriceService.syncPrices(
        preparedPayload.payload,
        {
          tenantModels,
          tenant: req.tenant,
          tenantKey: req.tenantKey,
        },
      );

      if (executionId) {
        await lineItemPriceWebhookService.markAsSent(
          tenantModels.LineItemPriceWebhookEvent,
          executionId,
        );
      }

      return reply.send({
        ok: true,
        data: result.data,
        meta: result.meta,
      });
    } catch (error) {
      req.log?.error?.({
        msg: "Failed to sync HubSpot line item prices",
        tenantKey: req.tenantKey,
        error: error.message,
      });

      if (executionId) {
        await lineItemPriceWebhookService.markAsError(
          tenantModels.LineItemPriceWebhookEvent,
          executionId,
          error,
        );
      }

      return reply.code(resolveStatusCode(error)).send({
        ok: false,
        message: error.message,
      });
    }
  },
};

export default lineItemPriceController;
