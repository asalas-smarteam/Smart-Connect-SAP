import { resolveErrorMessageText } from '#application/services/error-message.service.js';
import { buildContactEmployeeFailureNote } from '#application/services/contact-employee-failures.service.js';
import { INTEGRATION_STATUS_KEYS } from '#domain/webhooks/integration-status.constants.js';

function emptySummary() {
  return {
    processed: 0,
    completed: 0,
    retried: 0,
    errored: 0,
    skipped: 0,
    errorDetails: [],
  };
}

const POST_SAP_FAILURE_STATUS = 'sap_created_hubspot_error';

async function noopNotifyWebhookFailure() {}

async function noopPublishIntegrationStatus() {}

export class ProcessWebhookDealEventBatch {
  constructor({
    webhookEventRepository,
    processWebhookDealEvent,
    logger,
    maxRetries,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    notifyWebhookFailure = noopNotifyWebhookFailure,
    publishIntegrationStatus = noopPublishIntegrationStatus,
  }) {
    this.webhookEventRepository = webhookEventRepository;
    this.processWebhookDealEvent = processWebhookDealEvent;
    this.logger = logger;
    this.maxRetries = Math.max(1, Number(maxRetries || 1));
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.notifyWebhookFailure = notifyWebhookFailure;
    this.publishIntegrationStatus = publishIntegrationStatus;
  }

  async execute({ tenantModels, tenantId, tenantKey, portalId } = {}) {
    if (!tenantModels) {
      throw new Error('Tenant models are required to process webhook events');
    }

    const events = await this.webhookEventRepository.claimWaiting();

    if (!events?.length) {
      return emptySummary();
    }

    this.logger.info({
      msg: 'Webhook batch processing started',
      tenantId: tenantId || null,
      tenantKey: tenantKey || null,
      portalId: portalId || null,
      batchSize: events.length,
    });

    const summary = {
      ...emptySummary(),
      processed: events.length,
    };

    for (const event of events) {
      let result;

      try {
        result = await this.processWebhookDealEvent({
          event,
          tenantModels,
          tenantId,
          tenantKey,
          portalId,
        });
      } catch (error) {
        await this.safelyHandleProcessingError({
          error,
          event,
          tenantId,
          tenantKey,
          tenantModels,
          portalId,
          summary,
        });
        continue;
      }

      // markCompleted lives in its own try: SAP already created the order at
      // this point, so a bookkeeping failure here must never fall back to
      // handleProcessingError's 'waiting' path -- the cron would reprocess the
      // event and duplicate the order in SAP.
      let markedCompleted = false;

      try {
        await this.webhookEventRepository.markCompleted(event, result);
        summary.completed += 1;
        markedCompleted = true;

        this.logger.info({
          msg: 'Webhook event processed',
          tenantId: tenantId || null,
          tenantKey: tenantKey || null,
          eventId: String(event._id),
          status: 'completed',
          docEntry: result.docEntry,
          docNum: result.docNum,
        });
      } catch (bookkeepingError) {
        await this.handlePostSapBookkeepingFailure({
          error: bookkeepingError,
          event,
          result,
          tenantId,
          tenantKey,
          tenantModels,
          portalId,
          summary,
        });
      }

      // Fuera del try de arriba a propósito: si el aviso reventara dentro, caería
      // en handlePostSapBookkeepingFailure y marcaría con error un evento que ya
      // está completado. Y solo cuando markCompleted funcionó: el otro camino ya
      // deja el evento marcado con su propio error.
      if (markedCompleted) {
        await this.safelyPublishIntegrationStatus({
          event,
          status: INTEGRATION_STATUS_KEYS.COMPLETED,
          tenantModels,
          portalId,
        });

        await this.notifyContactEmployeeFailures({
          event,
          result,
          tenantId,
          tenantKey,
          tenantModels,
          portalId,
        });
      }
    }

    return summary;
  }

