# Comments sin default, NumAtCard por FieldMapping y facturas por linaje SAP — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `Comments` y `NumAtCard` de los documentos de SAP salgan exclusivamente del FieldMapping del tenant —nunca de un literal del integrador— y que la reconciliación de facturas encuentre el negocio de HubSpot por el linaje de SAP (`DocumentLines[].BaseEntry` con `BaseType 17`) en vez de parsear el prefijo `HS-DEAL-`.

**Architecture:** `buildOrderFromQuotationPayload` deja de ser el único builder que no derrama los campos mapeados, con lo que `Comments` y `NumAtCard` pasan a llegar por el mismo mecanismo genérico que ya usan los otros dos builders; se eliminan los parámetros que se aplicaban después del derrame y le ganaban al mapeo. El reconciliador de facturas cambia de "parsear `NumAtCard`" a "resolver el `DocEntry` de la orden desde las líneas de la factura y buscar el `SapDocumentLink` por ese `sapDocEntry`", que no requiere campo nuevo ni backfill porque `sapDocEntry` se guardó desde siempre.

**Tech Stack:** Node.js ESM, Jest (con `--experimental-vm-modules`), Mongoose, SAP B1 Service Layer (OData v2 en `/b1s/v2`), HubSpot CRM v3.

**Spec:** `docs/superpowers/specs/2026-08-19-comments-numatcard-invoice-lineage-design.md`

## Global Constraints

- **Correr jest siempre con path explícito**, nunca la suite completa desde la raíz: la raíz levanta también las suites de los worktrees (~620 en vez de ~160) y produce fallos ajenos al cambio. Comando: `NODE_OPTIONS=--experimental-vm-modules npx jest <ruta> -t "<nombre>"` desde la raíz del repo, usando la herramienta Bash (el prefijo de variable de entorno no funciona en PowerShell).
- **Trabajar en el checkout principal, nunca en un worktree.** Rama actual: `fix/comments-numatcard-invoice-lineage` (ya creada, ya tiene los commits del spec).
- **No sembrar mapeos por defecto nuevos.** El nombre de la propiedad de HubSpot es específico del tenant; sembrarlo para todos crea mapeos muertos en el admin.
- **Códigos de `SKIP_REASONS` estables.** Viajan al `SyncLog` y quedan guardados en Mongo: no renombrar los existentes, sólo agregar. `NO_DEAL_IN_NUM_AT_CARD` se conserva declarado como histórico aunque deje de emitirse.
- **`buildOrderPayload` NO se toca.** Conserva su parámetro `comments`: `amc` y `noelito` no tienen mapeo de `Comments` y ese parámetro es su única fuente. Noelito lleva 102 eventos `createDeal`.
- **`buildQuotationPayload` conserva su parámetro `comments`.** Sólo pierde `numAtCard`. Quitar `comments` desincronizaría crear cotización de actualizar cotización, que lee `deal?.comments` directo para su PATCH.

## Hechos verificados que el plan da por ciertos

Verificados leyendo código y sondeando producción el 2026-08-19. Si alguno resulta falso al implementar, **parar y reportar** en vez de improvisar:

- `rawSapData` es el registro crudo completo de SAP, adjuntado sin condiciones para todo `objectType` en `SyncSapConfigToHubspot.js:185-188` (`rawSapData: rawData?.[index] ?? null`). No lo pone un enricher. Con `DocumentLines` en el `$select`, `item.rawSapData.DocumentLines` existe.
- `$select` acepta `DocumentLines` en `Invoices` del Service Layer; no hace falta `$expand`.
- Las facturas de Distelsa traen `BaseType: 17` en sus líneas, y repiten el mismo `BaseEntry` varias veces (la factura 1024440 lo trae tres veces).
- `pickMappedHeaderFields` (`order-builder.service.js:69`) excluye sólo `CardCode`, `DocDueDate`, `DocumentLines` y `PaymentGroupCode`. Ni `Comments` ni `NumAtCard` están reservados.
- `mapHubspotToSapFields` (`order-builder.service.js:20`) descarta `null`, `undefined` y `''`, así que una propiedad ausente no produce la clave.
- `mongoose.createConnection` va con `autoIndex` por defecto (`tenantDatabase.js:38`): el índice nuevo se crea solo en los cuatro tenants, sin migración.

---

### Task 1: `buildOrderFromQuotationPayload` derrama los campos mapeados

**Files:**
- Modify: `src/domain/orders/order-builder.service.js:443-500`
- Test: `tests/unit/domain/quotationBuilder.test.js` (describe `buildOrderFromQuotationPayload`, ~línea 148)

**Interfaces:**
- Consumes: `pickMappedHeaderFields(mappedDealFields, { documentLineCount })` y `resolveDocDueDate({ mappedDeal })`, ya existentes en el mismo archivo.
- Produces: `buildOrderFromQuotationPayload({ cardCode, baseEntry, baseLines, slpCode, mappedDealFields })` — **sin** los parámetros `numAtCard` ni `comments`. Task 2 depende de esta firma.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar dentro del `describe('order-builder.service buildOrderFromQuotationPayload', ...)` existente en `tests/unit/domain/quotationBuilder.test.js`:

```javascript
  it('derrama los campos mapeados del contexto orders-quotations en la cabecera', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
      mappedDealFields: { NumAtCard: 'OC #P06485', Comments: 'Comentario del comprador' },
    });

    expect(payload.NumAtCard).toBe('OC #P06485');
    expect(payload.Comments).toBe('Comentario del comprador');
  });

  // La regla que pidió el cliente: sin valor en HubSpot, el campo no viaja y SAP lo deja nulo.
  // Nunca un default del integrador.
  it('no inventa NumAtCard ni Comments cuando el mapeo no produjo valores', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
    });

    expect(payload).not.toHaveProperty('NumAtCard');
    expect(payload).not.toHaveProperty('Comments');
  });

  it('no deja que el derrame pise lo que el builder posee', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
      mappedDealFields: {
        CardCode: 'HACKED',
        DocumentLines: [{ ItemCode: 'X' }],
        DocDueDate: '2026-07-21',
      },
    });

    expect(payload.CardCode).toBe('CL00129');
    expect(payload.DocumentLines).toEqual([{ BaseType: 23, BaseEntry: 12345, BaseLine: 0 }]);
    expect(payload.DocDueDate).toBe('2026-07-21');
  });
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/quotationBuilder.test.js -t "derrama los campos mapeados"
```

Esperado: FAIL. `payload.NumAtCard` es `undefined` porque hoy el builder no derrama `mappedDealFields`.

- [ ] **Step 3: Implementar el derrame**

En `src/domain/orders/order-builder.service.js`, reemplazar el comentario y la firma de `buildOrderFromQuotationPayload`:

