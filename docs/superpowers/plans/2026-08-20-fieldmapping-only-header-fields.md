# La cabecera de SAP sólo desde el FieldMapping — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que ningún campo de cabecera de un documento de SAP salga de un nombre de propiedad de HubSpot escrito en el código ni de un default del integrador: todos salen del FieldMapping del tenant, en los tres flujos de documento.

**Architecture:** Se eliminan los parámetros de los builders que se aplicaban **después** del derrame de `pickMappedHeaderFields` y por lo tanto le ganaban al mapeo, junto con las lecturas de propiedades de HubSpot por nombre fijo en `ProcessHubspotWebhookEvent`. `ProcessHubspotUpdateQuotation`, que hoy nunca llama al mapeador, pasa a derramar los campos mapeados en su PATCH. Y el mapeador aprende a tratar los textos `'null'`/`'undefined'` como vacíos, avisando en `warn` para que el workflow mal configurado se corrija en HubSpot.

**Tech Stack:** Node.js ESM, Jest (con `--experimental-vm-modules`), SAP B1 Service Layer, HubSpot CRM v3.

**Spec:** `docs/superpowers/specs/2026-08-20-fieldmapping-only-header-fields-design.md`

## Global Constraints

- **Correr jest siempre con path anclado**, nunca la suite completa desde la raíz: la raíz levanta también las suites de los worktrees (~620 en vez de ~170) y produce fallos ajenos. Usar la herramienta **Bash** (no PowerShell, donde el prefijo de variable de entorno no funciona): `NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/(domain|application|infrastructure)/"`. Un path sin anclar también matchea copias dentro de `.claude/worktrees/*`.
- **Trabajar en el checkout principal, nunca en un worktree.** Rama: `fix/fieldmapping-only-header-fields` (ya creada, ya tiene el commit del spec).
- **4 suites con fallos preexistentes ajenos** a este trabajo, verificados contra el merge-base: `sendMappedItemsToHubspot`, `lineItemPriceWebhook.service`, `serviceLayerFlow`, `serviceLayerService`. No son de nadie de este plan y no se arreglan acá. Si alguna **cambia** de cantidad de fallos o de mensaje, parar y reportar.
- **`toNonEmptyString` NO se toca.** El descarte de `'null'`/`'undefined'` va sólo en `mapHubspotToSapFields`. `toNonEmptyString` tiene 208 usos en 34 archivos, la mayoría identificadores, y cambiarle la semántica es trabajo de otra rama.
- **`inventory-transfer-request-builder.service.js` NO se toca.** Ya cumple la regla; es el modelo, no algo a corregir.
- **`resolveDocDueDate` y `RESERVED_HEADER_FIELDS` no se modifican.**
- Las cinco filas de FieldMapping de Noelito **ya están cargadas y verificadas en producción** (2026-08-20): `Comments <- comments`, `U_ACO_Telefono <- numero_de_contacto_primario`, `U_ACO_Telefono2 <- numero_de_contacto_secundario`, `Address <- direccion_de_facturacion`, `Address2 <- direccion_de_entrega`, todas en `objectType: 'deal'`, `sourceContext: 'orders-quotations'`. Este plan asume eso; no hay que cargar nada.

## Hechos verificados que el plan da por ciertos

- Los tres casos de uso involucrados tienen `this.logger`, con default `{ warn: () => {} }` (`ProcessHubspotWebhookEvent.js:49,61`, `ProcessHubspotUpdateQuotation.js:42,51`, `ProcessHubspotCreateQuotation.js:48,61`). Por eso `logger?.warn?.()` es seguro en todos los caminos.
- `ProcessHubspotUpdateQuotation` tiene `mappings` en scope (`:70`) y `deal` en scope (lo usa en `:105`).
- `pickMappedHeaderFields` (`order-builder.service.js:69`) hoy es privado del módulo y excluye `CardCode`, `DocDueDate`, `DocumentLines` y `PaymentGroupCode`, y normaliza `DocumentSpecialLines`.
- Hay 17 llamadores de `mapHubspotToSapFields`. Por eso el logger va como tercer parámetro **opcional**: los 14 que no lo necesitan no se tocan.

---

### Task 1: el mapeador descarta los textos `'null'` y `'undefined'`, con `warn`

