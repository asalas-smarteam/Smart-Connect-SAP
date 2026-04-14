import lineItemPriceService from "../services/lineItemPrice.service.js";
import lineItemPriceWebhookService from "../services/lineItemPriceWebhook.service.js";
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
  finishSyncLog,
  startSyncLog,
} from "../services/syncLog.service.js";
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
    let preparedPayload = null;
    let syncLog = null;

    try {

      tenantModels = requireTenantModels(req);
      syncLog = await startSyncLog({ tenantModels });

      preparedPayload = await lineItemPriceWebhookService.preparePayload(
        req.body[0],
        {
          tenantModels,
          tenant: req.tenant,
        },
      );

      if (preparedPayload.skip) {
        await finishSyncLog(syncLog, {
          status: "completed",
          recordsProcessed: 0,
          sent: 0,
          failed: 0,
        });

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

      const requestedCount = Number(result?.meta?.requestedCount)
        || preparedPayload?.payload?.lineItems?.length
        || 0;
      const updatedCount = Number(result?.meta?.updatedCount) || 0;

      await finishSyncLog(syncLog, {
        status: "completed",
        recordsProcessed: requestedCount,
        sent: updatedCount,
        failed: Math.max(requestedCount - updatedCount, 0),
      });

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

      await finishSyncLog(syncLog, {
        status: "errored",
        recordsProcessed: preparedPayload?.payload?.lineItems?.length || 0,
        sent: 0,
        failed: preparedPayload?.payload?.lineItems?.length || 1,
        errorMessage: error.syncLogWebhookErrors || [
          buildWebhookSyncErrorEntry({
            payloadHubspot: preparedPayload?.payload || req.body?.[0] || req.body,
            payloadSap: null,
            responseHubspot: null,
            responseSap: buildErrorResponseSnapshot(error),
          }),
        ],
      });

      return reply.code(resolveStatusCode(error)).send({
        ok: false,
        message: error.message,
      });
    }
  },
};

export default lineItemPriceController;