```javascript
// La cabecera la copia SAP de la cotización base, así que aquí sólo viajan los campos que el
// tenant mapeó en el contexto deal/orders-quotations. Ese derrame es la ÚNICA fuente de
// NumAtCard, Comments y de cualquier campo extra que el workflow de HubSpot agregue después.
//
// No hay parámetros numAtCard/comments a propósito: un parámetro se aplica DESPUÉS del derrame
// y por lo tanto le gana al mapeo. Eso es exactamente lo que hacía que este builder mandara un
// literal del integrador en Comments y un HS-DEAL-<dealId> fabricado en NumAtCard.
export function buildOrderFromQuotationPayload({
  cardCode,
  baseEntry,
  baseLines,
  slpCode = null,
  mappedDealFields = {},
}) {
```

Y reemplazar la construcción del payload y todo lo que sigue hasta el `return`:

```javascript
  const payload = {
    ...pickMappedHeaderFields(mappedDealFields, { documentLineCount: documentLines.length }),
    CardCode: cardCode,
    DocDueDate: resolveDocDueDate({ mappedDeal: mappedDealFields }),
    DocumentLines: documentLines,
  };

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
  }

  return payload;
}
```

Esto borra los dos bloques `resolvedNumAtCard` / `resolvedComments` que había al final de la función. El derrame va primero para que `CardCode`, `DocDueDate` y `DocumentLines` ganen; `pickMappedHeaderFields` además ya los excluye.

- [ ] **Step 4: Correr el archivo completo de tests del builder**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/quotationBuilder.test.js
```

Esperado: PASS, incluidos los tests preexistentes de `DocDueDate`, `baseEntry` inválido y líneas base vacías.

- [ ] **Step 5: Correr el otro archivo que ejercita este builder**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/orderBuilder.test.js
```

Esperado: PASS. En particular el test `never emits PaymentGroupCode when converting a quotation to an order` (`orderBuilder.test.js:638`) sigue pasando porque `PaymentGroupCode` está en `RESERVED_HEADER_FIELDS` y el derrame lo excluye.

- [ ] **Step 6: Commit**

```bash
git add src/domain/orders/order-builder.service.js tests/unit/domain/quotationBuilder.test.js
git commit -m "feat: derramar los campos mapeados en la orden creada desde cotizacion

Era el unico de los tres builders que no derramaba mappedDealFields, asi que
NumAtCard y Comments solo podian llegar por parametros explicitos que se aplican
despues del derrame y le ganan al mapeo. Se eliminan esos parametros.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `ProcessHubspotConvertQuotationToOrder` deja de fabricar `Comments` y `NumAtCard`

**Files:**
- Modify: `src/application/use-cases/ProcessHubspotConvertQuotationToOrder.js:1-14` (imports) y `:112-119` (llamada al builder)
- Test: `tests/unit/application/processQuotationFlows.test.js` (describe `ProcessHubspotConvertQuotationToOrder`, ~línea 635)

**Interfaces:**
- Consumes: `buildOrderFromQuotationPayload({ cardCode, baseEntry, baseLines, slpCode, mappedDealFields })` de Task 1.
- Produces: nada nuevo. `buildDealNumAtCard` deja de importarse aquí (Task 3 lo borra del módulo).

- [ ] **Step 1: Escribir los tests que fallan**

Agregar dentro del `describe('ProcessHubspotConvertQuotationToOrder', ...)` en `tests/unit/application/processQuotationFlows.test.js`. El helper `buildDeps()` y la constante `convertEvent` ya existen en ese describe:

```javascript
  // El bug reportado por el cliente: la orden llevaba un literal del integrador en Comments
  // y un HS-DEAL-<dealId> fabricado en NumAtCard.
  it('no manda un Comments default ni un NumAtCard fabricado', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    await useCase.execute({ event: convertEvent, tenantModels });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload).not.toHaveProperty('Comments');
    expect(orderPayload).not.toHaveProperty('NumAtCard');
  });

  it('toma Comments y NumAtCard del FieldMapping del contexto orders-quotations', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
      { sourceField: 'NumAtCard', targetField: 'orden_de_compra' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const event = {
      ...convertEvent,
      payload: {
        ...convertEvent.payload,
        deal: {
          hs_object_id: '59680314911',
          comments: 'Comentario real del comprador',
          orden_de_compra: 'OC #P06485',
        },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload.Comments).toBe('Comentario real del comprador');
    expect(orderPayload.NumAtCard).toBe('OC #P06485');
  });
```

`buildContext()` y `buildRuntimeRepository(context)` están definidos arriba en ese mismo archivo (líneas ~11 y ~38) y ya se usan con este idioma en los tests de `PaymentGroupCode` (línea 165) y `CardName` (línea 189).

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js -t "no manda un Comments default"
```

Esperado: FAIL. `orderPayload.Comments` es `'Pedido creado desde oferta SAP por etapa Orden de Compra en HubSpot'`.

- [ ] **Step 3: Quitar el literal y la fabricación del código**

En `src/application/use-cases/ProcessHubspotConvertQuotationToOrder.js`, reemplazar la llamada al builder (líneas 112-119):

```javascript
      const orderPayload = buildOrderFromQuotationPayload({
        cardCode,
        baseEntry: quotationLink.sapDocEntry,
        baseLines: quotationLink.lines,
        slpCode,
        mappedDealFields: mappedDeal,
      });
```

Y quitar `buildDealNumAtCard,` de la lista de imports desde `./webhookQuotationSupport.js` (línea 9), dejando:

```javascript
import {
  createDocumentAuditTrail,
  mergeHubspotResponses,
  resolveDocumentSlpCode,
} from './webhookQuotationSupport.js';
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/application/processQuotationFlows.test.js
```

Esperado: PASS el archivo completo. Los tests preexistentes del convert (`creates an order from the quotation using BaseType/BaseEntry/BaseLine`, idempotencia) no tocan `Comments` ni `NumAtCard`, así que no deberían cambiar.

- [ ] **Step 5: Commit**

```bash
git add src/application/use-cases/ProcessHubspotConvertQuotationToOrder.js tests/unit/application/processQuotationFlows.test.js
git commit -m "fix: la orden desde cotizacion ya no manda un Comments default ni un NumAtCard fabricado

Confirmado en produccion: la orden DocEntry 28987 de SBO_DISTELSA_PROD tenia
Comments con el literal del integrador y NumAtCard con HS-DEAL-64175519381.
Ahora los dos salen del FieldMapping del tenant, o no viajan.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: eliminar `buildDealNumAtCard` y el parámetro `numAtCard` de la cotización

**Files:**
- Modify: `src/domain/orders/order-builder.service.js:405-443` (firma y cuerpo de `buildQuotationPayload`)
- Modify: `src/application/use-cases/ProcessHubspotCreateQuotation.js:1-14` (imports) y `:165-173` (llamada al builder)
- Modify: `src/application/use-cases/webhookQuotationSupport.js:378-382` (borrar la función)
- Test: `tests/unit/domain/quotationBuilder.test.js:10-44`

**Interfaces:**
- Produces: `buildQuotationPayload({ cardCode, documentLines, slpCode, paymentGroupCode, mappedDealFields, comments })` — **sin** `numAtCard`, **con** `comments`.
- `buildDealNumAtCard` deja de existir. Verificar antes de borrar que no queda ningún import: los únicos eran `ProcessHubspotCreateQuotation.js:12` y `ProcessHubspotConvertQuotationToOrder.js:9` (este último ya lo quitó Task 2).

- [ ] **Step 1: Escribir el test que fija el comportamiento nuevo**

En `tests/unit/domain/quotationBuilder.test.js`, **reemplazar** el primer test del describe `buildQuotationPayload` (líneas 11-27, el que pasa `numAtCard: 'HS-DEAL-123'`) por estos dos:

```javascript
  it('builds a Quotation payload with Comments and SalesPersonCode', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      slpCode: 5,
      comments: 'Oferta creada desde HubSpot',
    });

    expect(payload).toMatchObject({
      CardCode: 'CL00129',
      Comments: 'Oferta creada desde HubSpot',
      SalesPersonCode: 5,
      DocumentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });
    expect(payload.DocDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // Printer mapea NumAtCard <- hs_object_id y hoy recibe HS-DEAL-<id> porque el parametro
  // explicito le gana al mapeo. Este test fija que reciba el valor mapeado tal cual.
  it('toma NumAtCard del mapeo, sin prefijo ni parametro que lo pise', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      mappedDealFields: { NumAtCard: '64175519381' },
    });

    expect(payload.NumAtCard).toBe('64175519381');
  });

  it('no agrega NumAtCard cuando el mapeo no produjo valor', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });

    expect(payload).not.toHaveProperty('NumAtCard');
  });