**Files:**
- Modify: `src/domain/orders/order-builder.service.js:6-27` (la función `mapHubspotToSapFields`)
- Create: `tests/unit/domain/mapHubspotToSapFields.test.js`

**Interfaces:**
- Produces: `mapHubspotToSapFields(source, mappings, { logger } = {})`. El tercer parámetro es opcional; sin él la función se comporta igual que hoy salvo el descarte. Las tareas 2, 3 y 4 le pasan `{ logger: this.logger }`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/unit/domain/mapHubspotToSapFields.test.js`:

```javascript
import { jest } from '@jest/globals';
import { mapHubspotToSapFields } from '../../../src/domain/orders/order-builder.service.js';

describe('mapHubspotToSapFields descarta los textos "null" y "undefined"', () => {
  const mappings = [
    { sourceField: 'U_ACO_Telefono2', targetField: 'numero_de_contacto_secundario' },
  ];

  // Verificado en produccion: el workflow de noelito serializa dos propiedades vacias como
  // el TEXTO "null", y hoy eso se escribe literal en el campo de SAP.
  it.each(['null', 'undefined', 'NULL', 'Undefined', '  null  '])(
    'no produce la clave cuando el valor es %p',
    (value) => {
      const mapped = mapHubspotToSapFields(
        { numero_de_contacto_secundario: value },
        mappings
      );

      expect(mapped).not.toHaveProperty('U_ACO_Telefono2');
    }
  );

  // El descarte es por valor exacto, no por contenido: un texto legitimo que contenga la
  // palabra tiene que sobrevivir.
  it.each(['anulado', 'null y algo mas', 'nullo', 'sin undefined aqui', '0'])(
    'conserva el valor legitimo %p',
    (value) => {
      const mapped = mapHubspotToSapFields(
        { numero_de_contacto_secundario: value },
        mappings
      );

      expect(mapped.U_ACO_Telefono2).toBe(value);
    }
  );

  it('avisa en warn con el campo de SAP y la propiedad de HubSpot', () => {
    const logger = { warn: jest.fn() };

    mapHubspotToSapFields(
      { numero_de_contacto_secundario: 'null' },
      mappings,
      { logger }
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      sapField: 'U_ACO_Telefono2',
      hubspotProperty: 'numero_de_contacto_secundario',
      value: 'null',
    }));
  });

  it('no explota cuando no se le pasa logger', () => {
    expect(() => mapHubspotToSapFields(
      { numero_de_contacto_secundario: 'null' },
      mappings
    )).not.toThrow();
  });

  // Un null real es una propiedad vacia normal, no un workflow mal configurado: se descarta
  // como siempre, pero sin ruido en el log.
  it('no avisa cuando el valor es un null real', () => {
    const logger = { warn: jest.fn() };

    const mapped = mapHubspotToSapFields(
      { numero_de_contacto_secundario: null },
      mappings,
      { logger }
    );

    expect(mapped).not.toHaveProperty('U_ACO_Telefono2');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('sigue mapeando los demas campos cuando uno se descarta', () => {
    const mapped = mapHubspotToSapFields(
      { numero_de_contacto_secundario: 'null', numero_de_contacto_primario: '+50583635946' },
      [
        ...mappings,
        { sourceField: 'U_ACO_Telefono', targetField: 'numero_de_contacto_primario' },
      ]
    );

    expect(mapped).toEqual({ U_ACO_Telefono: '+50583635946' });
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/domain/mapHubspotToSapFields\.test\.js$"
```

Esperado: FAIL. Los casos `'null'`, `'undefined'`, `'NULL'`, `'Undefined'`, `'  null  '` producen la clave hoy, y el test del `warn` falla porque la función no acepta tercer parámetro.

- [ ] **Step 3: Implementar el descarte y el logger opcional**

En `src/domain/orders/order-builder.service.js`, reemplazar la función `mapHubspotToSapFields` completa (líneas 6-27) por:

```javascript
// Un workflow de HubSpot mal configurado serializa una propiedad vacia como el TEXTO 'null' o
// 'undefined' en vez de omitirla. Verificado en produccion: el tenant noelito manda "null" en
// numero_de_contacto_secundario y direccion_de_facturacion, y hoy eso se escribe literal en
// U_ACO_Telefono2 y Address de sus ordenes de SAP.
//
// El descarte NO va en toNonEmptyString a proposito: esa funcion tiene 208 usos en 34 archivos,
// la mayoria identificadores (hs_object_id, portalId, hs_sku, cardCode), asi que cambiarle la
// semantica exige su propia rama para poder atribuir cualquier regresion.
const EMPTY_TEXT_SENTINELS = new Set(['null', 'undefined']);

function isEmptyTextSentinel(value) {
  return typeof value === 'string' && EMPTY_TEXT_SENTINELS.has(value.trim().toLowerCase());
}

export function mapHubspotToSapFields(source, mappings, { logger = null } = {}) {
  const mapped = {};

  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    if (mapping?.isActive === false) {
      continue;
    }

    const sourceField = String(mapping?.sourceField || '').trim();
    const targetField = String(mapping?.targetField || '').trim();
    if (!sourceField || !targetField) {
      continue;
    }

    const value = pickByPath(source, targetField);

    // Se avisa en vez de descartar en silencio: el valor sucio viene de un workflow mal
    // configurado, y este warn es lo que hace que alguien lo corrija en HubSpot, que es donde
    // corresponde. Un null real no pasa por aca, asi que el log no se llena de ruido.
    if (isEmptyTextSentinel(value)) {
      logger?.warn?.({
        msg: 'Propiedad de HubSpot descartada por llegar como el texto "null"/"undefined"',
        sapField: sourceField,
        hubspotProperty: targetField,
        value,
      });
      continue;
    }

    if (value !== null && typeof value !== 'undefined' && value !== '') {
      mapped[sourceField] = value;
    }
  }

  return mapped;
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/domain/mapHubspotToSapFields\.test\.js$"
```

Esperado: PASS los 15 casos (5 del primer `it.each`, 5 del segundo, y 5 sueltos).

- [ ] **Step 5: Confirmar que ningún llamador existente se rompió**

Los 17 llamadores pasan dos argumentos y el tercero tiene default, así que ninguno debería romperse. Verificarlo:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/(domain|application|infrastructure)/"
```

Esperado: PASS todo salvo `sendMappedItemsToHubspot` (3 fallos preexistentes). Si algún otro test falla, es que un fixture tenía el texto `'null'` como valor esperado — reportarlo antes de cambiarlo.

- [ ] **Step 6: Commit**

```bash
git add src/domain/orders/order-builder.service.js tests/unit/domain/mapHubspotToSapFields.test.js
git commit -m "fix: tratar los textos 'null' y 'undefined' como vacios en el mapeo, con warn

El workflow de noelito serializa dos propiedades vacias como el texto \"null\",
que toNonEmptyString devuelve tal cual porque es una cadena no vacia, asi que
hoy se escribe literal en U_ACO_Telefono2 y Address de sus ordenes en SAP.

Se avisa en warn en vez de descartar en silencio: el valor sucio viene de una
mala configuracion del workflow y ahi es donde se corrige.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `buildOrderPayload` pierde sus cinco parámetros

**Files:**
- Modify: `src/domain/orders/order-builder.service.js` (la función `buildOrderPayload`, hoy en `:355-402`)
- Modify: `src/application/use-cases/ProcessHubspotWebhookEvent.js:302` y `:306-317`
- Test: `tests/unit/domain/quotationBuilder.test.js` y `tests/unit/application/processQuotationFlows.test.js`

**Interfaces:**
- Consumes: `mapHubspotToSapFields(source, mappings, { logger })` de la Task 1.
- Produces: `buildOrderPayload({ cardCode, documentLines, slpCode, paymentGroupCode, mappedDealFields })` — **sin** `comments`, `U_ACO_Telefono`, `U_ACO_Telefono2`, `Address` ni `Address2`.

- [ ] **Step 1: Escribir los tests que fallan**

En `tests/unit/domain/quotationBuilder.test.js`, **reemplazar** el describe `order-builder.service buildOrderPayload conserva su parametro comments` completo (el que se agregó en la rama anterior, con sus dos tests) por este:

```javascript
describe('order-builder.service buildOrderPayload toma la cabecera del mapeo', () => {
  const documentLines = [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }];

  // Los cinco campos que antes se leian por nombre fijo desde el codigo. Son los de noelito:
  // sus filas de FieldMapping ya estan cargadas en produccion.
  it('derrama los cinco campos que antes venian hardcodeados', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL00129',
      documentLines,
      mappedDealFields: {
        Comments: 'llevar el dia de maniana',
        U_ACO_Telefono: '+50583635946',
        U_ACO_Telefono2: '+50588887777',
        Address: 'Managua centro',
        Address2: 'Jalapa contiguo al mercado',
      },
    });

    expect(payload).toMatchObject({
      Comments: 'llevar el dia de maniana',
      U_ACO_Telefono: '+50583635946',
      U_ACO_Telefono2: '+50588887777',
      Address: 'Managua centro',
      Address2: 'Jalapa contiguo al mercado',
    });
  });

  it('no inventa ninguno de esos campos cuando el mapeo no produjo valores', () => {
    const payload = buildOrderPayload({ cardCode: 'CL00129', documentLines });

    for (const field of ['Comments', 'U_ACO_Telefono', 'U_ACO_Telefono2', 'Address', 'Address2']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('no deja que el derrame pise lo que el builder posee', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL00129',
      documentLines,
      paymentGroupCode: 3,
      mappedDealFields: { CardCode: 'HACKED', PaymentGroupCode: 99, DocumentLines: [] },
    });

    expect(payload.CardCode).toBe('CL00129');
    expect(payload.PaymentGroupCode).toBe(3);
    expect(payload.DocumentLines).toEqual(documentLines);
  });
});
```

Y en `tests/unit/application/processHubspotWebhookEvent.test.js` (**no** en `processQuotationFlows.test.js`: el caso de uso de la orden directa se testea en ese archivo), agregar este describe al final. El archivo ya tiene los helpers `buildContext(overrides)` (línea 34, con `dealOrdersQuotationsMappings: []` por defecto en la línea 56), `buildDeps(context = buildContext())` (línea 67) y `buildEvent(payloadOverrides)` (línea 127), y `createOrder` se invoca como `createOrder({ sapConfig, orderPayload })`:

```javascript
describe('ProcessHubspotWebhookEvent — la cabecera sale solo del FieldMapping', () => {
  // El payload real de noelito, el tenant cuyas cinco propiedades estaban hardcodeadas.
  const dealDeNoelito = {
    hs_object_id: '59680314911',
    comments: 'llevar el dia de maniana',
    numero_de_contacto_primario: '+50583635946',
    numero_de_contacto_secundario: 'null',
    direccion_de_facturacion: 'null',
    direccion_de_entrega: 'Jalapa contiguo al mercado',
  };

  const mapeosDeNoelito = [
    { sourceField: 'Comments', targetField: 'comments' },
    { sourceField: 'U_ACO_Telefono', targetField: 'numero_de_contacto_primario' },
    { sourceField: 'U_ACO_Telefono2', targetField: 'numero_de_contacto_secundario' },
    { sourceField: 'Address', targetField: 'direccion_de_facturacion' },
    { sourceField: 'Address2', targetField: 'direccion_de_entrega' },
  ];

  // Este es el test que fija que el codigo ya no tiene la puerta trasera: las propiedades
  // vienen en el payload, pero sin las filas de FieldMapping no viajan a SAP.
  it('no lee ninguna propiedad de HubSpot por nombre cuando no hay mapeos', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const event = buildEvent({ deal: dealDeNoelito });

    await useCase.execute({ event, tenantModels, portalId: '50564010' });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    for (const field of ['Comments', 'U_ACO_Telefono', 'U_ACO_Telefono2', 'Address', 'Address2']) {
      expect(orderPayload).not.toHaveProperty(field);
    }
  });

  it('toma los cinco campos del FieldMapping cuando estan mapeados', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = mapeosDeNoelito;
    const deps = buildDeps(context);
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const event = buildEvent({ deal: dealDeNoelito });

    await useCase.execute({ event, tenantModels, portalId: '50564010' });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload.Comments).toBe('llevar el dia de maniana');
    expect(orderPayload.U_ACO_Telefono).toBe('+50583635946');
    expect(orderPayload.Address2).toBe('Jalapa contiguo al mercado');
  });

  // Las dos propiedades que noelito manda como el TEXTO "null" no deben llegar a SAP, ni
  // siquiera estando mapeadas. Cubre la Task 1 desde el flujo completo.
  it('descarta las propiedades que llegan como el texto "null" aunque esten mapeadas', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = mapeosDeNoelito;
    const deps = buildDeps(context);
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const event = buildEvent({ deal: dealDeNoelito });

    await useCase.execute({ event, tenantModels, portalId: '50564010' });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload).not.toHaveProperty('U_ACO_Telefono2');
    expect(orderPayload).not.toHaveProperty('Address');
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      sapField: 'U_ACO_Telefono2',
      hubspotProperty: 'numero_de_contacto_secundario',
    }));
  });
});
```

Si `ProcessHubspotWebhookEvent` no está importado al principio del archivo, agregar el import siguiendo el estilo de los otros tests del archivo.

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/domain/quotationBuilder\.test\.js$"
```

