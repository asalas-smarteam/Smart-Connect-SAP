import SyncLineItemPrices from '../../../application/use-cases/SyncLineItemPrices.js';
import HubspotLineItemPriceClient from '../../../infrastructure/external-services/HubspotLineItemPriceClient.js';
import SapLineItemPriceClient from '../../../infrastructure/external-services/SapLineItemPriceClient.js';
import TenantLineItemPriceConfigRepository from '../../../infrastructure/repositories/TenantLineItemPriceConfigRepository.js';
import syncLogAdapter from '../../../infrastructure/sync/SyncLogAdapter.js';
import requestTenantModelsAdapter from '../../../infrastructure/tenants/RequestTenantModelsAdapter.js';
import lineItemPriceWebhookPayloadAdapter from '../../../infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js';

function resolveStatusCode(error) {
  return /lineItems must be a non-empty array|itemCode is required|\.id is required|portalId is required|eventId is required|subscriptionId is required|appId is required|occurredAt is required|fromObjectId is required/.test(
    error.message
  )
    ? 400
    : 500;
}

function buildSyncLineItemPrices(syncLog) {
  return new SyncLineItemPrices({
    credentialRepository: new TenantLineItemPriceConfigRepository(),
    sapPriceClient: new SapLineItemPriceClient(),
    hubspotPriceClient: new HubspotLineItemPriceClient(),
    buildErrorResponseSnapshot: (error) => syncLog.buildErrorResponseSnapshot(error),
    buildWebhookSyncErrorEntry: (entry) => syncLog.buildWebhookSyncErrorEntry(entry),
  });
}

function createLineItemPriceController({
  tenantModelsResolver = requestTenantModelsAdapter,
  webhookPayload = lineItemPriceWebhookPayloadAdapter,
  syncLogGateway = syncLogAdapter,
  syncLineItemPrices = buildSyncLineItemPrices(syncLogGateway),
} = {}) {
  return {
    async syncPrices(req, reply) {
      let tenantModels = null;
      let executionId = null;
      let preparedPayload = null;
      let syncLogRecord = null;

      try {
        tenantModels = tenantModelsResolver.resolve(req);
        syncLogRecord = await syncLogGateway.start({ tenantModels });

        preparedPayload = await webhookPayload.preparePayload(req.body[0], {
          tenantModels,
          tenant: req.tenant,
        });

        if (preparedPayload.skip) {
          await syncLogGateway.finish(syncLogRecord, {
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

        const result = await syncLineItemPrices.execute(preparedPayload.payload, {
          tenantModels,
          tenant: req.tenant,
          tenantKey: req.tenantKey,
        });

        if (executionId) {
          await webhookPayload.markAsSent(
            tenantModels.LineItemPriceWebhookEvent,
            executionId
          );
        }

        const requestedCount =
          Number(result?.meta?.requestedCount) || preparedPayload?.payload?.lineItems?.length || 0;
        const updatedCount = Number(result?.meta?.updatedCount) || 0;

        await syncLogGateway.finish(syncLogRecord, {
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
          error: error.message,
        });

        if (executionId) {
          await webhookPayload.markAsError(
            tenantModels.LineItemPriceWebhookEvent,
            executionId,
            error
          );
        }

        await syncLogGateway.finish(syncLogRecord, {
          status: 'errored',
          recordsProcessed: preparedPayload?.payload?.lineItems?.length || 0,
          sent: 0,
          failed: preparedPayload?.payload?.lineItems?.length || 1,
          errorMessage: error.syncLogWebhookErrors || [
            syncLogGateway.buildWebhookSyncErrorEntry({
              payloadHubspot: preparedPayload?.payload || req.body?.[0] || req.body,
              payloadSap: null,
              responseHubspot: null,
              responseSap: syncLogGateway.buildErrorResponseSnapshot(error),
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
