import { buildLineItemPriceControllerDependencies } from '#composition/line-item-prices.composition.js';

function resolveStatusCode(error) {
  return /lineItems must be a non-empty array|itemCode is required|\.id is required|portalId is required|eventId is required|subscriptionId is required|appId is required|occurredAt is required|fromObjectId is required|objectId is required|safe_price_value is required to recalculate line item price/.test(
    error.message
  )
    ? 400
    : 500;
}

function createLineItemPriceController({
  tenantModelsResolver,
  webhookPayload,
  syncLogGateway,
  syncLineItemPrices,
} = {}) {
  const dependencies = buildLineItemPriceControllerDependencies({
    tenantModelsResolver,
    webhookPayload,
    syncLogGateway,
    syncLineItemPrices,
  });

  return {
    async syncPrices(req, reply) {
      let tenantModels = null;
      let executionId = null;
      let preparedPayload = null;
      let syncLogRecord = null;

      try {
        tenantModels = dependencies.tenantModelsResolver.resolve(req);
        syncLogRecord = await dependencies.syncLogGateway.start({
          tenantModels,
          objectType: 'Product',
        });

        preparedPayload = await dependencies.webhookPayload.preparePayload(req.body[0], {
          tenantModels,
          tenant: req.tenant,
          tenantKey: req.tenantKey,
        });

        if (preparedPayload.skip) {
          await dependencies.syncLogGateway.finish(syncLogRecord, {
            status: 'completed',
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

        const result = await dependencies.syncLineItemPrices.execute(preparedPayload.payload, {
          tenantModels,
          tenant: req.tenant,
          tenantKey: req.tenantKey,
        });

        if (executionId) {
          await dependencies.webhookPayload.markAsSent(
            tenantModels.LineItemPriceWebhookEvent,
            executionId
          );
        }

        const requestedCount =
          Number(result?.meta?.requestedCount) || preparedPayload?.payload?.lineItems?.length || 0;
        const updatedCount = Number(result?.meta?.updatedCount) || 0;

        await dependencies.syncLogGateway.finish(syncLogRecord, {
          status: 'completed',
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
          msg: 'Failed to sync HubSpot line item prices',
          tenantKey: req.tenantKey,
          error: error.response?.data?.message || error.message,
        });

        if (executionId) {
          await dependencies.webhookPayload.markAsError(
            tenantModels.LineItemPriceWebhookEvent,
            executionId,
            error
          );
        }

        await dependencies.syncLogGateway.finish(syncLogRecord, {
          status: 'errored',
          recordsProcessed: preparedPayload?.payload?.lineItems?.length || 0,
          sent: 0,
          failed: preparedPayload?.payload?.lineItems?.length || 1,
          errorMessage: error.syncLogWebhookErrors || [
            dependencies.syncLogGateway.buildWebhookSyncErrorEntry({
              payloadHubspot: preparedPayload?.payload || req.body?.[0] || req.body,
              payloadSap: null,
              responseHubspot: null,
              responseSap: dependencies.syncLogGateway.buildErrorResponseSnapshot(error),
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

}

const lineItemPriceController = createLineItemPriceController();

export { createLineItemPriceController };

export default lineItemPriceController;