Esperado: FAIL. El describe viejo esperaba que `comments` llegara por parámetro.

- [ ] **Step 3: Quitar los cinco parámetros del builder**

En `src/domain/orders/order-builder.service.js`, reemplazar `buildOrderPayload` completa por:

```javascript
export function buildOrderPayload({
  cardCode,
  documentLines,
  slpCode = null,
  paymentGroupCode = null,
  mappedDealFields = {},
}) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Order');
  }

  const payload = {
    ...pickMappedHeaderFields(mappedDealFields, { documentLineCount: documentLines.length }),
    CardCode: cardCode,
    DocDueDate: resolveDocDueDate({ mappedDeal: mappedDealFields }),
    DocumentLines: documentLines,
  };

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
  }

  if (Number.isInteger(paymentGroupCode)) {
    payload.PaymentGroupCode = paymentGroupCode;
  }

  return payload;
}
```

Eso borra el bloque `resolvedComments` y el bloque `optionalFields` completo.

- [ ] **Step 4: Quitar las lecturas por nombre del caso de uso**

En `src/application/use-cases/ProcessHubspotWebhookEvent.js`, reemplazar la línea 302 para pasarle el logger al mapeador:

```javascript
      const mappedDeal = mapHubspotToSapFields(
        deal || {},
        mappings.dealOrdersQuotationsMappings,
        { logger: this.logger }
      );
```