  // Éxito PARCIAL: el documento se creó en SAP pero SAP rechazó uno o más
  // ContactEmployees. El evento se queda `completed` a propósito -- la orden ya
  // existe y reprocesarla la duplicaría -- así que este es el único canal que le
  // avisa a quien trabaja el deal en HubSpot. Durante meses no hubo ninguno: el
  // error quedaba solo en `sapAudit.sapCalls` de Mongo.
  async notifyContactEmployeeFailures({ event, result, tenantId, tenantKey, tenantModels, portalId }) {
    const failures = Array.isArray(result?.contactEmployeeFailures)
      ? result.contactEmployeeFailures
      : [];

    if (failures.length === 0) {
      return;
    }

    this.logger.warn?.({
      msg: 'Webhook event completed with rejected ContactEmployees',
      tenantId: tenantId || null,
      tenantKey: tenantKey || null,
      eventId: String(event?._id),
      docEntry: result?.docEntry ?? null,
      docNum: result?.docNum ?? null,
      rejected: failures.length,
      emails: failures.map((failure) => failure.email),
    });

    await this.notifyWebhookFailure({
      event,
      lastError: buildContactEmployeeFailureNote({ failures, docNum: result?.docNum ?? null }),
      tenantModels,
      portalId,
      revertStage: false,
    });
  }

  // Wraps handleProcessingError so a bookkeeping failure (CastError, Mongo
  // down, etc.) can never escape the loop and abort the rest of the batch --
  // it already did once, which is the bug this fixes. Falls back to a
  // best-effort release to 'waiting' so the event isn't left stuck in
  // 'inprocess'; if even that fails, it's logged and left for manual recovery.
  async safelyHandleProcessingError({ error, event, tenantId, tenantKey, tenantModels, portalId, summary }) {
    try {
      await this.handleProcessingError({ error, event, tenantId, tenantKey, tenantModels, portalId, summary });
    } catch (bookkeepingError) {
      const currentRetries = Number(event?.retries || 0);
      const lastError = resolveErrorMessageText(error);

      this.logger.error({
        msg: 'Webhook event bookkeeping failed',
        tenantId: tenantId || null,
        tenantKey: tenantKey || null,
        eventId: String(event._id),
        error: resolveErrorMessageText(bookkeepingError),
        originalError: lastError,
      });

      try {
        await this.webhookEventRepository.markFailed(event, {
          status: 'waiting',
          retries: currentRetries,
          lastError,
        });
      } catch (releaseError) {
        this.logger.error({
          msg: 'Webhook event release after bookkeeping failure also failed',
          tenantId: tenantId || null,
          tenantKey: tenantKey || null,
          eventId: String(event._id),
          error: resolveErrorMessageText(releaseError),
        });
      }

      summary.errored += 1;
    }
  }

  // Este archivo ya tiene safelyHandleProcessingError porque un error de bookkeeping se escapó
  // del bucle y abortó el resto del batch. La publicación del estado no puede reabrir ese
  // agujero: el servicio inyectado se traga sus propios errores, pero el default del
  // constructor puede reemplazarse y un doble de test no tiene por qué respetar el contrato.
  // Acá corre siempre DESPUÉS del bookkeeping, así que lo único correcto ante un fallo es
  // dejarlo en el log y seguir con el resto del batch.
  async safelyPublishIntegrationStatus({ event, status, tenantModels, portalId }) {
    try {
      await this.publishIntegrationStatus({ event, status, tenantModels, portalId });
    } catch (error) {
      this.logger.error({
        msg: 'Failed to publish integration status',
        eventId: String(event?._id),
        status,
        error: resolveErrorMessageText(error),
      });
    }
  }

