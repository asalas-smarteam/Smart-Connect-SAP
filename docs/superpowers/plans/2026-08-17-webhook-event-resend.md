# Reenvío de webhooks de HubSpot tras un fallo definitivo — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que un tenant corrija la data en HubSpot y reenvíe el mismo documento a SAP cuando el `WebhookEvent` quedó en `errored`, sin abrir ninguna puerta a duplicar documentos en SAP.

**Architecture:** El dedup de aplicación pasa de "existe un evento para este deal" a "existe un evento **no-`errored`** para este deal", así que un reenvío legítimo inserta un evento nuevo y el viejo queda como log. Esa relajación se compensa con una garantía dura nueva: un campo `dedupActive` y un índice único parcial que permite a lo sumo un evento no-`errored` por `(eventType, dealId)`, para los cuatro tipos deduplicados y no solo para `createDeal`. Del lado de HubSpot, el integrador escribe un estado terminal en una propiedad del deal que el asesor mueve a `Reintentar` para disparar un workflow de reintento.

**Tech Stack:** Node.js ESM, Fastify, Mongoose (multi-tenant: una base por tenant), BullMQ, Jest con `--experimental-vm-modules`, `mongodb-memory-server` para integración, scripts `.mjs` con el driver `mongodb` para migraciones.

**Spec:** [docs/superpowers/specs/2026-08-17-webhook-event-resend-design.md](../specs/2026-08-17-webhook-event-resend-design.md)

## Global Constraints

- **El único estado reenviable es `errored`.** Cualquier otro (`waiting`, `inprocess`, `sap_order_created`, `completed`, `sap_created_hubspot_error`, `report`) bloquea. La condición se escribe siempre por exclusión (`status: { $ne: 'errored' }`), nunca como lista blanca: si mañana se agrega un estado al enum y se olvida este archivo, el default tiene que ser bloquear.
- **`updateQuotation` queda fuera del dedup.** No está hoy en `DEDUPLICATED_EVENT_TYPES` y no se agrega. Nunca se le escribe `dedupActive`. Aplicarle la regla nueva bloquearía la segunda actualización de una cotización que ya sincronizó bien, que es comportamiento válido de producción.
- **La lista de tipos vive solo en `DEDUPLICATED_EVENT_TYPES`** (`src/infrastructure/webhook/webhookEvent.service.js`). Todo consumidor la importa; no se duplica en ningún otro archivo.
- **El webhook de precios de line items no participa.** Escribe en `LineItemPriceWebhookEvents`, otra colección, otro modelo. No hace falta excluirlo.
- **Los efectos de lado hacia HubSpot nunca tiran hacia arriba.** Corren después del bookkeeping (`markFailed` / `markCompleted`); un error de HubSpot ahí no puede desandar lo que ya se guardó. Mismo contrato que `notifyWebhookFailure`.
- **La configuración falla apagado.** Sin nombre de propiedad o sin los tres valores, la publicación de estado queda desactivada y el comportamiento es idéntico al de hoy.
- **La rama de omisión no lleva código nuevo.** Un reenvío bloqueado devuelve el mismo 200 de hoy, sin nota, sin escribir la propiedad y sin campos nuevos en la respuesta.
- **Los tests se corren desde la raíz del repo con `npm test`** (`NODE_OPTIONS=--experimental-vm-modules jest`). Si hay worktrees en `.claude/worktrees/`, correr jest desde la raíz levanta también sus suites e infla el total; para verificar una suite puntual usar siempre la ruta explícita del archivo.

---

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/domain/webhooks/integration-status.constants.js` | Las tres llaves de estado terminal, como constantes de dominio. Evita que la capa de aplicación importe infraestructura solo para nombrar un estado. | Crear |
| `src/infrastructure/database/models/tenant/WebhookEvent.js` | Campo `dedupActive` + índice único parcial nuevo; se quita la declaración del índice viejo. | Modificar |
| `src/infrastructure/webhook/webhookEvent.service.js` | Regla de dedup por estado; escribe `dedupActive` al insertar; exporta `DEDUPLICATED_EVENT_TYPES`. | Modificar |
| `src/infrastructure/repositories/MongooseWebhookEventRepository.js` | `markFailed` mantiene `dedupActive` derivándolo del status. | Modificar |
| `src/infrastructure/config/webhookFailureNotification.config.js` | Lee el nombre de la propiedad de estado y sus tres valores del mismo documento `Configuration` que `requireMessageHS`. | Modificar |
| `src/infrastructure/hubspot/dealIntegrationStatus.service.js` | Escribe el estado terminal en la propiedad del deal. Hermano de `webhookFailureNotifier.service.js`. | Crear |
| `src/application/use-cases/ProcessWebhookDealEventBatch.js` | Invoca al publicador en sus tres puntos terminales. | Modificar |
| `src/composition/webhook-processing.composition.js` | Cablea el publicador en `buildProcessWebhookDealEventBatch`. | Modificar |
| `src/infrastructure/hubspot/tenantHubspotSeed.service.js` | Crea la propiedad `sap_integration_status` en el portal del tenant. | Modificar |
| `scripts/migrate-webhook-event-dedup-active.mjs` | Migración por tenant: verificar colisiones, backfill, crear índice nuevo, tumbar el viejo. | Crear |

---

## Task 1: Campo `dedupActive` e índice único nuevo en el modelo

Va primero por una razón mecánica: Mongoose en modo estricto **descarta** los campos que no están en el schema. Si `queueWebhookEvent` escribiera `dedupActive` antes de que el campo exista en el schema, el valor desaparecería en silencio y todos los tests con mocks pasarían igual.

**Files:**
- Modify: `src/infrastructure/database/models/tenant/WebhookEvent.js:36-77`
- Test: `tests/integration/webhookEventDedupIndex.test.js` (crear)

**Interfaces:**
- Consumes: nada.
- Produces: el campo `dedupActive` (Boolean, sin default) en `webhookEventSchema`, y el índice único parcial `{ eventType: 1, 'payload.deal.hs_object_id': 1, dedupActive: 1 }` con `partialFilterExpression: { dedupActive: true, 'payload.deal.hs_object_id': { $exists: true } }`.

- [ ] **Step 1: Escribir el test de integración que falla**

Este test necesita un `mongod` real: un mock no puede ejecutar la restricción de un índice único. Sigue el patrón de `tests/integration/webhookSapAuditPersistence.test.js`.

Crear `tests/integration/webhookEventDedupIndex.test.js`:

```js
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createWebhookEventModel } from '#infrastructure/database/models/tenant/WebhookEvent.js';

// El índice es la única garantía DURA de que no entren dos eventos abiertos para el mismo
// deal. Importa acá y no en un unit test porque la restricción la aplica el servidor: con
// un modelo mockeado, `create` siempre "funciona" y el agujero no se ve.
let mongoServer;
let connection;
let WebhookEvent;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(mongoServer.getUri(), { dbName: 'dedup-index-test' })
    .asPromise();
  WebhookEvent = createWebhookEventModel(connection);
  // Espera a que Mongoose termine de construir los índices declarados en el schema.
  await WebhookEvent.init();
}, 60000);

afterAll(async () => {
  await connection?.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await WebhookEvent.deleteMany({});
});

function buildEvent(overrides = {}) {
  return {
    eventType: 'createQuotation',
    payload: { deal: { hs_object_id: 'deal-1' } },
    status: 'waiting',
    retries: 0,
    maxRetries: 3,
    lastError: null,
    dedupActive: true,
    ...overrides,
  };
}