```

Y agregar este test al final del mismo archivo, en un describe propio. Protege a `amc` y `noelito`,
que no tienen mapeo de `Comments` y dependen del parámetro de `buildOrderPayload` como única
fuente — noelito lleva 102 eventos `createDeal`. Sin este test, un refactor futuro lo elimina
"por simetría" con los otros dos builders y les borra los comentarios en silencio:

```javascript
describe('order-builder.service buildOrderPayload conserva su parametro comments', () => {
  // amc y noelito NO tienen mapeo de Comments en deal/orders-quotations: para ellos este
  // parametro es la unica fuente del campo. No unificarlo con el derrame de los otros builders.
  it('manda Comments desde el parametro aunque no haya ningun campo mapeado', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      mappedDealFields: {},
      comments: 'Comentario del negocio en HubSpot',
    });

    expect(payload.Comments).toBe('Comentario del negocio en HubSpot');
  });

  it('no manda Comments cuando el negocio no trae ninguno', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });

    expect(payload).not.toHaveProperty('Comments');
  });
});
```

`buildOrderPayload` ya está importado en la cabecera de `quotationBuilder.test.js` (línea 4), así
que no hay que tocar los imports.

- [ ] **Step 2: Establecer la línea base verde**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/quotationBuilder.test.js
```

Esperado: **PASS**, y eso es correcto — esta tarea no es TDD, es una eliminación. El derrame de
`buildQuotationPayload` ya funciona hoy, así que los tests nuevos pasan antes y después; lo que se
está quitando es la puerta trasera que lo pisaba.

Es importante entender por qué no hay un test que falle primero: con el parámetro eliminado, un
llamador que pasara `numAtCard: 'X'` simplemente sería ignorado por JavaScript, sin error. No
existe una aserción que distinga "el parámetro no existe" de "el parámetro existe pero nadie lo
usa". La red de seguridad de esta tarea son otras dos cosas: el `grep` del Step 4 que prueba que
nadie llama a `buildDealNumAtCard`, y la suite completa verde del Step 5. Si al llegar al Step 2 el
archivo **no** pasa, parar: significa que el Step 1 quedó mal aplicado.

- [ ] **Step 3: Quitar el parámetro del builder**

En `src/domain/orders/order-builder.service.js`, en `buildQuotationPayload`: borrar la línea `numAtCard = null,` de la firma, y borrar este bloque del cuerpo:

```javascript
  const resolvedNumAtCard = toNonEmptyString(numAtCard);
  if (resolvedNumAtCard) {
    payload.NumAtCard = resolvedNumAtCard;
  }
```

**No tocar** el bloque de `resolvedComments` que viene justo después: el parámetro `comments` se conserva.

- [ ] **Step 4: Quitar la fabricación del use case y borrar la función**

En `src/application/use-cases/ProcessHubspotCreateQuotation.js`, borrar la línea `numAtCard: buildDealNumAtCard(dealId),` (línea 171) de la llamada a `buildQuotationPayload`, y quitar `buildDealNumAtCard,` de los imports (línea 12).

En `src/application/use-cases/webhookQuotationSupport.js`, borrar la función completa (líneas 378-382):

```javascript
export function buildDealNumAtCard(dealId) {
  const normalized = toNonEmptyString(dealId);
  return normalized ? `HS-DEAL-${normalized}` : null;
}
```

Antes de borrar, confirmar que no queda ningún consumidor:

```bash
grep -rn "buildDealNumAtCard" src/ tests/
```

Esperado: sin resultados.

- [ ] **Step 5: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain/quotationBuilder.test.js tests/unit/domain/orderBuilder.test.js tests/unit/application/processQuotationFlows.test.js
```

Esperado: PASS los tres. Los tests `forwards deal.comments as the quotation Comments when provided` (`processQuotationFlows.test.js:248`) y `omits Comments on the quotation when the deal has no comments` (`:266`) deben seguir pasando sin cambios, porque el parámetro `comments` se conservó.

- [ ] **Step 6: Commit**

```bash
git add src/domain/orders/order-builder.service.js src/application/use-cases/ProcessHubspotCreateQuotation.js src/application/use-cases/webhookQuotationSupport.js tests/unit/domain/quotationBuilder.test.js
git commit -m "fix: eliminar HS-DEAL-<dealId> fabricado en NumAtCard

El parametro numAtCard de buildQuotationPayload se aplicaba despues del derrame
de campos mapeados, asi que le ganaba al mapeo: printer configuro
NumAtCard <- hs_object_id y venia recibiendo HS-DEAL-<id>. Ahora NumAtCard tiene
una sola fuente en los tres builders, el FieldMapping.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `DocumentLines` como campo estructural del `$select` de facturas

**Files:**
- Modify: `src/infrastructure/sap/serviceLayerUrlBuilder.js:49-70` (agregar el mecanismo) y `:154-160` (usarlo)
- Create: `tests/unit/infrastructure/serviceLayerUrlBuilderInvoice.test.js`