Y reemplazar la llamada al builder (líneas 306-317) por:

```javascript
      const orderPayload = buildOrderPayload({
        cardCode,
        documentLines,
        slpCode,
        paymentGroupCode,
        mappedDealFields: mappedDeal,
      });
```

- [ ] **Step 5: Confirmar que no quedó ninguna propiedad de HubSpot leída por nombre**

```bash
grep -n "numero_de_contacto_primario\|numero_de_contacto_secundario\|direccion_de_facturacion\|direccion_de_entrega" src/
```

Esperado: sin resultados en `src/`.

- [ ] **Step 6: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/(domain|application)/"
```

Esperado: PASS salvo los preexistentes.

- [ ] **Step 7: Commit**

```bash
git add src/domain/orders/order-builder.service.js src/application/use-cases/ProcessHubspotWebhookEvent.js tests/
git commit -m "fix: la cabecera de la orden directa sale del FieldMapping, no de nombres fijos

buildOrderPayload leia cinco propiedades de HubSpot por nombre escrito en el
codigo (comments, numero_de_contacto_primario, numero_de_contacto_secundario,
direccion_de_facturacion, direccion_de_entrega) y las aplicaba despues del
derrame, ganandole al mapeo. Eran de noelito, con datos vivos: sus cinco filas
de FieldMapping se cargaron y verificaron en produccion antes de este commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `buildQuotationPayload` pierde su parámetro `comments`