describe('índice único parcial de dedup en WebhookEvents', () => {
  it('rechaza un segundo evento no-errored para el mismo eventType y deal', async () => {
    await WebhookEvent.create(buildEvent());

    await expect(WebhookEvent.create(buildEvent())).rejects.toMatchObject({ code: 11000 });
  });

  it('acepta varios eventos errored para el mismo eventType y deal', async () => {
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));

    await expect(WebhookEvent.countDocuments({ status: 'errored' })).resolves.toBe(3);
  });

  it('acepta un evento nuevo abierto cuando el anterior quedó errored', async () => {
    await WebhookEvent.create(buildEvent({ status: 'errored', dedupActive: false }));

    await expect(WebhookEvent.create(buildEvent())).resolves.toMatchObject({ status: 'waiting' });
  });

  // updateQuotation nunca lleva el campo, así que sus documentos no entran al índice: una
  // cotización se actualiza muchas veces y cada envío es legítimo.
  it('no limita los eventos de updateQuotation, que no llevan dedupActive', async () => {
    const base = { eventType: 'updateQuotation', dedupActive: undefined };
    await WebhookEvent.create(buildEvent(base));
    await WebhookEvent.create(buildEvent(base));

    await expect(WebhookEvent.countDocuments({ eventType: 'updateQuotation' })).resolves.toBe(2);
  });

  // Los reportes de calidad de datos viven en esta misma colección y no tienen deal. Sin la
  // cláusula $exists del filtro parcial, todos colisionarían entre sí en (eventType, null).
  it('no limita documentos sin deal, aunque tengan dedupActive en true', async () => {
    const report = {
      eventType: 'productQualityReport',
      payload: { rows: [] },
      status: 'report',
      retries: 0,
      maxRetries: 0,
      lastError: null,
      dedupActive: true,
    };
    await WebhookEvent.create(report);
    await WebhookEvent.create(report);

    await expect(WebhookEvent.countDocuments({ status: 'report' })).resolves.toBe(2);
  });

  it('sigue permitiendo el mismo deal en tipos de evento distintos', async () => {
    await WebhookEvent.create(buildEvent({ eventType: 'createQuotation' }));
    await WebhookEvent.create(buildEvent({ eventType: 'inventoryTransferRequest' }));

    await expect(WebhookEvent.countDocuments({})).resolves.toBe(2);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- tests/integration/webhookEventDedupIndex.test.js`

Expected: FAIL. El primer caso falla porque hoy no existe ningún índice que cubra `createQuotation` (el actual es solo para `createDeal`), así que el segundo `create` resuelve en vez de rechazar. El caso de "acepta varios errored" también falla, porque `dedupActive` no está en el schema y Mongoose lo descarta.

- [ ] **Step 3: Agregar el campo al schema**

En `src/infrastructure/database/models/tenant/WebhookEvent.js`, después de `lastError` (línea 44-47) y antes de `sapAudit`:

```js
    // Gobierna el índice único parcial de abajo: `true` significa "este documento ocupa hoy
    // el cupo de dedup de su (eventType, dealId)". Vale `true` en todo estado que no sea
    // `errored`, que es el único reenviable. Se deja AUSENTE a propósito en los tipos que no
    // participan del dedup (updateQuotation) y en los reportes de sync: un documento sin el
    // campo no entra al índice, que es exactamente lo que se quiere para ellos. Sin default,
    // para que "ausente" siga siendo un estado posible y distinto de `false`.
    dedupActive: {
      type: Boolean,
    },
```

- [ ] **Step 4: Reemplazar el índice viejo por el nuevo**

Borrar el bloque completo de las líneas 59-77 (el comentario `// NOTE: This partial unique index only covers createDeal...` y su `webhookEventSchema.index(...)`) y poner en su lugar:

```js
// Garantía dura de que no puede haber dos eventos ABIERTOS para el mismo (eventType, dealId):
// a lo sumo uno con `dedupActive: true`. Los `errored` quedan fuera del índice y se acumulan
// libremente, que es lo que habilita el reenvío y a la vez conserva el intento anterior como
// log. Cubre los cuatro tipos deduplicados, no solo `createDeal` como el índice que reemplaza.
//
// `dedupActive` va DENTRO de la llave además del filtro parcial, y no es redundante: MongoDB
// no acepta dos índices con el mismo patrón de llave que difieran solo en el
// `partialFilterExpression`, así que con la llave vieja este índice y el anterior no podrían
// coexistir y la migración tendría que tumbar el viejo antes de crear el nuevo, abriendo una
// ventana sin ninguna protección sobre `createDeal`. Semánticamente no cambia nada: el filtro
// ya fija `dedupActive: true` en todo lo indexado, así que la unicidad sobre la terna es la
// misma que sobre el par.
//
// El `$exists` del deal tampoco es decorativo: los reportes de calidad de datos viven en esta
// colección y no tienen deal, así que sin él colisionarían entre sí en (eventType, null).
webhookEventSchema.index(
  {
    eventType: 1,
    'payload.deal.hs_object_id': 1,
    dedupActive: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      dedupActive: true,
      'payload.deal.hs_object_id': { $exists: true },
    },
  }
);
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `npm test -- tests/integration/webhookEventDedupIndex.test.js`

Expected: PASS, 6 casos.

- [ ] **Step 6: Correr la suite del modelo y del repositorio para descartar regresiones**

Run: `npm test -- tests/integration/webhookSapAuditPersistence.test.js tests/unit/infrastructure/mongooseWebhookEventRepository.test.js`

Expected: PASS. Si `webhookSapAuditPersistence` falla con `E11000`, es que sus fixtures insertan dos eventos abiertos para el mismo deal; ajustar los fixtures para usar `hs_object_id` distintos, no relajar el índice.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/database/models/tenant/WebhookEvent.js tests/integration/webhookEventDedupIndex.test.js
git commit -m "feat: at most one open WebhookEvent per deal via partial unique index"
```

---

## Task 2: Regla de dedup por estado en `queueWebhookEvent`

**Files:**
- Modify: `src/infrastructure/webhook/webhookEvent.service.js` (archivo completo, 87 líneas)
- Test: `tests/unit/infrastructure/webhookEventService.test.js` (crear)

**Interfaces:**
- Consumes: el campo `dedupActive` del Task 1.
- Produces:
  - `DEDUPLICATED_EVENT_TYPES: Set<string>` — exportado. Única fuente de verdad de qué tipos participan del dedup.
  - `RESENDABLE_STATUS: 'errored'` — exportado.
  - `findBlockingEvent({ WebhookEvent, eventType, payload }): Promise<{_id} | null>` — reemplaza a `findDuplicateEvent`.
  - `queueWebhookEvent({ WebhookEvent, eventType, payload, deduplicate? }): Promise<{ duplicated: boolean, eventId }>` — firma sin cambios.
  - Se elimina `findDuplicateCreateDealEvent`, que no tiene ningún consumidor (verificado con grep sobre `src/` y `tests/`) y cuyo nombre quedaría mintiendo.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/infrastructure/webhookEventService.test.js`:

```js
import { jest } from '@jest/globals';
import {
  DEDUPLICATED_EVENT_TYPES,
  RESENDABLE_STATUS,
  findBlockingEvent,
  queueWebhookEvent,
} from '../../../src/infrastructure/webhook/webhookEvent.service.js';

const ALL_STATUSES = [
  'waiting',
  'inprocess',
  'sap_order_created',
  'sap_created_hubspot_error',
  'completed',
  'errored',
  'report',
];

function buildWebhookEvent({ blocking = null } = {}) {
  return {
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(blocking),
      }),
    }),
    create: jest.fn(async (document) => ({ ...document, _id: 'new-event' })),
  };
}

const payload = { deal: { hs_object_id: 'deal-1' } };

describe('DEDUPLICATED_EVENT_TYPES', () => {
  // updateQuotation NO está a propósito: una cotización se actualiza muchas veces y cada
  // envío es legítimo. Agregarlo bloquearía la segunda actualización de una cotización que ya
  // sincronizó bien, porque su evento anterior quedó `completed`.
  it('cubre los cuatro tipos deduplicados y deja updateQuotation afuera', () => {
    expect([...DEDUPLICATED_EVENT_TYPES].sort()).toEqual([
      'convertQuotationToOrder',
      'createDeal',
      'createQuotation',
      'inventoryTransferRequest',
    ]);
    expect(DEDUPLICATED_EVENT_TYPES.has('updateQuotation')).toBe(false);
  });
});

describe('findBlockingEvent', () => {
  it('excluye solo el estado reenviable de la consulta', async () => {
    const WebhookEvent = buildWebhookEvent();

    await findBlockingEvent({ WebhookEvent, eventType: 'createDeal', payload });

    expect(WebhookEvent.findOne).toHaveBeenCalledWith({
      eventType: 'createDeal',
      'payload.deal.hs_object_id': 'deal-1',
      status: { $ne: RESENDABLE_STATUS },
    });
  });

  it('devuelve null sin consultar cuando el payload no trae dealId', async () => {
    const WebhookEvent = buildWebhookEvent();

    await expect(
      findBlockingEvent({ WebhookEvent, eventType: 'createDeal', payload: {} })
    ).resolves.toBeNull();
    expect(WebhookEvent.findOne).not.toHaveBeenCalled();
  });
});

