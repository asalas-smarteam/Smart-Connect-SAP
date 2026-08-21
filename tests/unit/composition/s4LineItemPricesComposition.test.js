import {
  buildS4LineItemPriceControllerDependencies,
  buildSyncS4LineItemPrices,
} from '../../../src/composition/s4-line-item-prices.composition.js';
import { S4PriceListClient } from '../../../src/infrastructure/sap/S4PriceListClient.js';
import SyncS4LineItemPricesByPriceList from '../../../src/application/use-cases/SyncS4LineItemPricesByPriceList.js';
import { S4PriceListLineItemPriceWebhookService } from '../../../src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js';
import lineItemPriceWebhookPayloadAdapter from '../../../src/infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js';
import { buildLineItemPriceControllerDependencies } from '../../../src/composition/line-item-prices.composition.js';

describe('s4-line-item-prices.composition', () => {
  it('cablea las dependencias reales del caso de uso, no objetos vacíos', () => {
    const useCase = buildSyncS4LineItemPrices();

    // El repositorio tiene que ser el que sabe leer la config s4PriceList.
    expect(typeof useCase.credentialRepository.resolveS4PriceListConfig).toBe('function');
    expect(typeof useCase.credentialRepository.resolveHubspotCredentials).toBe('function');
    expect(typeof useCase.credentialRepository.resolveSapCredentials).toBe('function');
    // El audit DEBE pasar por buildLineItemPriceAudit: es quien sanea las claves `$` del
    // tráfico OData antes del $set sobre el WebhookEvent.
    expect(typeof useCase.buildLineItemPriceAudit).toBe('function');
    expect(typeof useCase.createSapCallRecorder).toBe('function');
    expect(typeof useCase.hubspotPriceClient.updateLineItems).toBe('function');
    expect(typeof useCase.hubspotPriceClient.updateDealAmount).toBe('function');
    // Si estos dos quedan sin cablear, un fallo del webhook pierde el detalle con el que se
    // diagnostica: buildErrorResponseSnapshot arma el snapshot del error de SAP/HubSpot y
    // buildWebhookSyncErrorEntry arma la entrada que el SyncLog guarda como `errorMessage`.
    expect(typeof useCase.buildErrorResponseSnapshot).toBe('function');
    expect(typeof useCase.buildWebhookSyncErrorEntry).toBe('function');
    // `dateProvider` decide la fecha con la que se filtra la vigencia de las condiciones en SAP.
    // El constructor ya NO tiene default para él justamente para que esta aserción tenga dientes:
    // si la composición deja de cablearlo, buildSyncS4LineItemPrices lanza y este test se cae.
    expect(typeof useCase.dateProvider).toBe('function');
    expect(useCase.dateProvider()).toBeInstanceOf(Date);
  });

  // M4 de la revisión final: la suite sólo ejercía buildSyncS4LineItemPrices, así que el cableado
  // de la RUTA no estaba probado. Es el patrón que ya falló tres veces en este repo: una pieza
  // sin cablear (o cableada con la de B1) no rompe ningún test.
  describe('buildS4LineItemPriceControllerDependencies', () => {
    it('devuelve las cuatro dependencias del controlador', () => {
      const dependencies = buildS4LineItemPriceControllerDependencies();

      expect(Object.keys(dependencies).sort()).toEqual([
        'syncLineItemPrices',
        'syncLogGateway',
        'tenantModelsResolver',
        'webhookPayload',
      ]);
      expect(dependencies.tenantModelsResolver).toBeTruthy();
      expect(dependencies.syncLogGateway).toBeTruthy();
    });

    it('webhookPayload y syncLineItemPrices son las piezas de S/4, NO las de B1', () => {
      const dependencies = buildS4LineItemPriceControllerDependencies();
      const b1Dependencies = buildLineItemPriceControllerDependencies();

      expect(dependencies.webhookPayload).toBeInstanceOf(S4PriceListLineItemPriceWebhookService);
      expect(dependencies.syncLineItemPrices).toBeInstanceOf(SyncS4LineItemPricesByPriceList);
      // El adaptador de payload de B1 es otro objeto y otra clase: si alguien intercambia los
      // defaults, la ruta de S/4 se lleva el flujo de Business One sin que nada falle.
      expect(dependencies.webhookPayload).not.toBe(lineItemPriceWebhookPayloadAdapter);
      expect(dependencies.webhookPayload).not.toBe(b1Dependencies.webhookPayload);
      expect(dependencies.syncLineItemPrices).not.toBe(b1Dependencies.syncLineItemPrices);
      expect(dependencies.syncLineItemPrices.constructor.name)
        .toBe('SyncS4LineItemPricesByPriceList');
      // Y la pieza de S/4 tiene que traer el cliente de precios de S/4 cableado.
      expect(typeof dependencies.syncLineItemPrices.createPriceListClient).toBe('function');
    });

    it('respeta las dependencias inyectadas (construcción diferida del caso de uso)', () => {
      const syncLineItemPrices = { execute: () => null };
      const webhookPayload = { preparePayload: () => null };

      const dependencies = buildS4LineItemPriceControllerDependencies({
        syncLineItemPrices,
        webhookPayload,
      });

      expect(dependencies.syncLineItemPrices).toBe(syncLineItemPrices);
      expect(dependencies.webhookPayload).toBe(webhookPayload);
    });
  });

  it('la factory del cliente construye un S4PriceListClient con transporte S4', () => {
    const useCase = buildSyncS4LineItemPrices();

    const client = useCase.createPriceListClient({
      sapConfig: { serviceLayerBaseUrl: 'https://vhmldqs4ci.hec.multidomsa.com:44300' },
    });

    expect(client).toBeInstanceOf(S4PriceListClient);
    expect(typeof client.transport.fetchAll).toBe('function');
  });

  // Estas dos aserciones cubren caminos distintos y NO son intercambiables:
  //
  // 1. `params` (serializeAuditParams, syncLog.service.js) nunca llega a sanitizeAuditKeys:
  //    se APLANA a un string "clave=valor&clave=valor" antes de guardarse, así que un
  //    `$filter` termina como texto dentro de un valor, nunca como clave de objeto. La
  //    garantía real para Mongo < 5.0 no es "se renombra a _$filter" (eso no pasa), es "no
  //    queda ninguna clave `$` en todo el árbol que se escribe con $set" — por eso se
  //    recorre el audit completo buscando claves, no un string fijo.
  // 2. `request` y el `response` embebido en `error` (buildErrorResponseSnapshot) SÍ pasan
  //    por sanitizeAuditKeys tal cual, así que ahí el mecanismo es el renombrado `$x` ->
  //    `_$x`. Si alguien "simplifica" esto a una sola aserción, deja de probar el aplanado
  //    o deja de probar el renombrado.
  it('ninguna clave del audit serializado empieza con $, aunque params llegue con $filter/$select', () => {
    const useCase = buildSyncS4LineItemPrices();

    const audit = useCase.buildLineItemPriceAudit({
      dealId: '77',
      // Shape real que produce S4PriceListClient al leer condition records.
      calls: [{
        target: 'sap',
        method: 'GET',
        path: '/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord',
        params: { $filter: "Material eq '1'", $select: 'ConditionRecord' },
      }],
    });

    function collectKeys(value, keys = []) {
      if (Array.isArray(value)) {
        value.forEach((item) => collectKeys(item, keys));
      } else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          keys.push(key);
          collectKeys(nested, keys);
        }
      }
      return keys;
    }

    const keys = collectKeys(audit);
    expect(keys.some((key) => key.startsWith('$'))).toBe(false);
  });

  it('el saneador sí actúa donde corresponde: request y response de una llamada fallida', () => {
    const useCase = buildSyncS4LineItemPrices();

    const error = Object.assign(new Error('SAP rejected the condition record write'), {
      response: { status: 400, data: { $inner: 'condition rejected' } },
    });

    const audit = useCase.buildLineItemPriceAudit({
      dealId: '77',
      calls: [{
        target: 'sap',
        method: 'POST',
        path: '/x',
        ok: false,
        request: { $body: 'raw odata payload' },
        error,
      }],
    });

    const [call] = audit.calls;
    expect(call.request).toEqual({ _$body: 'raw odata payload' });
    expect(call.error.response).toEqual({ _$inner: 'condition rejected' });
  });
});