**Files:**
- Modify: `src/domain/orders/order-builder.service.js` (la función `buildQuotationPayload`)
- Modify: `src/application/use-cases/ProcessHubspotCreateQuotation.js` (la llamada al mapeador y al builder)
- Test: `tests/unit/domain/quotationBuilder.test.js`, `tests/unit/application/processQuotationFlows.test.js:248` y `:266`

**Interfaces:**
- Produces: `buildQuotationPayload({ cardCode, documentLines, slpCode, paymentGroupCode, mappedDealFields })` — **sin** `comments`.

- [ ] **Step 1: Ajustar los tests al comportamiento nuevo**

En `tests/unit/domain/quotationBuilder.test.js`, el primer test del describe `buildQuotationPayload` pasa `comments` por parámetro. Reemplazarlo por:

```javascript
  it('builds a Quotation payload with Comments del mapeo y SalesPersonCode', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      slpCode: 5,
      mappedDealFields: { Comments: 'Oferta creada desde HubSpot' },
    });

    expect(payload).toMatchObject({
      CardCode: 'CL00129',
      Comments: 'Oferta creada desde HubSpot',
      SalesPersonCode: 5,
      DocumentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });
    expect(payload.DocDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('no agrega Comments cuando el mapeo no produjo valor', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });

    expect(payload).not.toHaveProperty('Comments');
  });
```