describe('queueWebhookEvent', () => {
  it.each(ALL_STATUSES.filter((status) => status !== 'errored'))(
    'trata como duplicado cuando ya existe un evento en %s',
    async (status) => {
      const WebhookEvent = buildWebhookEvent({ blocking: { _id: 'existing', status } });

      const result = await queueWebhookEvent({
        WebhookEvent,
        eventType: 'createDeal',
        payload,
      });

      expect(result).toEqual({ duplicated: true, eventId: 'existing' });
      expect(WebhookEvent.create).not.toHaveBeenCalled();
    }
  );

  it('inserta un evento nuevo cuando el anterior quedó errored', async () => {
    // findOne ya filtra por status distinto de errored, así que un errored previo no aparece.
    const WebhookEvent = buildWebhookEvent({ blocking: null });

    const result = await queueWebhookEvent({
      WebhookEvent,
      eventType: 'createDeal',
      payload,
    });

    expect(result).toEqual({ duplicated: false, eventId: 'new-event' });
    expect(WebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'createDeal',
        status: 'waiting',
        retries: 0,
        maxRetries: 3,
        lastError: null,
        dedupActive: true,
      })
    );
  });

  it.each([...DEDUPLICATED_EVENT_TYPES])('marca dedupActive en %s', async (eventType) => {
    const WebhookEvent = buildWebhookEvent();

    await queueWebhookEvent({ WebhookEvent, eventType, payload });

    const [document] = WebhookEvent.create.mock.calls[0];
    expect(document.dedupActive).toBe(true);
  });

  it('no escribe dedupActive ni consulta duplicados en updateQuotation', async () => {
    const WebhookEvent = buildWebhookEvent();

    const result = await queueWebhookEvent({
      WebhookEvent,
      eventType: 'updateQuotation',
      payload,
    });

    expect(result).toEqual({ duplicated: false, eventId: 'new-event' });
    expect(WebhookEvent.findOne).not.toHaveBeenCalled();
    const [document] = WebhookEvent.create.mock.calls[0];
    expect(document).not.toHaveProperty('dedupActive');
  });

  it('resuelve la carrera de dos reenvíos simultáneos como duplicado', async () => {
    const WebhookEvent = buildWebhookEvent();
    // Primera consulta: nada bloquea. El create pierde la carrera contra el índice único.
    // Segunda consulta: ya hay un evento abierto, el que insertó el ganador.
    WebhookEvent.findOne
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'winner' }) }),
      });
    WebhookEvent.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));

    const result = await queueWebhookEvent({
      WebhookEvent,
      eventType: 'createDeal',
      payload,
    });

    expect(result).toEqual({ duplicated: true, eventId: 'winner' });
  });

  it('propaga cualquier error de create que no sea duplicate key', async () => {
    const WebhookEvent = buildWebhookEvent();
    WebhookEvent.create.mockRejectedValueOnce(new Error('Mongo down'));

    await expect(
      queueWebhookEvent({ WebhookEvent, eventType: 'createDeal', payload })
    ).rejects.toThrow('Mongo down');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- tests/unit/infrastructure/webhookEventService.test.js`

Expected: FAIL con `SyntaxError` o `undefined` al importar `RESENDABLE_STATUS` y `findBlockingEvent`, que todavía no existen.

- [ ] **Step 3: Reescribir el servicio**

Reemplazar el contenido de `src/infrastructure/webhook/webhookEvent.service.js` por:

```js
const CREATE_DEAL_EVENT_TYPE = 'createDeal';

// El ÚNICO estado que habilita un reenvío. Es el único que garantiza que no hay documento en
// SAP: `errored` se escribe cuando se agotaron los retries o el error fue permanente, siempre
// antes de crear el documento. Cuando SAP sí creó y falló algo posterior, el estado es
// `sap_created_hubspot_error`, que bloquea -- reprocesarlo crearía un segundo documento.
export const RESENDABLE_STATUS = 'errored';

// Tipos con un solo evento ABIERTO por deal. Única fuente de verdad de la lista: el
// repositorio y la migración la importan de acá.
//
// `updateQuotation` NO está, a propósito: una cotización se actualiza muchas veces y cada
// envío es legítimo, así que ahí el reenvío ya funciona desde siempre. Agregarlo bloquearía la
// segunda actualización de una cotización que ya sincronizó bien, porque su evento anterior
// quedó `completed`. No es un olvido y no hay que "completar" la lista por prolijidad.
export const DEDUPLICATED_EVENT_TYPES = new Set([
  CREATE_DEAL_EVENT_TYPE,
  'createQuotation',
  'convertQuotationToOrder',
  'inventoryTransferRequest',
]);

function normalizeDealId(payload) {
  return payload?.deal?.hs_object_id?.toString().trim();
}

// Devuelve el evento que impide encolar uno nuevo para este (eventType, dealId), o null si no
// hay ninguno. La condición se escribe por EXCLUSIÓN (`$ne: RESENDABLE_STATUS`) y no como
// lista blanca de estados que bloquean: si mañana se agrega un estado al enum de WebhookEvent
// y nadie se acuerda de este archivo, el default es bloquear, que es el lado seguro del error.
export async function findBlockingEvent({ WebhookEvent, eventType, payload }) {
  const dealId = normalizeDealId(payload);

  if (!dealId) {
    return null;
  }

  return WebhookEvent.findOne({
    eventType,
    'payload.deal.hs_object_id': dealId,
    status: { $ne: RESENDABLE_STATUS },
  }).select({ _id: 1 }).lean();
}

export async function queueWebhookEvent({
  WebhookEvent,
  eventType,
  payload,
  deduplicate = DEDUPLICATED_EVENT_TYPES.has(eventType),
}) {
  if (deduplicate) {
    const blocking = await findBlockingEvent({ WebhookEvent, eventType, payload });

    if (blocking) {
      return {
        duplicated: true,
        eventId: blocking._id,
      };
    }
  }

  const document = {
    eventType,
    payload,
    status: 'waiting',
    retries: 0,
    maxRetries: 3,
    lastError: null,
  };

  // Solo los tipos deduplicados ocupan cupo en el índice único parcial. Para el resto el
  // campo queda AUSENTE, no en `false`: un documento sin el campo no entra al índice, que es
  // justo lo que necesita updateQuotation para poder repetirse.
  if (deduplicate) {
    document.dedupActive = true;
  }

  let createdEvent;

  try {
    createdEvent = await WebhookEvent.create(document);
  } catch (error) {
    // Dos reenvíos simultáneos: los dos pasaron el findBlockingEvent y el índice único dejó
    // entrar a uno solo. El que perdió se comporta como duplicado, igual que si hubiera
    // llegado un segundo después.
    if (deduplicate && error?.code === 11000) {
      const existingEvent = await findBlockingEvent({ WebhookEvent, eventType, payload });
      return {
        duplicated: true,
        eventId: existingEvent?._id,
      };
    }
    throw error;
  }

  return {
    duplicated: false,
    eventId: createdEvent._id,
  };
}

export async function queueCreateDealEvent({ WebhookEvent, payload }) {
  return queueWebhookEvent({
    WebhookEvent,
    eventType: CREATE_DEAL_EVENT_TYPE,
    payload,
    deduplicate: true,
  });
}

export { CREATE_DEAL_EVENT_TYPE };
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- tests/unit/infrastructure/webhookEventService.test.js`

Expected: PASS.

- [ ] **Step 5: Verificar que no quedó ningún consumidor de los nombres viejos**

Run: `grep -rn "findDuplicateEvent\|findDuplicateCreateDealEvent" src/ tests/`

Expected: sin resultados. Si aparece alguno, actualizarlo a `findBlockingEvent` antes de seguir.

- [ ] **Step 6: Correr la suite del encolado**

Run: `npm test -- tests/unit/application/queueHubspotCreateDealWebhook.test.js`

Expected: PASS. `QueueHubspotWebhookEvent` no cambia: sigue recibiendo `{ duplicated, eventId }` con la misma forma.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/webhook/webhookEvent.service.js tests/unit/infrastructure/webhookEventService.test.js
git commit -m "feat: allow requeueing a webhook event once the previous one is errored"
```

---

## Task 3: `markFailed` mantiene `dedupActive`

**Files:**
- Modify: `src/infrastructure/repositories/MongooseWebhookEventRepository.js:1-17` (imports y helpers) y `:100-120` (`markFailed`)
- Test: `tests/unit/infrastructure/mongooseWebhookEventRepository.test.js` (agregar casos)

**Interfaces:**
- Consumes: `DEDUPLICATED_EVENT_TYPES` y `RESENDABLE_STATUS` del Task 2.
- Produces: `markFailed` agrega `dedupActive` al `$set` solo cuando `event.eventType` está en `DEDUPLICATED_EVENT_TYPES`, con el valor `failure.status !== RESENDABLE_STATUS`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tests/unit/infrastructure/mongooseWebhookEventRepository.test.js`, dentro del `describe` existente:

```js
  // El cupo de dedup lo libera SOLO `errored`, que es el único estado reenviable. Se calcula
  // del status y no se pone en `false` a secas porque markFailed también se llama con
  // `waiting`: el camino de liberación de safelyHandleProcessingError. Un evento que sigue en
  // cola liberando su cupo dejaría entrar un segundo envío en paralelo, que es exactamente el
  // agujero que el índice único viene a tapar.
  describe('dedupActive', () => {
    function runMarkFailed({ eventType, status }) {
      const updateOne = jest.fn().mockResolvedValue({});
      const repository = new MongooseWebhookEventRepository({
        WebhookEvent: { updateOne },
        batchSize: 1,
      });

      return repository
        .markFailed({ _id: 'event-1', eventType }, { status, retries: 1, lastError: 'boom' })
        .then(() => updateOne.mock.calls[0][1].$set);
    }

    it('lo libera cuando el evento queda errored', async () => {
      const $set = await runMarkFailed({ eventType: 'createDeal', status: 'errored' });

      expect($set.dedupActive).toBe(false);
    });

    it('lo mantiene cuando el evento vuelve a la cola en waiting', async () => {
      const $set = await runMarkFailed({ eventType: 'createDeal', status: 'waiting' });

      expect($set.dedupActive).toBe(true);
    });

    it('lo mantiene cuando SAP ya creó el documento', async () => {
      const $set = await runMarkFailed({
        eventType: 'createQuotation',
        status: 'sap_created_hubspot_error',
      });

      expect($set.dedupActive).toBe(true);
    });

    it('no lo escribe para updateQuotation, que no participa del dedup', async () => {
      const $set = await runMarkFailed({ eventType: 'updateQuotation', status: 'errored' });

      expect(Object.keys($set)).not.toContain('dedupActive');
    });

    it('no lo escribe para un evento legacy sin eventType', async () => {
      const $set = await runMarkFailed({ eventType: undefined, status: 'errored' });

      expect(Object.keys($set)).not.toContain('dedupActive');
    });
  });
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `npm test -- tests/unit/infrastructure/mongooseWebhookEventRepository.test.js`

Expected: FAIL en los tres primeros casos nuevos (`$set.dedupActive` es `undefined`). Los dos últimos pasan por accidente, porque hoy el campo nunca se escribe; quedan como red contra una implementación que lo escriba siempre.

- [ ] **Step 3: Implementar**

En `src/infrastructure/repositories/MongooseWebhookEventRepository.js`, agregar el import arriba, junto al de `error-message.service.js`:

```js
import {
  DEDUPLICATED_EVENT_TYPES,
  RESENDABLE_STATUS,
} from '#infrastructure/webhook/webhookEvent.service.js';
```

Agregar el helper después de `toSafeLastError`:

```js
// Deriva el cupo de dedup del estado destino en vez de recibirlo del llamador: el batch llama
// a markFailed con tres estados distintos (`errored`, `sap_created_hubspot_error` y `waiting`
// en el camino de liberación) y solo el primero libera el cupo. Se consulta
// DEDUPLICATED_EVENT_TYPES en vez de mirar si el documento ya trae el campo, así los eventos
// que quedaron sin backfillear se corrigen solos la primera vez que pasan por acá -- y
// updateQuotation nunca lo recibe, que es lo que le permite repetirse.
function resolveDedupActive(eventType, status) {
  if (!DEDUPLICATED_EVENT_TYPES.has(eventType)) {
    return undefined;
  }

  return status !== RESENDABLE_STATUS;
}
```

En `markFailed`, después de armar `updates` y antes del `if (failure.sapResult)`:

```js
    const dedupActive = resolveDedupActive(event?.eventType, failure.status);

    if (dedupActive !== undefined) {
      updates.dedupActive = dedupActive;
    }
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test -- tests/unit/infrastructure/mongooseWebhookEventRepository.test.js`

Expected: PASS, incluidos los casos viejos de `sapAudit` y `lastError`.

- [ ] **Step 5: Verificar que no se creó un ciclo de imports**

`webhookEvent.service.js` no importa nada del repositorio, así que la dependencia es en un solo sentido.

Run: `grep -n "^import" src/infrastructure/webhook/webhookEvent.service.js`

Expected: sin resultados (el archivo no tiene imports).

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/repositories/MongooseWebhookEventRepository.js tests/unit/infrastructure/mongooseWebhookEventRepository.test.js
git commit -m "feat: release the dedup slot only when a webhook event ends errored"
```

---

## Task 4: Constantes de estado y configuración por tenant

**Files:**
- Create: `src/domain/webhooks/integration-status.constants.js`
- Modify: `src/infrastructure/config/webhookFailureNotification.config.js` (archivo completo, 44 líneas)
- Test: `tests/unit/infrastructure/webhookFailureNotification.config.test.js` (agregar casos)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `INTEGRATION_STATUS_KEYS = { COMPLETED: 'completed', ERROR_RETRY: 'errorRetry', ERROR_SUPPORT: 'errorSupport' }`
  - `INTEGRATION_STATUS_KEY_LIST = ['completed', 'errorRetry', 'errorSupport']`
  - `getWebhookFailureNotificationConfig` devuelve dos campos más: `integrationStatusProperty: string | null` e `integrationStatusValues: { completed, errorRetry, errorSupport } | null`. Los dos son `null` juntos, nunca uno solo.

- [ ] **Step 1: Crear las constantes de dominio**

Las llaves van en dominio y no en infraestructura porque `ProcessWebhookDealEventBatch` (capa de aplicación) tiene que nombrarlas, y la aplicación no importa infraestructura.

Crear `src/domain/webhooks/integration-status.constants.js`:

```js
// Los tres estados terminales que el integrador publica en el deal de HubSpot. Son llaves
// internas: el valor concreto que se escribe en la propiedad lo define cada tenant en su
// configuración, porque un tenant puede querer reusar una propiedad de estado que ya tenía.
//
// `Reintentar` no está acá a propósito: ese valor solo lo escribe el asesor a mano y solo lo
// lee el workflow de HubSpot. El integrador nunca lo escribe.
export const INTEGRATION_STATUS_KEYS = Object.freeze({
  // El evento quedó `completed`.
  COMPLETED: 'completed',
  // El evento quedó `errored`: no hay documento en SAP y el reenvío está habilitado.
  ERROR_RETRY: 'errorRetry',
  // El evento quedó `sap_created_hubspot_error`: SAP ya tiene el documento, así que reenviar
  // lo duplicaría. Requiere intervención de soporte.
  ERROR_SUPPORT: 'errorSupport',
});

export const INTEGRATION_STATUS_KEY_LIST = Object.freeze(
  Object.values(INTEGRATION_STATUS_KEYS)
);

export default { INTEGRATION_STATUS_KEYS, INTEGRATION_STATUS_KEY_LIST };
```

- [ ] **Step 2: Escribir los tests que fallan**

Agregar al `describe` de `tests/unit/infrastructure/webhookFailureNotification.config.test.js`:

```js
  describe('propiedad de estado de integración', () => {
    function readConfig(value) {
      const findOne = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ value }) });
      return getWebhookFailureNotificationConfig({ tenantModels: { Configuration: { findOne } } });
    }

    const validValues = {
      completed: 'completed',
      errorRetry: 'error_retry',
      errorSupport: 'error_support',
    };

    it('lee el nombre de la propiedad y los tres valores', async () => {
      const config = await readConfig({
        requireMessageHS: true,
        integrationStatusProperty: '  sap_integration_status  ',
        integrationStatusValues: validValues,
      });

      expect(config.integrationStatusProperty).toBe('sap_integration_status');
      expect(config.integrationStatusValues).toEqual(validValues);
    });

    it('queda apagada cuando no hay nombre de propiedad', async () => {
      const config = await readConfig({
        requireMessageHS: true,
        integrationStatusValues: validValues,
      });

      expect(config.integrationStatusProperty).toBeNull();
      expect(config.integrationStatusValues).toBeNull();
    });

    // Falla apagado, igual que bypassSapErrors: escribir la propiedad con solo dos de los tres
    // valores configurados dejaría al asesor mirando un estado que no significa lo que dice.
    it.each(['completed', 'errorRetry', 'errorSupport'])(
      'queda apagada por completo cuando falta el valor %s',
      async (missing) => {
        const incomplete = { ...validValues };
        delete incomplete[missing];

        const config = await readConfig({
          requireMessageHS: true,
          integrationStatusProperty: 'sap_integration_status',
          integrationStatusValues: incomplete,
        });

        expect(config.integrationStatusProperty).toBeNull();
        expect(config.integrationStatusValues).toBeNull();
      }
    );

    it('queda apagada cuando integrationStatusValues no es un objeto', async () => {
      const config = await readConfig({
        integrationStatusProperty: 'sap_integration_status',
        integrationStatusValues: 'nope',
      });

      expect(config.integrationStatusProperty).toBeNull();
      expect(config.integrationStatusValues).toBeNull();
    });

    it('no afecta a los campos de la nota ni de la etapa', async () => {
      const config = await readConfig({
        requireMessageHS: true,
        requiereReturnStage: true,
        stageToReturned: 'stage-7',
      });

      expect(config).toMatchObject({
        requireMessageHS: true,
        requiereReturnStage: true,
        stageToReturned: 'stage-7',
        integrationStatusProperty: null,
        integrationStatusValues: null,
      });
    });
  });
