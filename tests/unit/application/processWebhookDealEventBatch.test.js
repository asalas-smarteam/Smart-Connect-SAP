import { jest } from '@jest/globals';
import ProcessWebhookDealEventBatch from '../../../src/application/use-cases/ProcessWebhookDealEventBatch.js';

describe('ProcessWebhookDealEventBatch', () => {
  it('marks claimed events as completed after processing', async () => {
    const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const processWebhookDealEvent = jest.fn().mockResolvedValue({
      cardCode: 'C20000',
      docEntry: 10,
      docNum: 20,
    });
    const logger = { info: jest.fn(), error: jest.fn() };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent,
      logger,
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({
      tenantModels: { WebhookEvent: {} },
      tenantId: 'tenant-id',
      tenantKey: 'tenant-key',
      portalId: 'portal-id',
    });

    expect(processWebhookDealEvent).toHaveBeenCalledWith({
      event,
      tenantModels: { WebhookEvent: {} },
      tenantId: 'tenant-id',
      tenantKey: 'tenant-key',
      portalId: 'portal-id',
    });
    expect(repository.markCompleted).toHaveBeenCalledWith(event, {
      cardCode: 'C20000',
      docEntry: 10,
      docNum: 20,
    });
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(summary).toEqual({
      processed: 1,
      completed: 1,
      retried: 0,
      errored: 0,
      skipped: 0,
      errorDetails: [],
    });
  });

  it('moves transient failures back to waiting while retries remain', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const processWebhookDealEvent = jest.fn().mockRejectedValue(new Error('SAP timeout'));

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent,
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const notifyWebhookFailure = jest.fn();
    useCase.notifyWebhookFailure = notifyWebhookFailure;

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'waiting',
      retries: 1,
      lastError: 'SAP timeout',
    });
    expect(summary.retried).toBe(1);
    expect(summary.errored).toBe(0);
    expect(notifyWebhookFailure).not.toHaveBeenCalled();
  });

  it('marks permanent failures as errored and records sync log details', async () => {
    const event = { _id: 'event-1', retries: 0, payload: { deal: {} } };
    const error = new Error('ItemCode is required');
    error.permanent = true;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const buildWebhookSyncErrorEntry = jest.fn((entry) => ({
      payloadHubspot: entry.payloadHubspot,
      responseSap: entry.responseSap,
    }));
    const buildErrorResponseSnapshot = jest.fn(() => ({ message: error.message }));

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry,
      buildErrorResponseSnapshot,
    });

    const notifyWebhookFailure = jest.fn();
    useCase.notifyWebhookFailure = notifyWebhookFailure;

    const summary = await useCase.execute({
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'errored',
      retries: 3,
      lastError: 'ItemCode is required',
    });
    expect(summary.errored).toBe(1);
    expect(summary.errorDetails).toEqual([
      {
        payloadHubspot: event.payload,
        responseSap: { message: 'ItemCode is required' },
      },
    ]);
    expect(notifyWebhookFailure).toHaveBeenCalledWith({
      event,
      lastError: 'ItemCode is required',
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });
  });

  it('notifies webhook failure once retries are exhausted (not permanent)', async () => {
    const event = { _id: 'event-1', retries: 2, maxRetries: 3, payload: { deal: { hs_object_id: 'deal-9' } } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const notifyWebhookFailure = jest.fn();

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(new Error('SAP timeout')),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: 'SAP timeout' })),
      notifyWebhookFailure,
    });

    const summary = await useCase.execute({
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'errored',
      retries: 3,
      lastError: 'SAP timeout',
    });
    expect(summary.errored).toBe(1);
    expect(notifyWebhookFailure).toHaveBeenCalledWith({
      event,
      lastError: 'SAP timeout',
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });
  });

  it('does not retry when SAP order was already created before a later failure', async () => {
    const event = { _id: 'event-1', retries: 1, maxRetries: 3, payload: { deal: {} } };
    const error = new Error('HubSpot update failed');
    error.sapOrderCreated = true;
    error.sapOrderResult = {
      cardCode: 'C20000',
      docEntry: 10,
      docNum: 20,
    };
    error.sapOrderPayload = {
      CardCode: 'C20000',
      DocumentLines: [{ ItemCode: 'A0001', Quantity: 1 }],
    };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const notifyWebhookFailure = jest.fn();

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: error.message })),
      notifyWebhookFailure,
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'sap_created_hubspot_error',
      retries: 1,
      lastError: 'HubSpot update failed',
      sapResult: {
        cardCode: 'C20000',
        docEntry: 10,
        docNum: 20,
      },
    });
    expect(repository.markCompleted).not.toHaveBeenCalled();
    expect(summary.retried).toBe(0);
    expect(summary.errored).toBe(1);
    expect(notifyWebhookFailure).not.toHaveBeenCalled();
  });

  it('normalizes a nested SAP B1 error message to a string before marking the event failed', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const error = {
      response: {
        data: {
          error: {
            message: {
              lang: 'en-us',
              value: 'To generate this document, first define the numbering series',
            },
          },
        },
      },
    };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'waiting',
      retries: 1,
      lastError: 'To generate this document, first define the numbering series',
    });
    const [, failure] = repository.markFailed.mock.calls[0];
    expect(typeof failure.lastError).toBe('string');
    expect(summary.retried).toBe(1);
  });

  it('isolates a bookkeeping failure on one event so the rest of the batch still processes', async () => {
    const events = [
      { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } },
      { _id: 'event-2', retries: 0, maxRetries: 3, payload: { deal: {} } },
      { _id: 'event-3', retries: 0, maxRetries: 3, payload: { deal: {} } },
    ];
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue(events),
      markCompleted: jest.fn(),
      markFailed: jest
        .fn()
        .mockRejectedValueOnce(new Error('Cast to string failed'))
        .mockResolvedValue(undefined),
    };
    const processWebhookDealEvent = jest.fn().mockRejectedValue(new Error('SAP timeout'));

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent,
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(processWebhookDealEvent).toHaveBeenCalledTimes(3);
    expect(summary.errored).toBe(1);
    expect(summary.retried).toBe(2);
  });

  it('never leaves an event hanging even when every bookkeeping write fails', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn().mockRejectedValue(new Error('Mongo is down')),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(new Error('SAP timeout')),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledTimes(2);
    expect(summary.errored).toBe(1);
  });

  it('marks the event terminally failed (not waiting) when SAP already created the order but bookkeeping fails', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const result = { cardCode: 'C20000', docEntry: 10, docNum: 20 };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn().mockRejectedValue(new Error('Mongo write failed')),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockResolvedValue(result),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: 'Mongo write failed' })),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ status: 'sap_created_hubspot_error' })
    );
    expect(repository.markFailed.mock.calls[0][1].status).not.toBe('waiting');
    expect(summary.errored).toBe(1);
    expect(summary.completed).toBe(0);
  });

  it('forwards error.sapAudit to markFailed on a normal transient failure', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { quotation: { CardCode: 'CL001' } } };
    const error = new Error('SAP timeout');
    error.sapAudit = sapAudit;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });

  it('forwards error.sapAudit to markFailed when SAP already created the order', async () => {
    const event = { _id: 'event-1', retries: 1, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } } };
    const error = new Error('HubSpot update failed');
    error.sapOrderCreated = true;
    error.sapOrderResult = { cardCode: 'C20000', docEntry: 10, docNum: 20 };
    error.sapAudit = sapAudit;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: error.message })),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });

  it('forwards result.sapAudit to markFailed when SAP succeeded but bookkeeping fails afterward', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } } };
    const result = { cardCode: 'C20000', docEntry: 10, docNum: 20, sapAudit };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn().mockRejectedValue(new Error('Mongo write failed')),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockResolvedValue(result),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: 'Mongo write failed' })),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });

  // Un documento creado con ContactEmployees rechazados por SAP es un exito PARCIAL: el
  // evento queda `completed` (la orden existe, reprocesarlo la duplicaria) pero el usuario
  // de HubSpot tiene que enterarse. Antes no se enteraba por ningun canal.
  describe('fallos parciales de ContactEmployee', () => {
    const FAILURES = [
      {
        email: 'linda.colop@fundap.com.gt',
        name: 'LINDA MARIBEL COLOP',
        message: "Value too long in property 'Title' of 'ContactEmployee'",
      },
    ];

    function buildUseCase({ result, markCompleted = jest.fn() }) {
      const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };
      const repository = {
        claimWaiting: jest.fn().mockResolvedValue([event]),
        markCompleted,
        markFailed: jest.fn(),
      };
      const notifyWebhookFailure = jest.fn();
      const useCase = new ProcessWebhookDealEventBatch({
        webhookEventRepository: repository,
        processWebhookDealEvent: jest.fn().mockResolvedValue(result),
        logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
        maxRetries: 3,
        buildWebhookSyncErrorEntry: jest.fn(),
        buildErrorResponseSnapshot: jest.fn(),
        notifyWebhookFailure,
      });
      return { useCase, repository, notifyWebhookFailure, event };
    }

    it('deja nota en el deal sin devolver la etapa, y el evento sigue completed', async () => {
      const { useCase, repository, notifyWebhookFailure, event } = buildUseCase({
        result: { docEntry: 126905, docNum: 1074112, contactEmployeeFailures: FAILURES },
      });

      const summary = await useCase.execute({
        tenantModels: { WebhookEvent: {} },
        portalId: 'portal-id',
      });

      expect(summary.completed).toBe(1);
      expect(summary.errored).toBe(0);
      expect(repository.markFailed).not.toHaveBeenCalled();

      expect(notifyWebhookFailure).toHaveBeenCalledTimes(1);
      const [args] = notifyWebhookFailure.mock.calls[0];
      expect(args.event).toBe(event);
      expect(args.portalId).toBe('portal-id');
      // El documento YA existe en SAP: devolver el deal a una etapa anterior seria mentir
      // sobre su estado, asi que este aviso nunca mueve la etapa.
      expect(args.revertStage).toBe(false);
      expect(args.lastError).toContain('1074112');
      expect(args.lastError).toContain('linda.colop@fundap.com.gt');
      expect(args.lastError).toContain("Value too long in property 'Title'");
    });

    it('no avisa cuando no hubo fallos parciales', async () => {
      const { useCase, notifyWebhookFailure } = buildUseCase({
        result: { docEntry: 1, docNum: 2, contactEmployeeFailures: [] },
      });

      await useCase.execute({ tenantModels: { WebhookEvent: {} } });

      expect(notifyWebhookFailure).not.toHaveBeenCalled();
    });

    it('no avisa cuando el resultado no trae contactEmployeeFailures', async () => {
      const { useCase, notifyWebhookFailure } = buildUseCase({
        result: { docEntry: 1, docNum: 2 },
      });

      await useCase.execute({ tenantModels: { WebhookEvent: {} } });

      expect(notifyWebhookFailure).not.toHaveBeenCalled();
    });

    // Si markCompleted falla el evento se marca `sap_created_hubspot_error` y ese camino
    // tiene su propio manejo; avisar del fallo parcial ademas seria ruido sobre un evento
    // que ya quedo marcado con error.
    it('no avisa del fallo parcial cuando el markCompleted falla', async () => {
      const { useCase, notifyWebhookFailure } = buildUseCase({
        result: { docEntry: 1, docNum: 2, contactEmployeeFailures: FAILURES },
        markCompleted: jest.fn().mockRejectedValue(new Error('Mongo down')),
      });

      const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

      expect(summary.errored).toBe(1);
      expect(notifyWebhookFailure).not.toHaveBeenCalled();
    });
  });

  describe('publicación del estado de integración', () => {
    const tenantModels = { WebhookEvent: {} };

    function buildUseCase({ event, processWebhookDealEvent, markCompleted, publishIntegrationStatus }) {
      const repository = {
        claimWaiting: jest.fn().mockResolvedValue([event]),
        markCompleted: markCompleted || jest.fn(),
        markFailed: jest.fn(),
      };
      const useCase = new ProcessWebhookDealEventBatch({
        webhookEventRepository: repository,
        processWebhookDealEvent,
        logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
        maxRetries: 3,
        buildWebhookSyncErrorEntry: jest.fn(),
        buildErrorResponseSnapshot: jest.fn(),
        notifyWebhookFailure: jest.fn(),
        publishIntegrationStatus,
      });

      return { useCase, repository };
    }

    it('publica completed cuando el evento se marca completado', async () => {
      const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };
      const publishIntegrationStatus = jest.fn().mockResolvedValue(undefined);
      const { useCase } = buildUseCase({
        event,
        processWebhookDealEvent: jest.fn().mockResolvedValue({
          cardCode: 'C20000',
          docEntry: 10,
          docNum: 20,
        }),
        publishIntegrationStatus,
      });

      await useCase.execute({ tenantModels, portalId: 'portal-id' });

      expect(publishIntegrationStatus).toHaveBeenCalledWith({
        event,
        status: 'completed',
        tenantModels,
        portalId: 'portal-id',
      });
    });

    // retries: 2 con maxRetries: 3 deja nextRetries en 3, que ya no es menor al máximo: el
    // evento va a `errored`, el único estado que habilita el reenvío.
    it('publica errorRetry cuando el evento agota los retries', async () => {
      const event = { _id: 'event-1', retries: 2, maxRetries: 3, payload: { deal: {} } };
      const publishIntegrationStatus = jest.fn().mockResolvedValue(undefined);
      const { useCase, repository } = buildUseCase({
        event,
        processWebhookDealEvent: jest.fn().mockRejectedValue(new Error('SAP timeout')),
        publishIntegrationStatus,
      });

      await useCase.execute({ tenantModels, portalId: 'portal-id' });

      expect(repository.markFailed).toHaveBeenCalledWith(
        event,
        expect.objectContaining({ status: 'errored' })
      );
      expect(publishIntegrationStatus).toHaveBeenCalledWith({
        event,
        status: 'errorRetry',
        tenantModels,
        portalId: 'portal-id',
      });
    });

    it('no publica nada cuando al evento le quedan retries', async () => {
      const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
      const publishIntegrationStatus = jest.fn().mockResolvedValue(undefined);
      const { useCase } = buildUseCase({
        event,
        processWebhookDealEvent: jest.fn().mockRejectedValue(new Error('SAP timeout')),
        publishIntegrationStatus,
      });

      await useCase.execute({ tenantModels, portalId: 'portal-id' });

      expect(publishIntegrationStatus).not.toHaveBeenCalled();
    });

    it('publica errorSupport cuando SAP ya había creado el documento', async () => {
      const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
      const publishIntegrationStatus = jest.fn().mockResolvedValue(undefined);
      const { useCase } = buildUseCase({
        event,
        processWebhookDealEvent: jest.fn().mockRejectedValue(
          Object.assign(new Error('HubSpot down'), {
            sapOrderCreated: true,
            sapOrderResult: { docEntry: 10, docNum: 20 },
          })
        ),
        publishIntegrationStatus,
      });

      await useCase.execute({ tenantModels, portalId: 'portal-id' });

      expect(publishIntegrationStatus).toHaveBeenCalledWith({
        event,
        status: 'errorSupport',
        tenantModels,
        portalId: 'portal-id',
      });
    });

    it('publica errorSupport cuando el bookkeeping falla después de crear en SAP', async () => {
      const event = { _id: 'event-1', payload: { deal: {} } };
      const publishIntegrationStatus = jest.fn().mockResolvedValue(undefined);
      const { useCase } = buildUseCase({
        event,
        processWebhookDealEvent: jest.fn().mockResolvedValue({ docEntry: 10, docNum: 20 }),
        markCompleted: jest.fn().mockRejectedValue(new Error('Mongo down')),
        publishIntegrationStatus,
      });

      await useCase.execute({ tenantModels, portalId: 'portal-id' });

      expect(publishIntegrationStatus).toHaveBeenCalledWith({
        event,
        status: 'errorSupport',
        tenantModels,
        portalId: 'portal-id',
      });
      // markCompleted falló, así que el evento NO está completado: no puede publicarse también
      // `completed` o la propiedad mentiría sobre el estado del documento.
      expect(publishIntegrationStatus).toHaveBeenCalledTimes(1);
    });

    // Este archivo ya tiene safelyHandleProcessingError porque un error de bookkeeping se
    // escapó del bucle y abortó el resto del batch. El publicador no puede reabrir ese agujero:
    // aunque el servicio se trague sus propios errores, acá va el segundo cinturón.
    it('un fallo del publicador no aborta el batch ni cambia el resumen', async () => {
      const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };
      const { useCase } = buildUseCase({
        event,
        processWebhookDealEvent: jest.fn().mockResolvedValue({ docEntry: 10, docNum: 20 }),
        publishIntegrationStatus: jest.fn().mockRejectedValue(new Error('HubSpot 500')),
      });

      const summary = await useCase.execute({ tenantModels, portalId: 'portal-id' });

      expect(summary).toMatchObject({ processed: 1, completed: 1, errored: 0 });
    });
  });
});