En `tests/unit/application/processQuotationFlows.test.js`, los tests de las líneas 248 (`forwards deal.comments as the quotation Comments when provided`) y 266 (`omits Comments on the quotation when the deal has no comments`) verifican el camino por parámetro. El primero necesita el mapeo, porque el fixture tiene `dealOrdersQuotationsMappings: []` por defecto (línea ~28). Reemplazarlos por:

```javascript
  it('toma el Comments de la cotizacion del FieldMapping', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        deal: { hs_object_id: '59680314911', comments: 'Comentario para el comprador y prueba' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload.Comments).toBe('Comentario para el comprador y prueba');
  });

  // Sin la fila de FieldMapping no viaja, aunque la propiedad venga en el payload: el codigo
  // ya no tiene una puerta trasera que lea deal.comments por su nombre.
  it('no manda Comments cuando no hay mapeo, aunque el payload lo traiga', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        deal: { hs_object_id: '59680314911', comments: 'Este comentario no deberia viajar' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload).not.toHaveProperty('Comments');
  });
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/application/processQuotationFlows\.test\.js$" -t "no manda Comments cuando no hay mapeo"
```

Esperado: FAIL. Hoy `comments: deal?.comments` lo manda igual sin mapeo.

- [ ] **Step 3: Quitar el parámetro del builder**

En `src/domain/orders/order-builder.service.js`, en `buildQuotationPayload`: borrar `comments = null,` de la firma y borrar este bloque del cuerpo:

```javascript
  const resolvedComments = toNonEmptyString(comments);
  if (resolvedComments) {
    payload.Comments = resolvedComments;
  }
```

- [ ] **Step 4: Quitar la lectura literal del caso de uso**

En `src/application/use-cases/ProcessHubspotCreateQuotation.js`: borrar la línea `comments: deal?.comments,` de la llamada a `buildQuotationPayload`, y pasarle el logger al mapeador en la línea donde se calcula `mappedDeal`:

```javascript
      const mappedDeal = mapHubspotToSapFields(
        deal || {},
        mappings.dealOrdersQuotationsMappings,
        { logger: this.logger }
      );
```

- [ ] **Step 5: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/(domain|application)/"
```

Esperado: PASS salvo los preexistentes.

- [ ] **Step 6: Commit**

```bash
git add src/domain/orders/order-builder.service.js src/application/use-cases/ProcessHubspotCreateQuotation.js tests/unit/domain/quotationBuilder.test.js tests/unit/application/processQuotationFlows.test.js
git commit -m "fix: el Comments de la cotizacion sale del FieldMapping

Revierte una decision del spec del 2026-08-19, que conservo este parametro
porque updateQuotation leia deal?.comments directo y quitarlo habria
desincronizado crear de actualizar. La Task 4 mete el PATCH en el mismo
mecanismo, asi que la razon desaparece.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `updateQuotation` pasa por el mapeo

**Files:**
- Modify: `src/domain/orders/order-builder.service.js:69` (exportar `pickMappedHeaderFields`)
- Modify: `src/application/use-cases/ProcessHubspotUpdateQuotation.js:1-6` (imports) y `:101-109` (el PATCH)
- Test: `tests/unit/application/processQuotationFlows.test.js:581` y `:592`

**Interfaces:**
- Consumes: `mapHubspotToSapFields(source, mappings, { logger })` de la Task 1.
- Produces: `pickMappedHeaderFields(mappedDealFields, { documentLineCount })` pasa a ser exportada del módulo. Sigue excluyendo `CardCode`, `DocDueDate`, `DocumentLines` y `PaymentGroupCode`, y normalizando `DocumentSpecialLines`.