```

Y actualizar el default esperado en el test existente:

```js
  it('returns the default config when the tenant has no Configuration model', async () => {
    const config = await getWebhookFailureNotificationConfig({ tenantModels: {} });

    expect(config).toEqual(DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG);
    expect(config.integrationStatusProperty).toBeNull();
    expect(config.integrationStatusValues).toBeNull();
  });
```

- [ ] **Step 3: Correr los tests para verificar que fallan**

Run: `npm test -- tests/unit/infrastructure/webhookFailureNotification.config.test.js`

Expected: FAIL. Los tres tests viejos que usan `toEqual({ requireMessageHS, requiereReturnStage, stageToReturned })` también fallan al agregarse las dos llaves nuevas — hay que extenderlos con `integrationStatusProperty: null, integrationStatusValues: null`.

- [ ] **Step 4: Implementar**

Reemplazar `src/infrastructure/config/webhookFailureNotification.config.js` por:

```js
import { INTEGRATION_STATUS_KEY_LIST } from '#domain/webhooks/integration-status.constants.js';

export const WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY = 'requireMessageHS';

export const DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG = {
  requireMessageHS: false,
  requiereReturnStage: false,
  stageToReturned: null,
  integrationStatusProperty: null,
  integrationStatusValues: null,
};

function toTrimmedOrNull(value) {
  return value ? String(value).trim() || null : null;
}