**Interfaces:**
- Produces: `buildServiceLayerUrl(clientConfig, mappings, options)` agrega `DocumentLines` al `$select` cuando `clientConfig.objectType === 'invoice'`. Task 6 depende de que ese campo llegue a `rawSapData`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/infrastructure/serviceLayerUrlBuilderInvoice.test.js`:

```javascript
import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

describe('buildServiceLayerUrl — DocumentLines obligatorio en facturas', () => {
  const invoiceConfig = {
    serviceLayerBaseUrl: 'https://sap.example.com',
    serviceLayerPath: '/Invoices',
    objectType: 'invoice',
    integrationModeName: 'SERVICE_LAYER',
  };

  const invoiceMappings = [
    { sourceField: 'NumAtCard', sourceContext: 'businessPartner' },
    { sourceField: 'DocNum', sourceContext: 'businessPartner' },
  ];

  // La reconciliacion resuelve el negocio por DocumentLines[].BaseEntry. Si el campo
  // dependiera de una fila del admin, un tenant que la borre romperia la tarea en silencio.
  it('agrega DocumentLines al $select aunque ningun mapping lo pida', () => {
    const url = buildServiceLayerUrl(invoiceConfig, invoiceMappings);

    expect(url).toContain('DocumentLines');
    expect(url).toContain('NumAtCard');
  });

  it('no duplica DocumentLines si además viene como mapping', () => {
    const url = buildServiceLayerUrl(invoiceConfig, [
      ...invoiceMappings,
      { sourceField: 'DocumentLines', sourceContext: 'businessPartner' },
    ]);

    const select = decodeURIComponent(url.split('$select=')[1].split('&')[0]);
    const ocurrencias = select.split(',').filter((field) => field === 'DocumentLines');
    expect(ocurrencias).toHaveLength(1);
  });

  it('no agrega DocumentLines para otros objectType', () => {
    const url = buildServiceLayerUrl(
      { ...invoiceConfig, objectType: 'company', serviceLayerPath: '/BusinessPartners' },
      [{ sourceField: 'CardCode', sourceContext: 'businessPartner' }]
    );

    expect(url).not.toContain('DocumentLines');
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/serviceLayerUrlBuilderInvoice.test.js
```

Esperado: FAIL en el primer test — el `$select` sólo lleva `NumAtCard,DocNum`.

- [ ] **Step 3: Implementar el mecanismo de campos obligatorios**

En `src/infrastructure/sap/serviceLayerUrlBuilder.js`, agregar justo después de `getAdditionalFieldsByObjectType` (que termina en la línea ~70):

```javascript
// Campos que una tarea necesita por diseño, y que por eso NO viajan como FieldMapping: si
// dependieran de una fila del admin, un tenant que la borre rompería la tarea en silencio.
//
// La reconciliación de facturas resuelve el negocio de HubSpot por el linaje de SAP
// (DocumentLines[].BaseEntry con BaseType 17 apuntando al DocEntry de la orden), así que sin
// DocumentLines no puede identificar ninguna orden y descartaría todas las facturas.
const requiredFieldsByObjectType = {
  invoice: ['DocumentLines'],
};

function getRequiredFieldsByObjectType(objectType) {
  return requiredFieldsByObjectType[objectType] ?? [];
}
```

Y en `buildServiceLayerUrl`, reemplazar el armado de `mergedSelectFields`:

```javascript
  const selectFields = sanitizeSelectFields(mappings);
  const additionalFields = getAdditionalFieldsByObjectType(clientConfig?.objectType);
  const requiredFields = getRequiredFieldsByObjectType(clientConfig?.objectType);
  const mergedSelectFields = Array.from(new Set([
    ...selectFields,
    ...additionalFields,
    ...requiredFields,
  ]));
```

El `Set` es el que resuelve la deduplicación del segundo test.

- [ ] **Step 4: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/serviceLayerUrlBuilderInvoice.test.js tests/unit/infrastructure/serviceLayerUrlBuilderBpAddress.test.js
```

Esperado: PASS los dos archivos.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sap/serviceLayerUrlBuilder.js tests/unit/infrastructure/serviceLayerUrlBuilderInvoice.test.js
git commit -m "feat: DocumentLines obligatorio en el \$select de facturas

Va como campo estructural por objectType y no como FieldMapping: la
reconciliacion lo requiere, y si dependiera de una fila del admin un tenant que
la borre romperia el sync de facturas sin ningun error visible.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: buscar el link de la orden por su `sapDocEntry`

**Files:**
- Modify: `src/infrastructure/database/models/tenant/SapDocumentLink.js:62-69` (agregar índice después del único existente)
- Modify: `src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js:1-14` (agregar método)
- Create: `tests/unit/infrastructure/mongooseSapDocumentLinkRepository.test.js`

**Interfaces:**
- Produces: `findByOrderDocEntry({ SapDocumentLink, hubspotCredentialId, sapDocEntry })` → el documento del link (`lean`) o `null`. Filtra por `documentType: 'order'` internamente. Task 6 lo consume.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/infrastructure/mongooseSapDocumentLinkRepository.test.js`:

```javascript
import { jest } from '@jest/globals';
import MongooseSapDocumentLinkRepository from '../../../src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';

describe('MongooseSapDocumentLinkRepository.findByOrderDocEntry', () => {
  const repository = new MongooseSapDocumentLinkRepository();

  function buildModel(result) {
    const lean = jest.fn().mockResolvedValue(result);
    const findOne = jest.fn().mockReturnValue({ lean });
    return { model: { findOne }, findOne, lean };
  }

  it('busca el link de la orden por hubspotCredentialId, documentType y sapDocEntry', async () => {
    const { model, findOne } = buildModel({ dealId: '64175519381' });

    const link = await repository.findByOrderDocEntry({
      SapDocumentLink: model,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: 28987,
    });

    expect(findOne).toHaveBeenCalledWith({
      hubspotCredentialId: 'cred-1',
      documentType: 'order',
      sapDocEntry: 28987,
    });
    expect(link).toEqual({ dealId: '64175519381' });
  });

  // Un BaseEntry basura no debe convertirse en una consulta con sapDocEntry: NaN, que en
  // Mongo no matchea nada pero recorre el indice igual.
  it('devuelve null sin consultar cuando el sapDocEntry no es un entero', async () => {
    const { model, findOne } = buildModel({ dealId: 'x' });

    await expect(repository.findByOrderDocEntry({
      SapDocumentLink: model,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: Number.NaN,
    })).resolves.toBeNull();

    expect(findOne).not.toHaveBeenCalled();
  });

  it('devuelve null sin consultar cuando no hay modelo', async () => {
    await expect(repository.findByOrderDocEntry({
      SapDocumentLink: null,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: 1,
    })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/mongooseSapDocumentLinkRepository.test.js
```

Esperado: FAIL con `repository.findByOrderDocEntry is not a function`.

- [ ] **Step 3: Implementar el método**

En `src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js`, agregar después de `findByDeal`:

```javascript
  // Entrada de la reconciliación de facturas: la factura trae el DocEntry de su orden en
  // DocumentLines[].BaseEntry, y desde el link se llega al dealId. documentType va fijo en
  // 'order' porque los DocEntry de SAP son secuencias por objeto: sin ese filtro, el DocEntry
  // 500 de una cotización matchearía con la orden 500, que es otro documento.
  async findByOrderDocEntry({ SapDocumentLink, hubspotCredentialId, sapDocEntry }) {
    if (!SapDocumentLink || !Number.isInteger(sapDocEntry)) {
      return null;
    }

    const query = SapDocumentLink.findOne({
      hubspotCredentialId,
      documentType: 'order',
      sapDocEntry,
    });

    return typeof query?.lean === 'function' ? query.lean() : query;
  }
```

- [ ] **Step 4: Agregar el índice**

En `src/infrastructure/database/models/tenant/SapDocumentLink.js`, después del índice único existente (que termina en la línea ~69):

```javascript
// Entrada de la reconciliación de facturas por linaje SAP. No es único: nada impide dos links
// apuntando al mismo DocEntry si algo se reprocesa, y un índice único ahí rechazaría la
// escritura en vez de dejar que el reconciliador decida.
//
// No necesita backfill: sapDocEntry se escribe desde que existe la colección, así que el
// índice cubre los links que ya están en producción. autoIndex está activo en
// mongoose.createConnection (tenantDatabase.js:38), así que se crea solo en los cuatro tenants.
sapDocumentLinkSchema.index({
  hubspotCredentialId: 1,
  documentType: 1,
  sapDocEntry: 1,
});
```

- [ ] **Step 5: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/mongooseSapDocumentLinkRepository.test.js
```

Esperado: PASS los tres tests.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js src/infrastructure/database/models/tenant/SapDocumentLink.js tests/unit/infrastructure/mongooseSapDocumentLinkRepository.test.js
git commit -m "feat: findByOrderDocEntry para resolver el link de la orden por su DocEntry

Sin campo nuevo ni backfill: sapDocEntry se guarda desde siempre, asi que el
indice nuevo cubre los links que ya estan en produccion.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `extractOrderBaseEntries` y los códigos de descarte (aditiva)

**Esta tarea es puramente aditiva. NO borres nada.** `extractDealId`, la constante `DEAL_PREFIX` y
el cuerpo actual de `process` se quedan exactamente como están: el `process` viejo llama a
`extractDealId`, así que borrarlo aquí dejaría el fuente roto y toda la suite del archivo en rojo
hasta la Task 7. El borrado y la reescritura van juntos en la Task 7, para que cada commit quede
verde. Si te encontrás borrando código en esta tarea, parate.

**Files:**
- Modify: `src/infrastructure/hubspot/handlers/invoice.handler.js` — agregar `ORDER_BASE_TYPE` y `extractOrderBaseEntries`, agregar dos claves a `SKIP_REASONS`, agregar la función al `export default`
- Test: `tests/unit/infrastructure/invoiceHandler.test.js` (agregar un describe nuevo al final; el `await import` de la cabecera suma la función nueva)

**Interfaces:**
- Produces: `extractOrderBaseEntries(documentLines)` → array de `DocEntry` de órdenes, enteros y sin repetir. `SKIP_REASONS.NO_ORDER_BASE_ENTRY`. Task 7 los consume.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tests/unit/infrastructure/invoiceHandler.test.js` un describe nuevo. El `await import(...)` del principio del archivo hay que ampliarlo para traer la función:

```javascript
const { process: processInvoice, extractOrderBaseEntries, SKIP_REASONS } = await import(
  '../../../src/infrastructure/hubspot/handlers/invoice.handler.js'
);
```

Y el describe:

```javascript
describe('invoice.handler extractOrderBaseEntries', () => {
  // Verificado en SBO_DISTELSA_PROD: la factura 1024440 trae el mismo BaseEntry en sus tres
  // lineas. Sin deduplicar, el reconciliador movería el mismo negocio tres veces.
  it('deduplica el mismo BaseEntry repetido en varias lineas', () => {
    expect(extractOrderBaseEntries([
      { BaseType: 17, BaseEntry: 28967 },
      { BaseType: 17, BaseEntry: 28967 },
      { BaseType: 17, BaseEntry: 28967 },
    ])).toEqual([28967]);
  });

  // Los DocEntry de SAP son secuencias por objeto: la cotizacion 500 y la orden 500 coexisten.
  // Sin este filtro, una factura copiada de una cotizacion moveria el negocio de otra orden.
  it('descarta las lineas que no vienen de una orden', () => {
    expect(extractOrderBaseEntries([
      { BaseType: 23, BaseEntry: 55410 },
      { BaseType: 17, BaseEntry: 28987 },
      { BaseType: 13, BaseEntry: 999 },
    ])).toEqual([28987]);
  });

  it('devuelve varios BaseEntry cuando la factura consolida ordenes distintas', () => {
    expect(extractOrderBaseEntries([
      { BaseType: 17, BaseEntry: 28987 },
      { BaseType: 17, BaseEntry: 28991 },
    ])).toEqual([28987, 28991]);
  });

  it('devuelve un array vacio para entradas sin lineas de orden', () => {
    expect(extractOrderBaseEntries(null)).toEqual([]);
    expect(extractOrderBaseEntries(undefined)).toEqual([]);
    expect(extractOrderBaseEntries('no es un array')).toEqual([]);
    expect(extractOrderBaseEntries([])).toEqual([]);
    expect(extractOrderBaseEntries([{ BaseType: 17, BaseEntry: null }])).toEqual([]);
    expect(extractOrderBaseEntries([{ BaseType: 17 }])).toEqual([]);
    expect(extractOrderBaseEntries([{ BaseType: 17, BaseEntry: 'abc' }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/invoiceHandler.test.js -t "extractOrderBaseEntries"
```

Esperado: FAIL con `extractOrderBaseEntries is not a function`.

- [ ] **Step 3: Agregar la constante, la función y las dos claves nuevas**

En `src/infrastructure/hubspot/handlers/invoice.handler.js`:

**3a.** Agregar la constante junto a `DEAL_PREFIX` (que se queda donde está):

```javascript
// BoObjectTypes.oOrders. Una factura copiada de un pedido pone este BaseType en cada linea que
// arrastra. Filtrar por el NO es opcional: los DocEntry de SAP son secuencias por objeto, asi
// que la cotizacion 500 y la orden 500 coexisten, y sin el filtro una factura copiada de una
// cotizacion haria match con una orden ajena que tenga ese DocEntry.
const ORDER_BASE_TYPE = 17;
```

**3b.** Agregar **dos claves** al objeto `SKIP_REASONS` existente, sin tocar las tres que ya están
(`NO_DEAL_IN_NUM_AT_CARD`, `ORDER_LINK_NOT_FOUND`, `UPDATE_DEAL_STAGE_DISABLED` siguen ahí; el
`process` viejo y los tests viejos las usan todavía):

```javascript
  NO_ORDER_BASE_ENTRY: 'no_order_base_entry',
```

`ORDER_LINK_NOT_FOUND` ya existe con el valor correcto, así que no hay que agregarla. El comentario
de "histórico" sobre `NO_DEAL_IN_NUM_AT_CARD` lo pone la Task 7, cuando efectivamente deje de
emitirse.

**3c.** Agregar la función después de `extractDealId`, que **se queda**:

```javascript
/**
 * Devuelve los DocEntry de las órdenes que originaron esta factura, sin repetir. Una factura
 * real repite el mismo BaseEntry en cada una de sus líneas (verificado en SBO_DISTELSA_PROD:
 * la factura 1024440 lo trae tres veces), así que deduplicar es obligatorio y no defensivo.
 */
export function extractOrderBaseEntries(documentLines) {
  const lines = Array.isArray(documentLines) ? documentLines : [];
  const baseEntries = new Set();

  for (const line of lines) {
    if (Number(line?.BaseType) !== ORDER_BASE_TYPE) {
      continue;
    }

    // `Number(null)` es 0, y 0 es entero: sin este descarte explícito una línea con
    // BaseEntry null entraría al Set como el DocEntry 0 y buscaría un link inexistente.
    const rawBaseEntry = line?.BaseEntry;
    if (rawBaseEntry === null || typeof rawBaseEntry === 'undefined' || rawBaseEntry === '') {
      continue;
    }

    const baseEntry = Number(rawBaseEntry);
    if (Number.isInteger(baseEntry)) {
      baseEntries.add(baseEntry);
    }
  }

  return Array.from(baseEntries);
}
```

**3d.** Agregar la función al `export default` del final, **conservando `extractDealId`**:

```javascript
export default {
  process,
  extractDealId,
  extractOrderBaseEntries,
  SKIP_REASONS,
};
```

- [ ] **Step 4: Correr el archivo completo y confirmar que TODO pasa**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/invoiceHandler.test.js
```

Esperado: **PASS todo el archivo** — los cuatro tests nuevos de `extractOrderBaseEntries` y también
los siete tests viejos que ejercitan el `process` por prefijo `HS-DEAL-`. Esta tarea es aditiva:
si algún test viejo falla, se borró algo que no había que borrar. Parar y revisar.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot/handlers/invoice.handler.js tests/unit/infrastructure/invoiceHandler.test.js
git commit -m "feat: extractOrderBaseEntries para leer el linaje de la factura

Reemplaza el parseo del prefijo HS-DEAL- en NumAtCard. Filtra por BaseType 17
porque los DocEntry de SAP son secuencias por objeto, y deduplica porque una
factura real repite el mismo BaseEntry en cada linea.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: reescribir `process` para reconciliar por linaje, y borrar el camino viejo

**Esta es la tarea que borra.** Aquí desaparecen `DEAL_PREFIX`, `extractDealId` y su entrada en el
`export default`, y `process` se reescribe completo. Va todo junto a propósito: `process` llama a
`extractDealId`, así que separarlo dejaría el fuente roto en un commit intermedio.

**Files:**
- Modify: `src/infrastructure/hubspot/handlers/invoice.handler.js` — borrar `DEAL_PREFIX`, `extractDealId` y su entrada del `export default`; reescribir `process`; agregar el comentario de histórico a `NO_DEAL_IN_NUM_AT_CARD`
- Modify: `src/application/services/defaultClientConfigMappings.service.js:65-66` (comentario obsoleto)
- Test: `tests/unit/infrastructure/invoiceHandler.test.js` (reescribir el describe `invoice.handler skip reasons`)

**Interfaces:**
- Consumes: `extractOrderBaseEntries` de Task 6, `findByOrderDocEntry` de Task 5, `DocumentLines` en `rawSapData` gracias a Task 4.
- Produces: `process({ token, item, clientConfig, tenantModels, logger })` → `{ status: 'updated', dealId, dealIds }` | `{ status: 'skipped', reason }` | `{ status: 'failed', error }`.

- [ ] **Step 1: Reescribir el describe de descartes**

En `tests/unit/infrastructure/invoiceHandler.test.js`: cambiar el mock del repositorio para exponer el método nuevo, y reemplazar el describe `invoice.handler skip reasons` completo.

Mock (reemplaza el bloque de `jest.unstable_mockModule` del repositorio, líneas 11-20):

```javascript
const mockFindByOrderDocEntry = jest.fn();

jest.unstable_mockModule(
  '../../../src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js',
  () => ({
    default: class {
      findByOrderDocEntry(...args) {
        return mockFindByOrderDocEntry(...args);
      }
    },
  })
);
```

Borrar la declaración `const mockFindByDeal = jest.fn();` (línea 4).

`buildLogger` debe incluir `debug`, porque los dos descartes esperados ahora van por ahí:

```javascript
function buildLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}
```

Y el describe:

```javascript
describe('invoice.handler reconciliacion por linaje SAP', () => {
  // Una factura copiada de la orden 28987, como las de SBO_DISTELSA_PROD.
  function buildInvoice({ baseEntries = [28987], numAtCard = 'OC #P06485' } = {}) {
    return {
      rawSapData: {
        DocNum: 1024453,
        NumAtCard: numAtCard,
        DocumentLines: baseEntries.map((baseEntry) => ({ BaseType: 17, BaseEntry: baseEntry })),
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByOrderDocEntry.mockResolvedValue({ dealId: '64175519381', sapDocNum: 25313 });
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: true, dealstage: 'closedwon' });
  });

  it('mueve el negocio del link de la orden que originó la factura', async () => {
    const logger = buildLogger();

    const result = await processInvoice({
      token: 'token-1', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(mockFindByOrderDocEntry).toHaveBeenCalledWith({
      SapDocumentLink: tenantModels.SapDocumentLink,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: 28987,
    });
    expect(mockUpdateDeal).toHaveBeenCalledWith('token-1', '64175519381', {
      properties: { dealstage: 'closedwon' },
    });
    expect(result).toEqual({
      status: 'updated', dealId: '64175519381', dealIds: ['64175519381'],
    });
  });

  // El NumAtCard del cliente ya no decide nada: es su OC y solo viaja al log.
  it('mueve el negocio aunque el NumAtCard sea la OC del cliente o venga vacio', async () => {
    for (const numAtCard of ['OC-4504297314', 'OC #P06485', '', null]) {
      jest.clearAllMocks();
      mockFindByOrderDocEntry.mockResolvedValue({ dealId: '64175519381' });
      mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: true, dealstage: 'closedwon' });

      const result = await processInvoice({
        token: 't', item: buildInvoice({ numAtCard }), clientConfig, tenantModels,
        logger: buildLogger(),
      });

      expect(result.status).toBe('updated');
    }
  });

  it('mueve todos los negocios cuando la factura consolida varias ordenes', async () => {
    mockFindByOrderDocEntry
      .mockResolvedValueOnce({ dealId: '111' })
      .mockResolvedValueOnce({ dealId: '222' });

    const result = await processInvoice({
      token: 't', item: buildInvoice({ baseEntries: [28987, 28991] }),
      clientConfig, tenantModels, logger: buildLogger(),
    });

    expect(mockUpdateDeal).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 'updated', dealId: '111', dealIds: ['111', '222'] });
  });

  // Debug y no warn: en un tenant que factura sus propios pedidos esto es el caso normal.
  it('descarta en debug la factura que no viene de ninguna orden', async () => {
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't',
      item: { rawSapData: { DocNum: 900, NumAtCard: 'OC-1', DocumentLines: [{ BaseType: 23, BaseEntry: 5 }] } },
      clientConfig, tenantModels, logger,
    });

    expect(result).toEqual({ status: 'skipped', reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY });
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY, sapDocNum: 900,
    }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  // 15 de 18 facturas de una corrida real caen aca: es el pedido propio del cliente, no una
  // anomalia. En warn inundaria el log en cada corrida.
  it('descarta en debug la factura de una orden que la integracion no creo', async () => {
    mockFindByOrderDocEntry.mockResolvedValue(null);
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(result).toEqual({ status: 'skipped', reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND });
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND, baseEntries: [28987],
    }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  it('avisa en warn cuando updateDealStage esta apagado o sin etapa destino', async () => {
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: false, dealstage: null });
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(result).toEqual({ status: 'skipped', reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED,
    }));
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  it('reporta el fallo y lo loguea cuando HubSpot rechaza el update', async () => {
    mockUpdateDeal.mockRejectedValue(new Error('400 invalid dealstage'));
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed', error: '400 invalid dealstage',
    }));
    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/invoiceHandler.test.js -t "mueve el negocio del link"
```

Esperado: FAIL — `process` todavía llama a `findByDeal` y parsea `NumAtCard`.

- [ ] **Step 3: Borrar el camino viejo y reescribir `process`**

En `src/infrastructure/hubspot/handlers/invoice.handler.js`:

**3a.** Borrar la constante `DEAL_PREFIX`, la función `extractDealId` completa con su JSDoc, y la
línea `extractDealId,` del `export default`.

**3b.** Agregar el comentario de histórico sobre la clave que deja de emitirse, dentro de
`SKIP_REASONS`:

```javascript
  // Histórico: lo emitía la reconciliación por prefijo HS-DEAL- en NumAtCard, retirada el
  // 2026-08-19 en favor del linaje SAP. Ya no se emite, pero los SyncLog guardados en Mongo lo
  // tienen en skippedReasons y borrarlo hace ilegibles esas corridas.
  NO_DEAL_IN_NUM_AT_CARD: 'no_deal_in_num_at_card',
```

**3c.** Reemplazar la función `process` completa (desde su comentario JSDoc hasta el cierre) por:

```javascript
/**
 * Reconcilia una factura de SAP contra las órdenes sincronizadas. La factura trae el DocEntry de
 * su orden en DocumentLines[].BaseEntry (BaseType 17), y desde el SapDocumentLink de esa orden se
 * llega al negocio de HubSpot, que se mueve a la etapa configurada en `updateDealStage`. Las
 * facturas nunca se crean como objetos de HubSpot.
 *
 * El NumAtCard ya no decide nada: es la orden de compra del cliente y sólo viaja al log.
 *
 * Cada salida en `skipped` viaja con su `reason`: sin eso, una corrida que no movió ningún
 * negocio es indistinguible de una que los movió todos.
 */
export async function process({ token, item, clientConfig, tenantModels, logger = console }) {
  const numAtCard = item?.rawSapData?.NumAtCard ?? item?.properties?.num_at_card ?? null;
  const sapDocNum = item?.rawSapData?.DocNum ?? item?.properties?.sap_docnum ?? null;

  try {
    const baseEntries = extractOrderBaseEntries(item?.rawSapData?.DocumentLines);

    if (!baseEntries.length) {
      // Una factura que no nació de un pedido es lo esperado, no una anomalía.
      logger?.debug?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY,
        numAtCard,
        sapDocNum,
      });
      return { status: 'skipped', reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY };
    }

    const dealIds = [];
    for (const sapDocEntry of baseEntries) {
      const link = await sapDocumentLinkRepository.findByOrderDocEntry({
        SapDocumentLink: tenantModels?.SapDocumentLink,
        hubspotCredentialId: clientConfig?.hubspotCredentialId,
        sapDocEntry,
      });

      if (link?.dealId) {
        dealIds.push(String(link.dealId));
      }
    }

    if (!dealIds.length) {
      // Un pedido que la integración no creó: en un tenant que también factura sus propios
      // pedidos de SAP esto es la mayoría de cada corrida, así que va en debug.
      logger?.debug?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND,
        baseEntries,
        numAtCard,
        sapDocNum,
      });
      return { status: 'skipped', reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND };
    }

    const { isRequired, dealstage } = await getUpdateDealStageConfig({ tenantModels });

    if (!isRequired || !dealstage) {
      logger?.warn?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED,
        dealIds,
        sapDocNum,
        isRequired,
        dealstage: dealstage ?? null,
      });
      return { status: 'skipped', reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED };
    }

    for (const dealId of dealIds) {
      await hubspotClient.updateDeal(token, dealId, { properties: { dealstage } });
    }

    logger?.info?.({
      msg: 'Negocio movido de etapa por su factura en SAP',
      dealIds,
      dealstage,
      sapDocNum,
    });

    return { status: 'updated', dealId: dealIds[0], dealIds };
  } catch (error) {
    logger?.error?.({
      msg: 'Error procesando una factura en el sync de facturas',
      numAtCard,
      sapDocNum,
      error: error.message,
    });
    return { status: 'failed', error: error.message };
  }
}
```

- [ ] **Step 4: Corregir el comentario obsoleto de los mapeos**

En `src/application/services/defaultClientConfigMappings.service.js`, reemplazar el comentario de las líneas 65-66:

```javascript
// Invoices are not pushed to a HubSpot object; the mappings only drive the SAP $select. El
// negocio se resuelve por el linaje SAP (DocumentLines[].BaseEntry), no por NumAtCard: ese campo
// es la orden de compra del cliente y sólo viaja al log. DocumentLines NO va aquí a propósito,
// va como campo estructural en serviceLayerUrlBuilder.js para que borrar una fila del admin no
// rompa la reconciliación en silencio.
```

- [ ] **Step 5: Correr el archivo completo de tests del handler**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/infrastructure/invoiceHandler.test.js
```

Esperado: PASS todo, incluido el describe de `extractOrderBaseEntries` de Task 6.

- [ ] **Step 6: Confirmar que no quedó nada apuntando a `extractDealId`**

```bash
grep -rn "extractDealId\|NO_DEAL_IN_NUM_AT_CARD" src/ tests/
```

Esperado: la única aparición de `NO_DEAL_IN_NUM_AT_CARD` es su declaración en `SKIP_REASONS` con el comentario de histórico. `extractDealId` no debe aparecer en ningún lado.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/hubspot/handlers/invoice.handler.js src/application/services/defaultClientConfigMappings.service.js tests/unit/infrastructure/invoiceHandler.test.js
git commit -m "feat: reconciliar facturas por el linaje de SAP en vez del prefijo HS-DEAL-

La factura trae el DocEntry de su orden en DocumentLines[].BaseEntry, y
SapDocumentLink ya guarda sapDocEntry, asi que el NumAtCard queda libre para la
orden de compra del cliente. Sin campo nuevo, sin backfill y sin llamadas extra.

NO_ORDER_BASE_ENTRY y ORDER_LINK_NOT_FOUND van en debug: en un tenant que factura
sus propios pedidos son 15 de cada 18 facturas por corrida.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: verificación de regresión y contra el Service Layer real

**Files:** ninguno (sólo verificación). Si algo falla, volver a la tarea correspondiente.

- [ ] **Step 1: Correr todas las suites afectadas juntas**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/domain tests/unit/infrastructure tests/unit/application
```

Esperado: PASS. Anotar cualquier fallo preexistente y ajeno a este cambio antes de atribuirlo al trabajo.

- [ ] **Step 2: Verificar el `$select` real contra SBO_DISTELSA_PROD**

Comprobar que el `$select` que ahora arma el builder devuelve `DocumentLines` con `BaseType 17` en facturas reales. Script de sólo lectura. Las credenciales van por variable de entorno a propósito: `<password>` es el único marcador deliberado de este plan, y se reemplaza por la contraseña del tenant en el momento de correrlo, sin escribirla en ningún archivo.

```bash
SAP_DB=SBO_DISTELSA_PROD SAP_USER=crm SAP_PASS='<password>' node -e '
const https=require("https");let cookies="";
const req=(m,p,b)=>new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;
const h={"Content-Type":"application/json"};if(d)h["Content-Length"]=Buffer.byteLength(d);
if(cookies)h.Cookie=cookies;
const r=https.request({host:"144.22.47.215",port:50000,path:"/b1s/v2"+p.replace(/ /g,"%20"),method:m,headers:h,rejectUnauthorized:false},(x)=>{
const sc=x.headers["set-cookie"];if(sc)cookies=sc.map(c=>c.split(";")[0]).join("; ");
let s="";x.on("data",c=>s+=c);x.on("end",()=>{let j=null;try{j=JSON.parse(s)}catch{};res({status:x.statusCode,json:j,text:s})})});
r.on("error",rej);if(d)r.write(d);r.end();});
(async()=>{
const l=await req("POST","/Login",{CompanyDB:process.env.SAP_DB,UserName:process.env.SAP_USER,Password:process.env.SAP_PASS});
if(!l.json?.SessionId){console.log("LOGIN FAIL",l.status);process.exit(1)}
const r=await req("GET","/Invoices?$select=DocEntry,DocNum,NumAtCard,DocumentLines&$orderby=DocEntry desc&$top=5");
console.log(JSON.stringify((r.json?.value||[]).map(v=>({DocNum:v.DocNum,NumAtCard:v.NumAtCard,
bases:[...new Set((v.DocumentLines||[]).filter(x=>x.BaseType===17).map(x=>x.BaseEntry))]})),null,2));
await req("POST","/Logout");})();'
```

Esperado: cada factura con al menos un `BaseEntry` en `bases`. Si alguna sale con `bases: []`, **parar**: significa que hay facturas sin linaje de orden en este tenant y la limitación conocida del spec es más amplia de lo medido.

- [ ] **Step 3: Crear el FieldMapping de Distelsa**

Paso de configuración, no de código. En el admin, para el `hubspotCredentialId` de Distelsa:

- `objectType`: `deal`
- `sourceContext`: `orders-quotations`
- `sourceField`: `NumAtCard`
- `targetField`: el nombre de la propiedad de HubSpot donde el usuario captura la OC

Sin esta fila el código queda correcto pero el `NumAtCard` de Distelsa viajará vacío. Confirmar con el usuario el nombre exacto de la propiedad antes de crearla.

- [ ] **Step 4: Prueba manual del sync de facturas**

`POST /sap-sync/run` con **sólo** la config de `invoice` de Distelsa activa. Verificar en el `SyncLog`:

- `skippedReasons` con `no_order_base_entry` y/o `order_link_not_found` para las facturas de pedidos propios del cliente.
- `updated > 0` si alguna factura de la corrida corresponde a una orden que la integración creó.
- Que **no** aparezca `no_deal_in_num_at_card` (ese código ya no se emite).

- [ ] **Step 5: Prueba manual del webhook de conversión**

Disparar `convertQuotationToOrder` desde HubSpot para un negocio de prueba de Distelsa, con la propiedad de la OC llena y con `comments` lleno. Verificar en SAP que la orden creada tiene:

- `NumAtCard` = la OC del usuario, sin prefijo `HS-DEAL-`.
- `Comments` = el texto de HubSpot, y **no** `'Pedido creado desde oferta SAP por etapa Orden de Compra en HubSpot'`.

Repetir con `comments` vacío y confirmar que `Comments` queda nulo en SAP.

---

## Notas de despliegue

- **Printer cambia de comportamiento sin aviso al cliente** (decisión tomada el 2026-08-19): su `NumAtCard` de cotización pasa de `HS-DEAL-<id>` al `hs_object_id` crudo que configuraron. Nada en este código lee ese campo de vuelta para ellos.
- **Las órdenes viejas con `HS-DEAL-<id>` no tienen compatibilidad**: el cliente las va a borrar. Sus facturas caerían en `order_link_not_found` si quedara alguna.
- **El índice nuevo se crea solo** por `autoIndex` en los cuatro tenants. No hay migración ni backfill.