- [ ] **Step 1: Ajustar los tests al comportamiento nuevo**

En `tests/unit/application/processQuotationFlows.test.js`, reemplazar los tests de las líneas 581 (`does not overwrite the existing SAP Comments when the deal has no comments`) y 592 (`patches Comments with deal.comments when the deal provides one`) por:

```javascript
  // El PATCH solo lleva lo que el workflow mando en ESTE evento. Editar lineas en HubSpot no
  // debe pisar la cabecera que un usuario haya corregido a mano en SAP.
  it('no manda ningun campo de cabecera cuando el payload no los trae', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
      { sourceField: 'NumAtCard', targetField: 'orden_de_compra' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const result = await useCase.execute({ event: updateEvent, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch).not.toHaveProperty('Comments');
    expect(patch).not.toHaveProperty('NumAtCard');
    expect(patch).toHaveProperty('DocumentLines');
    expect(result.sapAudit.auditTrail.payload_SAP.quotation).not.toHaveProperty('Comments');
  });

  it('manda los campos de cabecera que vienen mapeados y presentes en el payload', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
      { sourceField: 'NumAtCard', targetField: 'orden_de_compra' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        deal: {
          ...updateEvent.payload.deal,
          comments: 'Comentario para el comprador y prueba',
          orden_de_compra: 'OC #P06485',
        },
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.Comments).toBe('Comentario para el comprador y prueba');
    expect(patch.NumAtCard).toBe('OC #P06485');
  });

  // pickMappedHeaderFields protege los campos que el PATCH posee, igual que en los builders.
  it('no deja que un mapeo pise CardCode ni DocumentLines en el PATCH', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'CardCode', targetField: 'card_code' },
      { sourceField: 'DocumentLines', targetField: 'lineas' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        deal: { ...updateEvent.payload.deal, card_code: 'HACKED', lineas: 'basura' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch).not.toHaveProperty('CardCode');
    expect(patch.DocumentLines).not.toBe('basura');
    expect(Array.isArray(patch.DocumentLines)).toBe(true);
  });
```

**Confirmado:** el describe `ProcessHubspotUpdateQuotation` arranca en la línea 527 de ese archivo y su constante de evento se llama efectivamente `updateEvent` (línea 528, con `eventType: 'updateQuotation'`). Los helpers `buildContext()` y `buildRuntimeRepository(context)` son los del principio del archivo, ya usados así en los tests de `PaymentGroupCode` (línea ~165) y `CardName` (línea ~189).