const INTEGRATION_STATUS_OFF = {
  integrationStatusProperty: null,
  integrationStatusValues: null,
};

/**
 * Falla apagado, igual que `bypassSapErrors`: la publicación de estado se activa solo con el
 * nombre de la propiedad Y los tres valores presentes. Si falta cualquiera se devuelven los dos
 * campos en `null` juntos, nunca uno solo, así el consumidor no tiene que combinar condiciones.
 * Escribir la propiedad a medias dejaría al asesor mirando un estado que no significa lo que
 * dice, y el estado es justo lo que decide si puede reenviar o si tiene que escalar.
 */
function normalizeIntegrationStatus(value) {
  const property = toTrimmedOrNull(value?.integrationStatusProperty);

  if (!property) {
    return { ...INTEGRATION_STATUS_OFF };
  }

  const rawValues = value?.integrationStatusValues;

  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    return { ...INTEGRATION_STATUS_OFF };
  }

  const values = {};

  for (const key of INTEGRATION_STATUS_KEY_LIST) {
    const normalized = toTrimmedOrNull(rawValues[key]);

    if (!normalized) {
      return { ...INTEGRATION_STATUS_OFF };
    }

    values[key] = normalized;
  }

  return { integrationStatusProperty: property, integrationStatusValues: values };
}

function normalizeWebhookFailureNotificationConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG };
  }

  const requireMessageHS = value.requireMessageHS === true || value.requireMessageHS === 'true';
  const requiereReturnStage = value.requiereReturnStage === true || value.requiereReturnStage === 'true';
  const stageToReturned = toTrimmedOrNull(value.stageToReturned);

  return {
    requireMessageHS,
    requiereReturnStage,
    stageToReturned,
    ...normalizeIntegrationStatus(value),
  };
}

/**
 * Reads the tenant `requireMessageHS` configuration used on permanent webhook
 * failures to decide whether to leave an error note on the HubSpot deal, optionally
 * move it back to a given dealstage, y qué valor publicar en la propiedad de estado
 * de integración del deal.
 */