  // Sibling of the error.sapOrderCreated branch in handleProcessingError:
  // here processWebhookDealEvent already succeeded (SAP order created) and
  // only the local bookkeeping (markCompleted) failed, so the event is marked
  // terminally failed too -- never 'waiting' -- to avoid duplicating the SAP
  // order on the next cron pass. Never throws, so a repeat bookkeeping
  // failure still can't take down the batch.
  async handlePostSapBookkeepingFailure({ error, event, result, tenantId, tenantKey, tenantModels, portalId, summary }) {
    const currentRetries = Number(event?.retries || 0);
    const lastError = resolveErrorMessageText(error);

    try {
      await this.webhookEventRepository.markFailed(event, {
        status: POST_SAP_FAILURE_STATUS,
        retries: currentRetries,
        lastError,
        sapResult: result,
        sapAudit: result?.sapAudit,
      });
    } catch (bookkeepingError) {
      this.logger.error({
        msg: 'Webhook event bookkeeping failed',
        tenantId: tenantId || null,
        tenantKey: tenantKey || null,
        eventId: String(event._id),
        error: resolveErrorMessageText(bookkeepingError),
        originalError: lastError,
      });
    }

    summary.errored += 1;
    this.appendErrorDetails(summary, event, error);
    this.logger.error({
      msg: 'Webhook event failed after SAP order creation',
      tenantId: tenantId || null,
      tenantKey: tenantKey || null,
      eventId: String(event._id),
      retries: currentRetries,
      nextStatus: POST_SAP_FAILURE_STATUS,
      docEntry: result?.docEntry ?? null,
      docNum: result?.docNum ?? null,
      error: lastError,
    });

    // SAP ya tiene el documento: reenviar lo duplicaría, así que el asesor tiene que escalar.
    await this.safelyPublishIntegrationStatus({
      event,
      status: INTEGRATION_STATUS_KEYS.ERROR_SUPPORT,
      tenantModels,
      portalId,
    });
  }

  async handleProcessingError({ error, event, tenantId, tenantKey, tenantModels, portalId, summary }) {
    const currentRetries = Number(event?.retries || 0);
    const lastError = resolveErrorMessageText(error);

    if (error?.sapOrderCreated) {
      await this.webhookEventRepository.markFailed(event, {
        status: POST_SAP_FAILURE_STATUS,
        retries: currentRetries,
        lastError,
        sapResult: error.sapOrderResult,
        sapAudit: error?.sapAudit,
      });

      summary.errored += 1;
      this.appendErrorDetails(summary, event, error);
      this.logger.error({
        msg: 'Webhook event failed after SAP order creation',
        tenantId: tenantId || null,
        tenantKey: tenantKey || null,
        eventId: String(event._id),
        retries: currentRetries,
        nextStatus: POST_SAP_FAILURE_STATUS,
        docEntry: error.sapOrderResult?.docEntry ?? null,
        docNum: error.sapOrderResult?.docNum ?? null,
        error: error.message,
      });

      await this.safelyPublishIntegrationStatus({
        event,
        status: INTEGRATION_STATUS_KEYS.ERROR_SUPPORT,
        tenantModels,
        portalId,
      });
      return;
    }

    const configuredMaxRetries = Math.max(
      1,
      Number(event?.maxRetries || 0) || this.maxRetries
    );
    const isPermanent = Boolean(error?.permanent);
    const nextRetries = isPermanent ? configuredMaxRetries : currentRetries + 1;
    const shouldRetry = !isPermanent && nextRetries < configuredMaxRetries;
    const nextStatus = shouldRetry ? 'waiting' : 'errored';

    await this.webhookEventRepository.markFailed(event, {
      status: nextStatus,
      retries: nextRetries,
      lastError,
      sapAudit: error?.sapAudit,
    });

    if (shouldRetry) {
      summary.retried += 1;
    } else {
      summary.errored += 1;
      this.appendErrorDetails(summary, event, error);
      await this.notifyWebhookFailure({ event, lastError, tenantModels, portalId });
      // `errored` es el único estado reenviable: no hay documento en SAP, así que el asesor
      // corrige la data y vuelve a mandar. Este es el valor que se lo habilita.
      await this.safelyPublishIntegrationStatus({
        event,
        status: INTEGRATION_STATUS_KEYS.ERROR_RETRY,
        tenantModels,
        portalId,
      });
    }

    this.logger.error({
      msg: 'Webhook event processing failed',
      tenantId: tenantId || null,
      tenantKey: tenantKey || null,
      eventId: String(event._id),
      retries: nextRetries,
      maxRetries: configuredMaxRetries,
      nextStatus,
      error: error.message,
    });
  }

  appendErrorDetails(summary, event, error) {
    if (Array.isArray(error?.syncLogWebhookErrors) && error.syncLogWebhookErrors.length > 0) {
      summary.errorDetails.push(...error.syncLogWebhookErrors);
      return;
    }

    summary.errorDetails.push(
      this.buildWebhookSyncErrorEntry({
        payloadHubspot: event?.payload || null,
        payloadSap: null,
        responseHubspot: null,
        responseSap: this.buildErrorResponseSnapshot(error),
      })
    );
  }
}

export default ProcessWebhookDealEventBatch;
