import lineItemPriceController, { createLineItemPriceController } from '../controllers/lineItemPrice.controller.js';
import { buildS4LineItemPriceControllerDependencies } from '#composition/s4-line-item-prices.composition.js';
import { tenantResolver } from '../middlewares/tenantResolver.js';

export default async function routes(app) {
  app.post(
    '/webhooks/hubspot/line-items/prices',
    { preHandler: tenantResolver },
    lineItemPriceController.syncPrices
  );

  // Webhook de precios para tenants S/4. Reusa el controlador de B1 (dedupe, syncLog y audit
  // idénticos) inyectándole el payload adapter y el caso de uso de S/4.
  //
  // Construcción diferida a propósito: si se armara en el scope del módulo, un error futuro en
  // cualquier constructor de la cadena de S/4 haría fallar el `import` del archivo completo y
  // se llevaría puesta la ruta de B1 de arriba. Armándolo aquí, un fallo de construcción de S/4
  // sólo rompe el registro de la ruta de S/4.
  const s4LineItemPriceController = createLineItemPriceController(
    buildS4LineItemPriceControllerDependencies()
  );

  app.post(
    '/webhooks/hubspot/line-items/prices/s4',
    { preHandler: tenantResolver },
    s4LineItemPriceController.syncPrices
  );
}