export async function getWebhookFailureNotificationConfig({ tenantContext, tenantModels } = {}) {
  const Configuration = (tenantContext?.tenantModels ?? tenantModels)?.Configuration;

  if (typeof Configuration?.findOne !== 'function') {
    return { ...DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG };
  }

  const query = Configuration.findOne({ key: WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return normalizeWebhookFailureNotificationConfig(configuration?.value);
}

export default {
  getWebhookFailureNotificationConfig,
  WEBHOOK_FAILURE_NOTIFICATION_CONFIG_KEY,
  DEFAULT_WEBHOOK_FAILURE_NOTIFICATION_CONFIG,
};
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `npm test -- tests/unit/infrastructure/webhookFailureNotification.config.test.js`

Expected: PASS.

- [ ] **Step 6: Verificar que el notifier existente no se rompió**

Run: `npm test -- tests/unit/infrastructure/webhookFailureNotifier.service.test.js`

Expected: PASS. El notifier solo lee `requireMessageHS`, `requiereReturnStage` y `stageToReturned`, que no cambiaron de forma.

- [ ] **Step 7: Commit**

```bash
git add src/domain/webhooks/integration-status.constants.js src/infrastructure/config/webhookFailureNotification.config.js tests/unit/infrastructure/webhookFailureNotification.config.test.js
git commit -m "feat: read the deal integration status property from tenant config"
```

---

## Task 5: Servicio que publica el estado en el deal

**Files:**
- Create: `src/infrastructure/hubspot/dealIntegrationStatus.service.js`
- Test: `tests/unit/infrastructure/dealIntegrationStatus.service.test.js` (crear)

**Interfaces:**
- Consumes: `INTEGRATION_STATUS_KEYS` (Task 4), `getWebhookFailureNotificationConfig` (Task 4).
- Produces: `buildPublishIntegrationStatus({ hubspotClient, hubspotWebhookAdapter, getWebhookFailureNotificationConfig, resolveEventPayload, logger })` que devuelve `publishIntegrationStatus({ event, status, tenantModels, portalId }): Promise<void>`. `status` es una de las llaves de `INTEGRATION_STATUS_KEYS`. Nunca lanza.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/infrastructure/dealIntegrationStatus.service.test.js`:

```js
import { jest } from '@jest/globals';
import { INTEGRATION_STATUS_KEYS } from '../../../src/domain/webhooks/integration-status.constants.js';
import { buildPublishIntegrationStatus } from '../../../src/infrastructure/hubspot/dealIntegrationStatus.service.js';

const CONFIGURED = {
  requireMessageHS: false,
  requiereReturnStage: false,
  stageToReturned: null,
  integrationStatusProperty: 'sap_integration_status',
  integrationStatusValues: {
    completed: 'completed',
    errorRetry: 'error_retry',
    errorSupport: 'error_support',
  },
};

function buildDeps(overrides = {}) {
  return {
    hubspotClient: {
      updateDeal: jest.fn().mockResolvedValue({}),
    },
    hubspotWebhookAdapter: {
      resolveAccessTokenForPortal: jest.fn().mockResolvedValue({ token: 'token-1' }),
    },
    getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue(CONFIGURED),
    resolveEventPayload: jest.fn((event) => ({ deal: event?.payload?.deal || null })),
    logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('publishIntegrationStatus', () => {
  const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };

  it.each([
    [INTEGRATION_STATUS_KEYS.COMPLETED, 'completed'],
    [INTEGRATION_STATUS_KEYS.ERROR_RETRY, 'error_retry'],
    [INTEGRATION_STATUS_KEYS.ERROR_SUPPORT, 'error_support'],
  ])('escribe el valor configurado para %s', async (status, expected) => {
    const deps = buildDeps();
    const publish = buildPublishIntegrationStatus(deps);

    await publish({ event, status, tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.updateDeal).toHaveBeenCalledWith('token-1', 'deal-1', {
      properties: { sap_integration_status: expected },
    });
  });

  it('no hace nada cuando la función no está configurada', async () => {
    const deps = buildDeps({
      getWebhookFailureNotificationConfig: jest.fn().mockResolvedValue({
        ...CONFIGURED,
        integrationStatusProperty: null,
        integrationStatusValues: null,
      }),
    });
    const publish = buildPublishIntegrationStatus(deps);

    await publish({
      event,
      status: INTEGRATION_STATUS_KEYS.ERROR_RETRY,
      tenantModels: {},
      portalId: 'p1',
    });

    expect(deps.hubspotWebhookAdapter.resolveAccessTokenForPortal).not.toHaveBeenCalled();
    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('no hace nada ante un status desconocido', async () => {
    const deps = buildDeps();
    const publish = buildPublishIntegrationStatus(deps);

    await publish({ event, status: 'inventado', tenantModels: {}, portalId: 'p1' });

    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('avisa y se detiene cuando el payload no trae dealId', async () => {
    const deps = buildDeps();
    const publish = buildPublishIntegrationStatus(deps);

    await publish({
      event: { _id: 'event-2', payload: {} },
      status: INTEGRATION_STATUS_KEYS.COMPLETED,
      tenantModels: {},
      portalId: 'p1',
    });

    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  it('avisa y se detiene cuando el tenant no tiene credenciales de HubSpot', async () => {
    const deps = buildDeps({
      hubspotWebhookAdapter: {
        resolveAccessTokenForPortal: jest.fn().mockResolvedValue({ token: null }),
      },
    });
    const publish = buildPublishIntegrationStatus(deps);

    await publish({
      event,
      status: INTEGRATION_STATUS_KEYS.COMPLETED,
      tenantModels: {},
      portalId: 'p1',
    });

    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.hubspotClient.updateDeal).not.toHaveBeenCalled();
  });

  // La regla dura: esto corre DESPUÉS del bookkeeping. Si dejara escapar el error, un hipo de
  // HubSpot desandaría un markFailed/markCompleted que ya se guardó.
  it('nunca lanza cuando HubSpot falla', async () => {
    const deps = buildDeps({
      hubspotClient: { updateDeal: jest.fn().mockRejectedValue(new Error('HubSpot 500')) },
    });
    const publish = buildPublishIntegrationStatus(deps);

    await expect(
      publish({
        event,
        status: INTEGRATION_STATUS_KEYS.COMPLETED,
        tenantModels: {},
        portalId: 'p1',
      })
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('nunca lanza cuando la lectura de configuración falla', async () => {
    const deps = buildDeps({
      getWebhookFailureNotificationConfig: jest.fn().mockRejectedValue(new Error('Mongo down')),
    });
    const publish = buildPublishIntegrationStatus(deps);

    await expect(
      publish({
        event,
        status: INTEGRATION_STATUS_KEYS.COMPLETED,
        tenantModels: {},
        portalId: 'p1',
      })
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- tests/unit/infrastructure/dealIntegrationStatus.service.test.js`

Expected: FAIL — no existe el módulo `dealIntegrationStatus.service.js`.

- [ ] **Step 3: Implementar el servicio**

Crear `src/infrastructure/hubspot/dealIntegrationStatus.service.js`:

```js
// Publica en el deal de HubSpot el estado terminal del evento. Es el hermano de
// `notifyWebhookFailure` (webhookFailureNotifier.service.js) y comparte su regla dura: corre
// DESPUÉS del bookkeeping, así que no puede tirar nunca hacia arriba -- un hipo de HubSpot acá
// no puede desandar un markFailed/markCompleted que ya se guardó en Mongo.
//
// El valor concreto sale de la configuración del tenant, no de una constante: un tenant puede
// tener su propia propiedad de estado y sus propios valores. Si la configuración está
// incompleta, `getWebhookFailureNotificationConfig` devuelve la función apagada y acá no se
// escribe nada.
export function buildPublishIntegrationStatus({
  hubspotClient,
  hubspotWebhookAdapter,
  getWebhookFailureNotificationConfig,
  resolveEventPayload,
  logger,
}) {
  return async function publishIntegrationStatus({ event, status, tenantModels, portalId }) {
    try {
      const config = await getWebhookFailureNotificationConfig({ tenantModels });
      const property = config.integrationStatusProperty;
      const value = config.integrationStatusValues?.[status];

      // Apagado por configuración, o un `status` que el tenant no configuró. En los dos casos
      // no hay nada honesto que escribir, y no escribir nada es inocuo: la propiedad es
      // informativa y el que decide si se puede reenviar es el estado del WebhookEvent.
      if (!property || !value) {
        return;
      }

      const { deal } = resolveEventPayload(event);
      const dealId = deal?.hs_object_id;

      if (!dealId) {
        logger.warn({
          msg: 'Integration status skipped: no dealId in event payload',
          eventId: String(event?._id),
          status,
        });
        return;
      }

      const resolved = await hubspotWebhookAdapter.resolveAccessTokenForPortal({
        tenantModels,
        portalId,
      });

      if (!resolved?.token) {
        logger.warn({
          msg: 'Integration status skipped: no HubSpot credentials for tenant',
          eventId: String(event?._id),
          status,
        });
        return;
      }

      await hubspotClient.updateDeal(resolved.token, dealId, {
        properties: { [property]: value },
      });
    } catch (error) {
      logger.error({
        msg: 'Failed to publish integration status to HubSpot',
        eventId: String(event?._id),
        status,
        error: error.message,
      });
    }
  };
}

export default { buildPublishIntegrationStatus };
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- tests/unit/infrastructure/dealIntegrationStatus.service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/dealIntegrationStatus.service.js tests/unit/infrastructure/dealIntegrationStatus.service.test.js
git commit -m "feat: publish the terminal integration status to the HubSpot deal"
```

---

## Task 6: Cablear el publicador en el batch

**Files:**
- Modify: `src/application/use-cases/ProcessWebhookDealEventBatch.js` (imports, constructor `:19-36`, `execute` `:123-132`, `handlePostSapBookkeepingFailure` `:219-255`, `handleProcessingError` `:257-320`)
- Modify: `src/composition/webhook-processing.composition.js` (última función, `buildProcessWebhookDealEventBatch`)
- Test: `tests/unit/application/processWebhookDealEventBatch.test.js` (agregar casos)

**Interfaces:**
- Consumes: `buildPublishIntegrationStatus` (Task 5), `INTEGRATION_STATUS_KEYS` (Task 4).
- Produces: `ProcessWebhookDealEventBatch` acepta `publishIntegrationStatus` en el constructor, con default no-op, y lo invoca en sus tres puntos terminales a través de un envoltorio interno que se traga los errores.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final del `describe('ProcessWebhookDealEventBatch')` de `tests/unit/application/processWebhookDealEventBatch.test.js`. El archivo no tiene helper compartido: cada caso construye el use case inline, y estos siguen ese estilo.

```js
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
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `npm test -- tests/unit/application/processWebhookDealEventBatch.test.js`

Expected: FAIL — `publishIntegrationStatus` nunca se invoca.

- [ ] **Step 3: Implementar en el use case**

En `src/application/use-cases/ProcessWebhookDealEventBatch.js`:

Agregar el import junto a los dos existentes:

```js
import { INTEGRATION_STATUS_KEYS } from '#domain/webhooks/integration-status.constants.js';
```

Agregar el no-op junto a `noopNotifyWebhookFailure`:

```js
async function noopPublishIntegrationStatus() {}
```

En el constructor, agregar el parámetro con su default y asignarlo:

```js
    publishIntegrationStatus = noopPublishIntegrationStatus,
```

```js
    this.publishIntegrationStatus = publishIntegrationStatus;
```

Agregar el envoltorio como método de la clase, junto a `safelyHandleProcessingError`:

```js
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
```

En `execute`, dentro del `if (markedCompleted)`, ANTES de `notifyContactEmployeeFailures`:

```js
      if (markedCompleted) {
        await this.safelyPublishIntegrationStatus({
          event,
          status: INTEGRATION_STATUS_KEYS.COMPLETED,
          tenantModels,
          portalId,
        });

        await this.notifyContactEmployeeFailures({ ... });
      }
```

En `handlePostSapBookkeepingFailure`, después del `this.logger.error({ ... })` final:

```js
    // SAP ya tiene el documento: reenviar lo duplicaría, así que el asesor tiene que escalar.
    await this.safelyPublishIntegrationStatus({
      event,
      status: INTEGRATION_STATUS_KEYS.ERROR_SUPPORT,
      tenantModels,
      portalId,
    });
```

En `handleProcessingError`, dentro de la rama `if (error?.sapOrderCreated)`, después de su `this.logger.error({ ... })` y antes del `return`:

```js
      await this.safelyPublishIntegrationStatus({
        event,
        status: INTEGRATION_STATUS_KEYS.ERROR_SUPPORT,
        tenantModels,
        portalId,
      });
      return;
```

Y en el bloque final, dentro del `else` de `shouldRetry`, junto al `notifyWebhookFailure`:

```js
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
```

`resolveErrorMessageText` ya está importado en la primera línea del archivo.

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test -- tests/unit/application/processWebhookDealEventBatch.test.js`

Expected: PASS.

- [ ] **Step 5: Cablear en la composition**

En `src/composition/webhook-processing.composition.js`, agregar el import:

```js
import { buildPublishIntegrationStatus } from '#infrastructure/hubspot/dealIntegrationStatus.service.js';
```

Y en `buildProcessWebhookDealEventBatch`, agregar el parámetro con su default y pasarlo al constructor:

```js
export function buildProcessWebhookDealEventBatch({
  webhookEventRepository,
  processWebhookDealEvent = buildWebhookEventDispatcher(),
  maxRetries,
  notifyWebhookFailure = buildNotifyWebhookFailure({ /* sin cambios */ }),
  publishIntegrationStatus = buildPublishIntegrationStatus({
    hubspotClient,
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    getWebhookFailureNotificationConfig,
    resolveEventPayload,
    logger,
  }),
} = {}) {
  return new ProcessWebhookDealEventBatch({
    webhookEventRepository,
    processWebhookDealEvent,
    logger,
    maxRetries,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    notifyWebhookFailure,
    publishIntegrationStatus,
  });
}
```

- [ ] **Step 6: Verificar el cableado por grep, no por test**

Ya pasó tres veces en este repo commitear un parámetro de constructor sin cablear con todos los tests verdes, porque el doble inyectado del test lo tapa. La verificación es textual:

Run: `grep -n "publishIntegrationStatus" src/composition/webhook-processing.composition.js`

Expected: tres apariciones — el default del parámetro, la llamada a `buildPublishIntegrationStatus`, y la llave pasada al constructor de `ProcessWebhookDealEventBatch`. Si falta la tercera, el servicio nunca corre en producción por más verde que esté la suite.

- [ ] **Step 7: Correr la suite completa de webhooks**

Run: `npm test -- tests/unit/application/processWebhookDealEventBatch.test.js tests/unit/application/webhookEventDispatcher.test.js tests/unit/application/processHubspotWebhookEvent.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/application/use-cases/ProcessWebhookDealEventBatch.js src/composition/webhook-processing.composition.js tests/unit/application/processWebhookDealEventBatch.test.js
git commit -m "feat: publish integration status at every terminal webhook outcome"
```

---

## Task 7: Crear la propiedad en el portal del tenant

**Files:**
- Modify: `src/infrastructure/hubspot/tenantHubspotSeed.service.js:170-173` (la lista `fieldsToEnsure`)
- Test: `tests/unit/infrastructure/tenantHubspotSeed.service.test.js` (crear)

**Interfaces:**
- Consumes: nada del resto del plan. La propiedad se llama `sap_integration_status` y sus valores son `completed`, `error_retry`, `error_support`, `retry`.
- Produces: nada que consuman otras tareas. Los valores tienen que coincidir con lo que el tenant ponga en `integrationStatusValues` (Task 4); el `retry` no lo escribe el integrador nunca.

- [ ] **Step 1: Escribir el test que falla**

`seedCreateFieldsHubspot` importa `ensureObjectProperty` directamente, así que hay que mockear el módulo con `jest.unstable_mockModule`, que ya es el patrón del repo (ver `tests/unit/appLifecycle.bootstrap.test.js`).

Crear `tests/unit/infrastructure/tenantHubspotSeed.service.test.js`:

```js
import { jest } from '@jest/globals';

const mockEnsureObjectProperty = jest.fn(async (_token, field) => ({
  created: true,
  objectType: field.objectType,
  name: field.name,
  property: field,
}));

jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotMetadata.controller.js', () => ({
  ensureObjectProperty: mockEnsureObjectProperty,
  fetchDealPipelines: jest.fn().mockResolvedValue([]),
  fetchDealStages: jest.fn().mockResolvedValue([]),
  fetchOwners: jest.fn().mockResolvedValue([]),
}));

const { seedCreateFieldsHubspot } = await import(
  '../../../src/infrastructure/hubspot/tenantHubspotSeed.service.js'
);

beforeEach(() => {
  mockEnsureObjectProperty.mockClear();
});

function ensuredField(name) {
  const call = mockEnsureObjectProperty.mock.calls.find(([, field]) => field.name === name);
  return call?.[1];
}

describe('seedCreateFieldsHubspot', () => {
  // Sin esta propiedad el asesor no tiene forma de disparar un reenvío: el workflow de
  // reintento se engancha justo al cambio de valor de acá.
  it('crea la propiedad de estado de integración con sus cuatro opciones', async () => {
    await seedCreateFieldsHubspot({ hubspotCredential: { accessToken: 'token-1', _id: 'cred-1' } });

    const field = ensuredField('sap_integration_status');

    expect(field).toMatchObject({
      objectType: 'deal',
      type: 'enumeration',
      fieldType: 'select',
    });
    expect(field.options.map((option) => option.value)).toEqual([
      'completed',
      'error_retry',
      'error_support',
      'retry',
    ]);
  });

  it('sigue creando las propiedades que ya existían', async () => {
    await seedCreateFieldsHubspot({ hubspotCredential: { accessToken: 'token-1', _id: 'cred-1' } });

    expect(ensuredField('sap_docentry')).toBeDefined();
    expect(ensuredField('sap_docnum')).toBeDefined();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- tests/unit/infrastructure/tenantHubspotSeed.service.test.js`

Expected: FAIL en el primer caso (`field` es `undefined`). El segundo pasa.

Si el test falla al importar por el argumento que `seedCreateFieldsHubspot` espera, revisar su firma real en `src/infrastructure/hubspot/tenantHubspotSeed.service.js:127` y ajustar el objeto que se le pasa — el mock de `ensureObjectProperty` no depende de eso.

- [ ] **Step 3: Agregar la propiedad**

En `src/infrastructure/hubspot/tenantHubspotSeed.service.js`, después de `{ objectType: 'deal', label: 'Doc Num SAP', name: 'sap_docnum' }`:

```js
    // El asesor mueve esta propiedad a `retry` para disparar el workflow de reintento; los
    // otros tres valores los escribe el integrador al cerrar el evento. El ciclo cierra solo:
    // el único que devuelve el valor a `error_retry` es quien sabe de verdad que volvió a
    // fallar, así que no puede quedar trabado en un valor que ya no dispara nada.
    //
    // `retry` es el único que el integrador NUNCA escribe.
    {
      objectType: 'deal',
      label: 'Estado integracion SAP',
      name: 'sap_integration_status',
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { label: 'Completado', value: 'completed' },
        { label: 'Error - reintentar', value: 'error_retry' },
        { label: 'Error - revisar con soporte', value: 'error_support' },
        { label: 'Reintentar', value: 'retry' },
      ],
    },
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- tests/unit/infrastructure/tenantHubspotSeed.service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/tenantHubspotSeed.service.js tests/unit/infrastructure/tenantHubspotSeed.service.test.js
git commit -m "feat: seed the SAP integration status deal property"
```

---

## Task 8: Script de migración por tenant

`migrate-mongo` está configurado en el repo pero apunta a **una sola** base (`migrate-mongo-config.cjs` deriva `databaseName` del path del `MONGODB_URI`) y su `migrationsDir` ni existe. Este cambio es por tenant, una base por cliente, así que el patrón correcto es el que ya usan `scripts/migrate-s4-contact-internalcode.mjs` y `scripts/backfill-hubspot-contact-internalcode.mjs`: un `.mjs` con el driver `mongodb`, que recibe el nombre de la base y es dry-run salvo `--apply`.

**Files:**
- Create: `scripts/migrate-webhook-event-dedup-active.mjs`

**Interfaces:**
- Consumes: `DEDUPLICATED_EVENT_TYPES` y `RESENDABLE_STATUS` del Task 2, **importados**, no copiados. La restricción global manda que la lista viva en un solo lugar, y acá se puede cumplir: `webhookEvent.service.js` no tiene ni un `import` propio, así que traerlo a un script no arrastra nada del grafo de módulos, y `package.json` declara `"type": "module"` con `"imports"` nativos que Node resuelve sin bundler.
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: Escribir el script**

Crear `scripts/migrate-webhook-event-dedup-active.mjs`:

```js
// scripts/migrate-webhook-event-dedup-active.mjs
//
// Migración por tenant que habilita el reenvío de webhooks tras un fallo definitivo.
// Hace cuatro cosas, en este orden y no en otro:
//
//   1. Verifica que no exista YA más de un evento no-errored por (eventType, dealId). No
//      debería haberlo, porque el dedup de aplicación bloqueaba cualquier segundo evento,
//      pero un índice único que se crea sobre datos que lo violan falla; mejor reportarlo.
//   2. Backfillea `dedupActive` en los cuatro tipos deduplicados: true si el estado NO es
//      `errored`, false si lo es.
//   3. Crea el índice único parcial nuevo.
//   4. Tumba el índice viejo, que solo cubría createDeal.
//
// El orden importa. Si el índice nuevo se crea antes del backfill, los documentos sin el campo
// quedan fuera del filtro parcial y no hay protección. Si el viejo se tumba antes de que el
// nuevo exista, hay una ventana sin NINGUNA garantía dura sobre createDeal -- y ese flujo no
// escribe SapDocumentLink, así que el índice es su única red contra una orden duplicada en SAP.
// Los pasos 3 y 4 pueden ir en ese orden porque la llave del índice nuevo incluye `dedupActive`
// y es por lo tanto un patrón distinto al del viejo: MongoDB no acepta dos índices con la misma
// llave que difieran solo en el partialFilterExpression.
//
// Es idempotente: se puede correr de nuevo sin efecto.
//
// El nombre de la base es `${TENANT_DB_PREFIX|sap_integration}_${tenantKey}` (ver
// buildTenantDatabaseName en src/infrastructure/database/tenant/tenantDatabase.js).
//
// Uso, un tenant a la vez:
//   node --env-file=.env scripts/migrate-webhook-event-dedup-active.mjs <tenantDbName> [--apply]
//
// Dry run por defecto: sin --apply no se escribe nada.
import { MongoClient } from 'mongodb';
// Importados, NO copiados: la lista de tipos vive en un solo lugar. Se puede importar sin
// arrastrar nada porque webhookEvent.service.js no tiene imports propios; el script sigue sin
// depender del resto del grafo de módulos de src/.
import {
  DEDUPLICATED_EVENT_TYPES as DEDUPLICATED_EVENT_TYPE_SET,
  RESENDABLE_STATUS,
} from '../src/infrastructure/webhook/webhookEvent.service.js';

// updateQuotation no está en el Set: no participa del dedup, así que sus documentos nunca
// llevan `dedupActive` y quedan fuera del índice.
const DEDUPLICATED_EVENT_TYPES = [...DEDUPLICATED_EVENT_TYPE_SET];

const OLD_INDEX_NAME = 'eventType_1_payload.deal.hs_object_id_1';
const NEW_INDEX_NAME = 'eventType_1_payload.deal.hs_object_id_1_dedupActive_1';

const [, , tenantDb, ...flags] = process.argv;
const apply = flags.includes('--apply');
const uri = process.env.MONGODB_URI;

function usage(message) {
  console.error(message);
  console.error('Usage: node --env-file=.env scripts/migrate-webhook-event-dedup-active.mjs <tenantDbName> [--apply]');
  process.exit(1);
}

if (!tenantDb) {
  usage('Missing tenant database name.');
}

// Sin default a localhost: apuntar en silencio a un Mongo local vacío haría que un --apply
// reporte un tranquilizador "0 documentos" mientras el tenant real queda sin migrar.
if (!uri) {
  usage('MONGODB_URI is not set. Export it or run with `node --env-file=.env`.');
}

const client = new MongoClient(uri);
await client.connect();

try {
  const events = client.db(tenantDb).collection('WebhookEvents');

  // --- Paso 1: colisiones ---
  const collisions = await events.aggregate([
    {
      $match: {
        eventType: { $in: DEDUPLICATED_EVENT_TYPES },
        status: { $ne: RESENDABLE_STATUS },
        'payload.deal.hs_object_id': { $exists: true },
      },
    },
    { $group: { _id: { eventType: '$eventType', dealId: '$payload.deal.hs_object_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (collisions.length > 0) {
    console.error(`${tenantDb}: ${collisions.length} colision(es) impiden crear el indice unico.`);
    for (const collision of collisions) {
      console.error(`  ${collision._id.eventType} / deal ${collision._id.dealId}: ${collision.count} eventos abiertos`);
    }
    console.error('Resolver a mano cual evento queda abierto antes de reintentar.');
    process.exit(1);
  }

  console.log(`${tenantDb}: sin colisiones.`);

  // --- Paso 2: backfill ---
  const openFilter = {
    eventType: { $in: DEDUPLICATED_EVENT_TYPES },
    'payload.deal.hs_object_id': { $exists: true },
    status: { $ne: RESENDABLE_STATUS },
  };
  const erroredFilter = {
    eventType: { $in: DEDUPLICATED_EVENT_TYPES },
    'payload.deal.hs_object_id': { $exists: true },
    status: RESENDABLE_STATUS,
  };

  const openCount = await events.countDocuments(openFilter);
  const erroredCount = await events.countDocuments(erroredFilter);
  console.log(`${tenantDb}: ${openCount} evento(s) abierto(s) -> dedupActive true, ${erroredCount} errored -> false`);

  const indexes = await events.indexes();
  const hasOld = indexes.some((index) => index.name === OLD_INDEX_NAME);
  const hasNew = indexes.some((index) => index.name === NEW_INDEX_NAME);
  console.log(`${tenantDb}: indice viejo ${hasOld ? 'presente' : 'ausente'}, indice nuevo ${hasNew ? 'presente' : 'ausente'}`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write.');
  } else {
    await events.updateMany(openFilter, { $set: { dedupActive: true } });
    await events.updateMany(erroredFilter, { $set: { dedupActive: false } });
    console.log('Backfill listo.');

    // --- Paso 3: indice nuevo ---
    if (!hasNew) {
      await events.createIndex(
        { eventType: 1, 'payload.deal.hs_object_id': 1, dedupActive: 1 },
        {
          name: NEW_INDEX_NAME,
          unique: true,
          partialFilterExpression: {
            dedupActive: true,
            'payload.deal.hs_object_id': { $exists: true },
          },
        }
      );
      console.log(`Indice ${NEW_INDEX_NAME} creado.`);
    }

    // --- Paso 4: indice viejo ---
    if (hasOld) {
      await events.dropIndex(OLD_INDEX_NAME);
      console.log(`Indice ${OLD_INDEX_NAME} eliminado.`);
    }
  }
} finally {
  await client.close();
}
```

- [ ] **Step 2: Verificar el script en dry run contra un tenant real**

Run: `node --env-file=.env scripts/migrate-webhook-event-dedup-active.mjs <tenantDbName>`

Expected: reporta "sin colisiones", los dos conteos, y el estado de los dos índices. No escribe nada. Si reporta colisiones, resolverlas a mano antes de seguir: decidir cuál evento queda abierto y pasar los otros a `errored`.

- [ ] **Step 3: Aplicar en un tenant de prueba**

Run: `node --env-file=.env scripts/migrate-webhook-event-dedup-active.mjs <tenantDbName> --apply`

Expected: backfill, índice nuevo creado, índice viejo eliminado.

- [ ] **Step 4: Correr el script una segunda vez para verificar que es idempotente**

Run: `node --env-file=.env scripts/migrate-webhook-event-dedup-active.mjs <tenantDbName> --apply`

Expected: mismos conteos, y reporta el índice viejo como "ausente" y el nuevo como "presente" sin volver a tocarlos.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-webhook-event-dedup-active.mjs
git commit -m "chore: add per-tenant migration for the webhook dedup index"
```

---

## Task 9: Configurar el tenant y el workflow de reintento en HubSpot

No es código, pero sin esto la función no existe para el usuario: el integrador ya sabe publicar el estado y ya acepta el reenvío, pero nadie lo dispara. Va al final porque depende de que la propiedad exista en el portal (Task 7) y de que el integrador escriba los estados (Task 6).

**Files:** ninguno. Configuración en Mongo (documento `Configuration` del tenant) y en el portal de HubSpot.

**Interfaces:**
- Consumes: la propiedad `sap_integration_status` con sus cuatro opciones (Task 7), y las llaves `completed` / `errorRetry` / `errorSupport` que lee `getWebhookFailureNotificationConfig` (Task 4).
- Produces: nada para otras tareas.

- [ ] **Step 1: Verificar que la propiedad se creó en el portal**

Los tenants ya instalados no pasaron por el seed nuevo. Reconectar OAuth para el tenant, o correr el seed a mano, y confirmar en HubSpot que existe `sap_integration_status` en el objeto Deal con las cuatro opciones. `ensureObjectProperty` es idempotente, así que reconectar no duplica nada.

- [ ] **Step 2: Activar la configuración del tenant**

En la base del tenant, en la colección `Configurations`, el documento con `key: 'requireMessageHS'`. Agregar a su `value` (sin tocar los campos que ya tenga):

```json
{
  "integrationStatusProperty": "sap_integration_status",
  "integrationStatusValues": {
    "completed": "completed",
    "errorRetry": "error_retry",
    "errorSupport": "error_support"
  }
}
```

Los tres valores tienen que coincidir exactamente con los `value` de las opciones creadas en el Task 7. Si falta cualquiera de los tres, la función queda apagada por completo y no se escribe nada — ese es el diseño, no un bug.

- [ ] **Step 3: Crear el workflow de reintento**

En HubSpot, un workflow de deals nuevo:

- **Disparador:** `sap_integration_status` es igual a `Reintentar`.
- **Re-enrollment:** activado sobre esa misma propiedad. Sin esto el workflow corre una sola vez por deal y el reenvío funciona una vez y nunca más.
- **Acción:** la misma acción de código personalizado del workflow original — lee los objetos ligados al deal y hace el fetch al API. Como el payload se arma de cero en cada corrida, la data corregida llega sola; no hay que tocar ese código.

El workflow **no** escribe la propiedad. El integrador la mueve a `Completado` o de vuelta a `Error - reintentar` según cómo cierre el evento, y ese es el único que sabe de verdad qué pasó.

- [ ] **Step 4: Verificar el ciclo con un deal de prueba**

Cubierto por la prueba manual de la Verificación final.

---

## Verificación final

- [ ] **Suite completa**

Run: `npm test`

Expected: PASS salvo los fallos de base conocidos del repo. Si el total de suites salta de ~160 a ~620, jest está levantando también los tests de `.claude/worktrees/`: correr con rutas explícitas o desde el worktree que corresponda antes de culpar a este cambio.

- [ ] **Prueba manual del ciclo completo**

1. Configurar en el tenant el documento `Configuration` con `key: 'requireMessageHS'` y `value.integrationStatusProperty: 'sap_integration_status'` más los tres valores.
2. Provocar un fallo de SAP en un deal (por ejemplo un mapeo que SAP rechace), disparar el webhook y correr `POST /sap-sync/runWebHook`.
3. Verificar en Mongo que el evento quedó `errored` con `dedupActive: false`, y en HubSpot que la propiedad dice `error_retry` y que está la nota con el error.
4. Corregir la data en HubSpot y volver a disparar el webhook. Verificar que se insertó un evento **nuevo** en `waiting` con `dedupActive: true`, y que el viejo sigue ahí en `errored`.
5. Correr `POST /sap-sync/runWebHook`. Verificar que el documento se creó en SAP y que la propiedad dice `completed`.
6. Volver a disparar el webhook sobre el mismo deal. Verificar que la respuesta es 200, que **no** se insertó ningún evento, que no hay nota nueva y que la propiedad no cambió.

- [ ] **Verificar la creación de la propiedad en un portal real**

La lista `groupByObjectType` del seed no tiene entrada para `deal`, así que la propiedad se crea con `groupName: 'contactinformation'`, igual que `sap_docentry` y `sap_docnum` hoy. Confirmar en el portal que la propiedad quedó creada y visible en la ficha del deal. Si HubSpot rechaza el grupo para objetos de tipo deal, es un problema preexistente del seed y hay que abrirlo aparte, no parchearlo dentro de esta tarea.