- [ ] **Step 2: Correr los tests y confirmar que fallan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/application/processQuotationFlows\.test\.js$" -t "manda los campos de cabecera que vienen mapeados"
```

Esperado: FAIL. Hoy el PATCH no lleva `NumAtCard` de ninguna forma.

- [ ] **Step 3: Exportar `pickMappedHeaderFields`**

En `src/domain/orders/order-builder.service.js`, cambiar la declaración de la función (línea 69) para exportarla, y agregarle el comentario del motivo:

```javascript
// Exportada porque el PATCH de ProcessHubspotUpdateQuotation la necesita: sin ella, un mapeo
// podria pisar CardCode o DocumentLines en la actualizacion de una oferta, y DocumentSpecialLines
// llegaria como texto plano en vez de como la coleccion que SAP espera.
export function pickMappedHeaderFields(mappedDealFields, { documentLineCount = 0 } = {}) {
```

- [ ] **Step 4: Derramar los campos mapeados en el PATCH**

En `src/application/use-cases/ProcessHubspotUpdateQuotation.js`, agregar los dos imports al import existente de `order-builder.service.js` (línea 1):

```javascript
import {
  buildQuotationLineUpdates,
  mapHubspotToSapFields,
  pickMappedHeaderFields,
} from '#domain/orders/order-builder.service.js';
```

Y reemplazar la construcción del PATCH y el bloque de `Comments` (líneas 101-109) por:

```javascript
      const mappedDeal = mapHubspotToSapFields(
        deal || {},
        mappings.dealOrdersQuotationsMappings,
        { logger: this.logger }
      );

      // El PATCH solo lleva lo que el workflow mando en ESTE evento: mapHubspotToSapFields no
      // produce clave para una propiedad ausente o vacia. Asi, editar lineas en HubSpot no pisa
      // los campos de cabecera que un usuario haya corregido a mano en SAP.
      //
      // DocDueDate queda deliberadamente afuera: pickMappedHeaderFields lo excluye porque en los
      // builders lo resuelve resolveDocDueDate. Mover el vencimiento de un documento ya creado en
      // SAP es una decision distinta de sincronizar sus lineas.
      const patchPayload = {
        ...pickMappedHeaderFields(mappedDeal, { documentLineCount: lineUpdates.length }),
        DocumentLines: lineUpdates,
      };
```

Eso borra el bloque que leía `deal?.comments`. `DocumentLines` va después del derrame para que gane; `pickMappedHeaderFields` además ya lo excluye.

- [ ] **Step 5: Correr los tests y confirmar que pasan**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/(domain|application)/"
```

Esperado: PASS salvo los preexistentes.

- [ ] **Step 6: Confirmar que no queda ninguna lectura literal de `comments`**

```bash
grep -rn "deal?.comments\|deal\.comments" src/
```

Esperado: sin resultados en `src/`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/orders/order-builder.service.js src/application/use-cases/ProcessHubspotUpdateQuotation.js tests/unit/application/processQuotationFlows.test.js
git commit -m "fix: el PATCH de updateQuotation deriva su cabecera del FieldMapping

Era el unico flujo que nunca llamaba a mapHubspotToSapFields. Ahora derrama los
campos mapeados, y como el mapeador no produce clave para una propiedad ausente,
el PATCH solo lleva lo que el workflow mando en ese evento: editar lineas en
HubSpot no pisa la cabecera corregida a mano en SAP.

Cierra tambien el desfase detectado en la rama anterior: la oferta ya puede
recibir NumAtCard si la OC se llena despues de creada.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: verificación de regresión

**Files:** ninguno. Si algo falla, volver a la tarea correspondiente.

- [ ] **Step 1: Suite completa anclada**

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/"
```

Esperado: los 4 fallos preexistentes (`sendMappedItemsToHubspot`, `lineItemPriceWebhook.service`, `serviceLayerFlow`, `serviceLayerService`) y nada más. `internalTenant.test.js` es flaky por contención al arrancar Mongo en memoria: si falla, correrlo aislado para confirmar que pasa.

- [ ] **Step 2: Confirmar que los preexistentes no cambiaron**

Comparar contra el punto de partida de la rama. Con el árbol limpio:

```bash
git stash list && git status --porcelain
MB=$(git merge-base main HEAD) && git checkout -q "$MB" && NODE_OPTIONS=--experimental-vm-modules npx jest "^tests/unit/(lineItemPriceWebhook.service|serviceLayerFlow|serviceLayerService)\.test\.js$" 2>&1 | tail -5 && git checkout -q fix/fieldmapping-only-header-fields
```

Esperado: la misma cantidad de fallos que en la rama. **Antes de hacer el checkout, confirmar que `git status --porcelain` está vacío**; si hay cambios sin commitear, no hacer el checkout y reportar.

- [ ] **Step 3: Confirmar que el código quedó sin puertas traseras**

```bash
grep -rn "numero_de_contacto_primario\|numero_de_contacto_secundario\|direccion_de_facturacion\|direccion_de_entrega\|deal?.comments\|deal\.comments" src/
```

Esperado: sin resultados.

```bash
grep -n "U_ACO_Telefono\|optionalFields\|comments = null" src/domain/orders/order-builder.service.js
```

Esperado: sin resultados.

- [ ] **Step 4: Reportar el estado y las pruebas manuales pendientes**

Las tres pruebas manuales del spec necesitan producción y las hace el dueño del proyecto:

1. **Noelito, `createDeal`:** negocio con `numero_de_contacto_primario` y `direccion_de_entrega` llenos → la orden en SAP debe llevar `U_ACO_Telefono` y `Address2` con esos valores, `U_ACO_Telefono2` y `Address` **vacíos** (no con el texto `"null"`), y el `warn` del descarte en `logs/app.log`.
2. **Distelsa, `updateQuotation` sin `comments` en el payload:** el `Comments` que la oferta ya tenía en SAP **no** se borra ni se pisa.
3. **Distelsa, `updateQuotation` con `comments`:** el `Comments` de la oferta se actualiza.
