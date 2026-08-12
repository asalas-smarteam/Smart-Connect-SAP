# BusinessPartner de SAP B1 hacia HubSpot — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-11-business-partner-sap-to-hubspot-design.md` — léelo antes de empezar. Contiene las decisiones con su motivo, las alternativas descartadas y la verificación en vivo de las asociaciones contacto→contacto.

## ⚠️ PREREQUISITO DURO

Este plan **no se puede ejecutar antes** que `docs/superpowers/plans/2026-08-11-business-partner-full-creation.md`. Depende de tres cosas que ese plan crea:

| Necesita | Lo crea |
|---|---|
| `src/domain/business-partners/sap-properties-flags.service.js` con `readSapPropertiesFlags` y `listSapPropertiesFieldNames` | Tarea 3 del plan hermano |
| `src/domain/business-partners/business-partner-creation.constants.js` con `PROPERTIES_FLAGS_STRATEGIES` | Tarea 2 del plan hermano |
| `src/infrastructure/config/BusinessPartnerCreationConfigRepository.js` con `getPropertiesFlagsConfig` | Tarea 2 del plan hermano |

**Antes del Paso 1 de la Tarea 1, verificá que existan:**

```bash
ls src/domain/business-partners/sap-properties-flags.service.js src/domain/business-partners/business-partner-creation.constants.js src/infrastructure/config/BusinessPartnerCreationConfigRepository.js
```

Si falta alguno, detenete y ejecutá primero el plan hermano. **Y volvé a leer los números de línea que este plan cita**: el plan hermano modifica `SyncSapConfigToHubspot.js`, `TenantWebhookRuntimeRepository.js` y `serviceLayerUrlBuilder.js`, así que las anclas de este plan pueden haberse corrido. Buscá por nombre de función, no por número, cuando no coincidan.

**Goal:** Que los `ContactEmployees` de un BusinessPartner lleguen a HubSpot como contactos asociados al BP sea éste una company o un contact, y que las banderas `Properties1..64` de SAP lleguen a una propiedad multi-select de HubSpot.

**Architecture:** Tres piezas independientes. (1) Mappings sintéticos que meten campos al `$select` de SAP sin necesitar filas de `FieldMapping`, copiando `withDynamicDescriptionSelectFields`. (2) Un enricher que traduce las 64 banderas de SAP a un string unido por `;` en `record.properties`. (3) Un parámetro `parentObjectType` que permite que la maquinaria de contactos-hijo existente sirva también con un contacto como padre.

**Tech Stack:** Node.js ESM, Mongoose multi-tenant, Jest con `NODE_OPTIONS=--experimental-vm-modules`, SAP Business One Service Layer v2, HubSpot CRM v3 + associations v4.

## Global Constraints

- **Cero regresión** en lo que es configurable: con `propertiesFlags` ausente, las propiedades enviadas son idénticas a las de hoy.
- **Excepciones deliberadas al cero-regresión** (tres, no una — corregido tras la revisión final de la rama; la redacción original decía que la Tarea 1 era la única y no era exacta). Las tres cambian el comportamiento de **todo tenant que ya sincroniza registros de `objectType: contact` desde SAP**, sin ninguna bandera de config que las compuerte:
  1. **Tarea 1** cambia la URL de las asociaciones de a una (ver su justificación).
  2. **Tareas 2+4** inyectan `ContactEmployees` en el `$select` de la sincronización de contactos de forma **incondicional**. La URL de SAP para un sync de contactos deja de ser la de hoy.
  3. **Tareas 7+8** ejecutan la sincronización de hijos para BPs contact-shaped de forma **incondicional**. En cuanto esta rama entre a producción, en el siguiente sync de contactos, cualquier tenant que ya tenga mappings de `contactEmployee` configurados —es decir, cualquier tenant que ya sincronice companies, porque esos mappings son compartidos— **empezará a crear/actualizar contactos de HubSpot por cada ContactEmployee de SAP y a asociarlos**. No hay bandera que lo apague.

  Esto es una decisión de diseño intencional, no un descuido: el spec razona por qué no se agrega compuerta (la maquinaria de hijos ya es idempotente, `internalcode` aborta en vez de degradar si no es escribible, y una bandera nueva sería una config que nadie prendería). Pero el resumen de "qué cambia" de este plan tiene que decirlo explícitamente, porque el volumen de objetos creados en HubSpot puede ser grande y no es reversible con un flag.

- **Recomendación de rollout.** Antes de habilitar esto por primera vez en el sync de contactos de un tenant de producción después de que esta rama caiga: corré un sync de `objectType: contact` en un **tenant de prueba** primero y **contá los contactos de HubSpot recién creados**. Compará ese número contra los `ContactEmployees` que esperabas. Recién ahí pasá a producción.
- **Solo SAP B1 (`SERVICE_LAYER`)** para `Properties1..64`. El camino de contactos de S/4 (`_s4Contacts`, `S4ContactEnrichmentAdapter`) no se toca.
- **Alias de import obligatorios** (`package.json` → `imports`): `#application/*`, `#domain/*`, `#infrastructure/*`, `#shared/*`, `#composition/*`. Dentro de `src/application/ports/` se usan rutas relativas (`../port-validator.js`).
- **Los tests importan con rutas relativas**, no con alias: `import X from '../../../src/domain/...'`.
- **Comando de test:** `npm test`. Para un archivo: `npm test -- tests/unit/domain/archivo.test.js`.
- **La asociación contacto↔contacto es SIMÉTRICA.** Verificado en vivo: una sola llamada crea las dos direcciones (`typeId 449`, `HUBSPOT_DEFINED`, `label: null`). **Nunca asocies el par dos veces.**
- **Dos rutas PUT distintas de HubSpot v4, no intercambiables:** `/crm/v4/objects/{from}/{id}/associations/**default**/{to}/{id2}` sin cuerpo (verificada), y `/crm/v4/objects/{from}/{id}/associations/{to}/{id2}` con cuerpo de tipos. No las confundas.
- **`internalcode` en minúsculas** es la propiedad de HubSpot; las propiedades de HubSpot son siempre minúsculas.
- **Los enrichers nunca lanzan.** Loguean y siguen. Es el contrato de `SapRecordEnricherPort`.

## Estructura de archivos

| Archivo | Responsabilidad | Tarea |
|---|---|---|
| `src/infrastructure/hubspot/hubspotClient.js` | `associateObjectsDefault` reemplaza a `associateObjects` | 1 |
| `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js` | Exponer la función nueva | 1 |
| `src/infrastructure/hubspot/associationService.js` | Usar la ruta verificada | 1 |
| `src/domain/business-partners/contact-employees-select.service.js` | Inyectar `ContactEmployees` al `$select` de la tarea de contactos | 2 |
| `src/domain/business-partners/sap-properties-flags.service.js` | Agregar `withPropertiesFlagsSelectFields` (el archivo ya existe) | 3 |
| `src/application/use-cases/SyncSapConfigToHubspot.js` | Cablear las dos inyecciones, el enricher y la compuerta | 4, 6, 9 |
| `src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js` | Banderas de SAP → propiedad multi-select | 5 |
| `src/composition/sap-sync.composition.js` | Cablear el enricher con `assertPort` | 6 |
| `src/application/use-cases/HandleHubspotAssociations.js` | `parentObjectType` en el camino secuencial | 7 |
| `src/application/use-cases/ProcessCrmObjectBatches.js` | Correr el bloque de hijos para ambos objectType | 8 |
| `src/application/use-cases/SyncCompanyContactsInBatches.js` | `parentObjectType` en el camino por lotes | 8 |
| `src/infrastructure/config/AddressSyncConfigRepository.js` | Leer `requireAddress` | 9 |

---

### Task 1: Migrar todas las asociaciones de a una a la ruta verificada

**Esta es la única tarea del plan que cambia conducta existente.** Va primera y sola, para que se pueda revisar y revertir por separado.

**Por qué:** `associateObjects` usa `PUT /crm/v4/objects/{from}/{id}/associations/{to}/{id2}` con cuerpo `[]` — el endpoint que espera una lista de tipos, con la lista vacía. Eso **no** es el endpoint default y **no está verificado**. La ruta `/associations/default/` sí está verificada en vivo contra el portal del cliente. Y migrar **nunca es peor**: si `[]` funcionaba, ambas rutas producen la misma asociación sin etiqueta; si no funcionaba, esto arregla un fallo silencioso. Los errores de asociación se tragan (`associationService.js:176-184`), así que un fallo ahí es invisible hoy.

**Alcance del cambio de conducta:** company↔contact, contact↔company, deal↔contact, deal↔company, deal↔line_item. Todas pasan por el mismo punto.

**Files:**
- Modify: `src/infrastructure/hubspot/hubspotClient.js:394-404`
- Modify: `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js:1-17`
- Modify: `src/infrastructure/hubspot/associationService.js:167-185`
- Modify: `src/application/use-cases/SyncCompanyContactsInBatches.js:896-901`
- Test: `tests/unit/infrastructure/associateObjectsDefault.test.js`

**Interfaces:**
- Consumes: `hubspotRequest(method, endpoint, token, data, opts)` de `hubspotClient.js:31`. Acepta `data` ausente: axios recibe `data: undefined` y no manda cuerpo, que es lo que esta ruta espera.
- Produces: `associateObjectsDefault(token, fromType, fromId, toType, toId)`. Misma firma posicional que la función que reemplaza, así que ningún call site cambia de forma — solo de nombre.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/associateObjectsDefault.test.js`:

```js
import { jest } from '@jest/globals';

const axiosMock = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const { associateObjectsDefault } = await import('../../../src/infrastructure/hubspot/hubspotClient.js');

describe('associateObjectsDefault', () => {
  beforeEach(() => {
    axiosMock.mockReset();
    axiosMock.mockResolvedValue({ data: { status: 'COMPLETE' } });
  });

  it('usa la ruta /associations/default/ y no manda cuerpo', async () => {
    await associateObjectsDefault('tok', 'contact', '233059562020', 'contact', '233053375747');

    expect(axiosMock).toHaveBeenCalledTimes(1);
    const [config] = axiosMock.mock.calls[0];

    expect(config.method).toBe('put');
    expect(config.url).toContain(
      '/crm/v4/objects/contact/233059562020/associations/default/contact/233053375747'
    );
    expect(config.data).toBeUndefined();
    expect(config.headers.Authorization).toBe('Bearer tok');
  });

  it('sirve igual para company -> contact', async () => {
    await associateObjectsDefault('tok', 'company', '1', 'contact', '2');

    const [config] = axiosMock.mock.calls[0];
    expect(config.url).toContain('/crm/v4/objects/company/1/associations/default/contact/2');
  });

  it('devuelve el cuerpo de la respuesta', async () => {
    const result = await associateObjectsDefault('tok', 'contact', '1', 'contact', '2');

    expect(result).toEqual({ status: 'COMPLETE' });
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/associateObjectsDefault.test.js`
Expected: FAIL — `associateObjectsDefault is not a function`.

- [ ] **Step 3: Reemplaza la función en el cliente**

En `src/infrastructure/hubspot/hubspotClient.js`, reemplaza el bloque de las líneas 394-404 (el comentario y `associateObjects`) por:

```js
// Ruta `default` de la API v4: sin cuerpo, HubSpot aplica el tipo sin etiqueta
// del par. Verificada en vivo el 2026-08-11 para contact->contact (typeId 449,
// HUBSPOT_DEFINED, label null), donde además crea LAS DOS direcciones en una
// sola llamada -- nunca asocies el mismo par dos veces.
//
// Deliberadamente NO es la ruta `/associations/{to}/{id}` con cuerpo de tipos:
// esa espera al menos un {associationCategory, associationTypeId} y la versión
// anterior de esta función le mandaba `[]`, sin verificar nunca que funcionara.
//
// Enrutada por hubspotRequest y no por axios crudo para que también respete el
// rate limit: es el fallback por par del batch de asociaciones, o sea corre
// justo en los bucles apretados que más lo necesitan.
export async function associateObjectsDefault(token, fromType, fromId, toType, toId) {
  return hubspotRequest(
    'put',
    `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`,
    token,
  );
}
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/infrastructure/associateObjectsDefault.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Actualiza los tres call sites**

En `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js`, cambia el import y el objeto congelado:

```js
import {
  associateObjectsDefault,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
} from './hubspotClient.js';

export const hubspotCrmBatchAdapter = Object.freeze({
  associateObjectsDefault,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
});

export default hubspotCrmBatchAdapter;
```

En `src/infrastructure/hubspot/associationService.js`, dentro de `associateObjectsBySapId`, línea 169:

```js
      await hubspotClient.associateObjectsDefault(
        resolvedToken,
        fromObjectType,
        fromHubspotId,
        toObjectType,
        toHubspotId
      );
```

En `src/application/use-cases/SyncCompanyContactsInBatches.js`, línea 900:

```js
              await this.retry(() =>
                this.crmBatchClient.associateObjectsDefault(token, 'company', fromId, 'contact', toId)
              );
```

- [ ] **Step 6: Buscá cualquier referencia que haya quedado**

```bash
grep -rn "associateObjects\b" src/ tests/
```

Expected: solo apariciones de `associateObjectsDefault` y de `associateObjectsBySapId`. Si queda un `associateObjects` suelto (por ejemplo en `tests/unit/infrastructure/hubspotTransport.test.js:55`), actualizalo: el test debe esperar la URL con `/associations/default/` y sin cuerpo.

- [ ] **Step 7: Corre la suite completa**

Run: `npm test`
Expected: sin fallos nuevos. Los tests que verificaban la URL vieja van a fallar — **actualizalos al comportamiento nuevo**, que es el correcto; no revirtas el cambio.

- [ ] **Step 8: Commit**

```bash
git add src/infrastructure/hubspot/hubspotClient.js src/infrastructure/hubspot/hubspot-crm-batch.adapter.js src/infrastructure/hubspot/associationService.js src/application/use-cases/SyncCompanyContactsInBatches.js tests/
git commit -m "fix: use the verified HubSpot v4 default association route"
```

---

### Task 2: Inyectar `ContactEmployees` al `$select` de la tarea de contactos

**Files:**
- Create: `src/domain/business-partners/contact-employees-select.service.js`
- Test: `tests/unit/domain/contactEmployeesSelectField.test.js`

**Interfaces:**
- Consumes: nada (función pura).
- Produces: `withContactEmployeesSelectField(mappings, { objectType, sourceContext }) -> mappings[]`. Devuelve la **misma referencia** si no hay nada que inyectar.

**El `sourceContext` del sintético es load-bearing.** `sanitizeSelectFields` (`src/infrastructure/sap/serviceLayerUrlBuilder.js:21-41`) excluye del `$select` todo mapping con `sourceContext: 'contactEmployee'` — y tras el plan hermano también `'bpAddress'`. Un sintético con contexto `contactEmployee` **se filtraría a sí mismo**, y el bug sería invisible: el `$select` sale sin el campo, SAP devuelve registros sin `ContactEmployees`, el array llega vacío y nadie se entera. Por eso lleva `'businessPartner'`.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/domain/contactEmployeesSelectField.test.js`:

```js
import { withContactEmployeesSelectField }
  from '../../../src/domain/business-partners/contact-employees-select.service.js';
import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

const BASE = [
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
  { sourceField: 'CardName', targetField: 'firstname', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
];

describe('withContactEmployeesSelectField', () => {
  it('inyecta ContactEmployees cuando el objectType es contact', () => {
    const result = withContactEmployeesSelectField(BASE, { objectType: 'contact', sourceContext: 'businessPartner' });

    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      sourceField: 'ContactEmployees',
      targetField: null,
      objectType: 'contact',
      sourceContext: 'businessPartner',
      includeInServiceLayerSelect: true,
      isActive: true,
    });
  });

  it('NO inyecta para company: ese ya llega por la variable de entorno', () => {
    const result = withContactEmployeesSelectField(BASE, { objectType: 'company', sourceContext: 'businessPartner' });

    expect(result).toBe(BASE);
  });

  it('no inyecta para product ni deal', () => {
    expect(withContactEmployeesSelectField(BASE, { objectType: 'product' })).toBe(BASE);
    expect(withContactEmployeesSelectField(BASE, { objectType: 'deal' })).toBe(BASE);
  });

  it('no duplica si ya hay un mapping para ContactEmployees', () => {
    const withField = [
      ...BASE,
      { sourceField: 'ContactEmployees', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
    ];

    expect(withContactEmployeesSelectField(withField, { objectType: 'contact' })).toBe(withField);
  });

  it('SI inyecta cuando el mapping existente esta excluido del select', () => {
    const withExcluded = [
      ...BASE,
      { sourceField: 'ContactEmployees', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: false, isActive: true },
    ];

    const result = withContactEmployeesSelectField(withExcluded, { objectType: 'contact' });

    expect(result).toHaveLength(4);
  });

  it('tolera una lista de mappings vacia o invalida', () => {
    expect(withContactEmployeesSelectField([], { objectType: 'contact' })).toHaveLength(1);
    expect(withContactEmployeesSelectField(null, { objectType: 'contact' })).toHaveLength(1);
  });

  // EL TEST QUE IMPORTA: el sintetico tiene que sobrevivir a sanitizeSelectFields.
  it('el campo inyectado llega hasta la URL final del Service Layer', () => {
    const mappings = withContactEmployeesSelectField(BASE, { objectType: 'contact', sourceContext: 'businessPartner' });

    const url = buildServiceLayerUrl(
      { apiUrl: 'https://sap.example.com', serviceLayerPath: '/BusinessPartners', objectType: 'contact', mode: 'FULL' },
      mappings
    );

    expect(url).toContain('ContactEmployees');
  });

  it('un sintetico con sourceContext contactEmployee NO llegaria a la URL (por eso usamos businessPartner)', () => {
    const url = buildServiceLayerUrl(
      { apiUrl: 'https://sap.example.com', serviceLayerPath: '/BusinessPartners', objectType: 'contact', mode: 'FULL' },
      [...BASE, { sourceField: 'ContactEmployees', targetField: null, sourceContext: 'contactEmployee', includeInServiceLayerSelect: true, isActive: true }]
    );

    expect(url).not.toContain('ContactEmployees');
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/domain/contactEmployeesSelectField.test.js`
Expected: FAIL — `Cannot find module ... contact-employees-select.service.js`.

- [ ] **Step 3: Implementa la función**

Crea `src/domain/business-partners/contact-employees-select.service.js`:

```js
// SAP B1 devuelve los ContactEmployees como colección anidada del
// BusinessPartner, pero solo si el campo está en el $select. Hoy solo entra por
// la variable de entorno COMPANY_ADD_FIELDS_URL_SAP, cuyo mapa es
// { company, product, deal } (serviceLayerUrlBuilder.js:43-47): NO existe la
// equivalente para 'contact', así que en la tarea de contactos el campo nunca
// llega. Este mapping sintético lo arregla por tenant en vez de por despliegue.
//
// Mismo molde que withDynamicDescriptionSelectFields
// (src/domain/sync/dynamic-description.service.js:288-315): entradas con
// targetField null que solo sirven para armar el request a SAP y nunca escriben
// propiedades de HubSpot. No contaminan el mapeo porque mapRecords vuelve a
// consultar los mappings desde Mongo por su cuenta.
const CONTACT_EMPLOYEES_FIELD = 'ContactEmployees';

// Load-bearing: sanitizeSelectFields (serviceLayerUrlBuilder.js:21-41) excluye
// del $select todo mapping con sourceContext 'contactEmployee'. Un sintético con
// ese contexto se filtraría a sí mismo, y el síntoma sería invisible: $select sin
// el campo, SAP sin la colección, array vacío, cero errores.
const SYNTHETIC_SOURCE_CONTEXT = 'businessPartner';

function cleanString(value) {
  return String(value ?? '').trim();
}

export function withContactEmployeesSelectField(mappings, { objectType, sourceContext } = {}) {
  const baseMappings = Array.isArray(mappings) ? mappings : [];

  // Para 'company' el campo ya llega por la variable de entorno que los tenants
  // existentes tienen configurada. Solo la tarea de contactos lo necesita.
  if (objectType !== 'contact') {
    return Array.isArray(mappings) ? mappings : baseMappings;
  }

  const alreadySelected = baseMappings
    .filter((mapping) => mapping?.includeInServiceLayerSelect !== false)
    .some((mapping) => cleanString(mapping?.sourceField) === CONTACT_EMPLOYEES_FIELD);

  if (alreadySelected) {
    return mappings;
  }

  return [
    ...baseMappings,
    {
      sourceField: CONTACT_EMPLOYEES_FIELD,
      targetField: null,
      objectType: objectType ?? null,
      sourceContext: sourceContext ?? SYNTHETIC_SOURCE_CONTEXT,
      includeInServiceLayerSelect: true,
      isActive: true,
    },
  ];
}

export default { withContactEmployeesSelectField };
```

> Ojo con el `sourceContext ?? SYNTHETIC_SOURCE_CONTEXT` del final: el llamador pasa `'businessPartner'` (es el `sourceContext` que `SyncSapConfigToHubspot` calcula en su línea 73), así que el default casi nunca aplica. Pero si algún día alguien llama sin ese argumento, el fallback tiene que ser `'businessPartner'` y **nunca** `'contactEmployee'`.

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/domain/contactEmployeesSelectField.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/business-partners/contact-employees-select.service.js tests/unit/domain/contactEmployeesSelectField.test.js
git commit -m "feat: inject ContactEmployees into the contact sync \$select"
```

---

### Task 3: Inyectar `Properties1..64` al `$select`

**Files:**
- Modify: `src/domain/business-partners/sap-properties-flags.service.js` (creado por el plan hermano)
- Test: `tests/unit/domain/propertiesFlagsSelectFields.test.js`

**Interfaces:**
- Consumes: `listSapPropertiesFieldNames(config)` y `PROPERTIES_FLAGS_STRATEGIES`, ambos del plan hermano.
- Produces: `withPropertiesFlagsSelectFields(mappings, config, { objectType, sourceContext }) -> mappings[]`. Devuelve la **misma referencia** si la strategy está apagada.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/domain/propertiesFlagsSelectFields.test.js`:

```js
import { withPropertiesFlagsSelectFields }
  from '../../../src/domain/business-partners/sap-properties-flags.service.js';

const BASE = [
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
];

const ON = { strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 64, trueValue: 'tYES' };
const OFF = { ...ON, strategy: 'none' };

describe('withPropertiesFlagsSelectFields', () => {
  it('inyecta los 64 campos', () => {
    const result = withPropertiesFlagsSelectFields(BASE, ON, { objectType: 'company', sourceContext: 'businessPartner' });

    expect(result).toHaveLength(1 + 64);
    const injected = result.slice(1).map((mapping) => mapping.sourceField);
    expect(injected[0]).toBe('Properties1');
    expect(injected[63]).toBe('Properties64');
  });

  it('los sinteticos llevan targetField null y no escriben propiedades', () => {
    const result = withPropertiesFlagsSelectFields(BASE, ON, { objectType: 'company', sourceContext: 'businessPartner' });

    for (const mapping of result.slice(1)) {
      expect(mapping.targetField).toBeNull();
      expect(mapping.includeInServiceLayerSelect).toBe(true);
      expect(mapping.isActive).toBe(true);
      expect(mapping.sourceContext).toBe('businessPartner');
    }
  });

  it('devuelve la misma referencia cuando la strategy esta apagada', () => {
    expect(withPropertiesFlagsSelectFields(BASE, OFF, { objectType: 'company' })).toBe(BASE);
    expect(withPropertiesFlagsSelectFields(BASE, null, { objectType: 'company' })).toBe(BASE);
  });

  it('respeta un rango personalizado', () => {
    const result = withPropertiesFlagsSelectFields(BASE, { ...ON, min: 10, max: 12 }, { objectType: 'company' });

    expect(result.slice(1).map((mapping) => mapping.sourceField))
      .toEqual(['Properties10', 'Properties11', 'Properties12']);
  });

  it('deduplica contra un mapping que ya declare Properties5', () => {
    const withFive = [
      ...BASE,
      { sourceField: 'Properties5', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
    ];

    const result = withPropertiesFlagsSelectFields(withFive, { ...ON, min: 1, max: 6 }, { objectType: 'company' });

    const injected = result.slice(2).map((mapping) => mapping.sourceField);
    expect(injected).toEqual(['Properties1', 'Properties2', 'Properties3', 'Properties4', 'Properties6']);
  });

  it('un mapping excluido del select NO cuenta como cubierto', () => {
    const withExcluded = [
      ...BASE,
      { sourceField: 'Properties5', targetField: 'algo', sourceContext: 'businessPartner', includeInServiceLayerSelect: false, isActive: true },
    ];

    const result = withPropertiesFlagsSelectFields(withExcluded, { ...ON, min: 5, max: 5 }, { objectType: 'company' });

    expect(result.slice(2).map((mapping) => mapping.sourceField)).toEqual(['Properties5']);
  });

  it('tolera una lista de mappings vacia', () => {
    expect(withPropertiesFlagsSelectFields([], { ...ON, min: 1, max: 2 }, { objectType: 'company' }))
      .toHaveLength(2);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/domain/propertiesFlagsSelectFields.test.js`
Expected: FAIL — `withPropertiesFlagsSelectFields is not a function`.

- [ ] **Step 3: Agrega la función al servicio existente**

En `src/domain/business-partners/sap-properties-flags.service.js`, después de `listSapPropertiesFieldNames`, agrega:

```js
// Los 64 campos PropertiesN no pueden tener filas de FieldMapping propias (son
// N campos de SAP -> 1 propiedad de HubSpot, y el índice único del modelo es por
// sourceField), así que sin esto nunca llegarían al $select. Mismo molde que
// withDynamicDescriptionSelectFields (dynamic-description.service.js:288-315):
// entradas sintéticas con targetField null, que solo sirven para armar el
// request a SAP. No contaminan el mapeo porque mapRecords vuelve a consultar los
// mappings desde Mongo por su cuenta.
export function withPropertiesFlagsSelectFields(mappings, config, { objectType, sourceContext } = {}) {
  const baseMappings = Array.isArray(mappings) ? mappings : [];
  const requiredFields = listSapPropertiesFieldNames(config);

  if (requiredFields.length === 0) {
    return Array.isArray(mappings) ? mappings : baseMappings;
  }

  const alreadySelected = new Set(
    baseMappings
      .filter((mapping) => mapping?.includeInServiceLayerSelect !== false)
      .map((mapping) => String(mapping?.sourceField ?? '').trim())
      .filter(Boolean)
  );

  const missing = requiredFields
    .filter((field) => !alreadySelected.has(field))
    .map((field) => ({
      sourceField: field,
      targetField: null,
      objectType: objectType ?? null,
      sourceContext: sourceContext ?? null,
      includeInServiceLayerSelect: true,
      isActive: true,
    }));

  return missing.length > 0 ? [...baseMappings, ...missing] : mappings;
}
```

Agregala también al `export default` del archivo.

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/domain/propertiesFlagsSelectFields.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/business-partners/sap-properties-flags.service.js tests/unit/domain/propertiesFlagsSelectFields.test.js
git commit -m "feat: inject Properties1..64 into the SAP \$select"
```

---

### Task 4: Cablear las dos inyecciones en el use-case

**Files:**
- Modify: `src/application/use-cases/SyncSapConfigToHubspot.js:73-94`
- Test: `tests/unit/application/syncSapConfigSelectInjection.test.js`

**Interfaces:**
- Consumes: `withContactEmployeesSelectField` (Tarea 2), `withPropertiesFlagsSelectFields` (Tarea 3), `BusinessPartnerCreationConfigRepository.getPropertiesFlagsConfig` (plan hermano).
- Produces: `fetchOptions.mappings` con los campos inyectados. La Tarea 5 depende de que `ContactEmployees` y `PropertiesN` lleguen en `rawSapData`.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/application/syncSapConfigSelectInjection.test.js`. Verifica que el use-case pase los campos inyectados al data source.

**Dos detalles de la firma real, verificados:** `execute` recibe `{ config, configId, tenantContext }` — **no** `clientConfigId` —, y pasando `config` directo se evita el doble de `clientConfigRepository.findById` (`SyncSapConfigToHubspot.js:36-48`). Y el constructor **hoy no tiene `logger`**: se lo agrega en la Tarea 6, así que este test todavía no lo pasa.

```js
import { jest } from '@jest/globals';
import { SyncSapConfigToHubspot } from '../../../src/application/use-cases/SyncSapConfigToHubspot.js';

const CONFIG = (objectType) => ({
  _id: 'cfg1', id: 'cfg1', active: true, objectType,
  hubspotCredentialId: 'cred1', mode: 'FULL',
});

function buildDeps({ objectType, propertiesFlagsConfig }) {
  const fetchData = jest.fn().mockResolvedValue([]);

  return {
    fetchData,
    config: CONFIG(objectType),
    useCase: new SyncSapConfigToHubspot({
      sapDataSource: { fetchData },
      mappingRepository: {
        ensureDefaultMappings: async () => {},
        findMappings: async () => ([
          { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
        ]),
        getDynamicDescriptionConfig: async () => null,
        mapRecords: async () => [],
      },
      hubspotSyncTarget: { send: jest.fn() },
      syncLogRepository: {
        start: async () => ({ _id: 'log1' }),
        finish: async () => {},
        markSyncSucceeded: async () => {},
      },
      clientConfigRepository: { findById: async () => CONFIG(objectType) },
      // Devuelve null a propósito: el use-case corta ahí con 'No HubSpot
      // credentials', DESPUES de haber llamado a fetchData, que es lo que este
      // test observa.
      hubspotCredentialRepository: { findByClientConfig: async () => null },
      businessPartnerCreationConfigRepository: {
        getPropertiesFlagsConfig: async () => propertiesFlagsConfig,
      },
      dateProvider: () => new Date('2026-08-11T00:00:00Z'),
    }),
  };
}

const FLAGS_ON = { strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 3, trueValue: 'tYES' };
const FLAGS_OFF = { strategy: 'none', hubspotProperty: null, min: 1, max: 64, trueValue: 'tYES' };

function selectedFields(fetchData) {
  return fetchData.mock.calls[0][0].fetchOptions.mappings.map((mapping) => mapping.sourceField);
}

describe('SyncSapConfigToHubspot — inyeccion al $select', () => {
  it('para contact inyecta ContactEmployees y las PropertiesN', async () => {
    const { fetchData, useCase, config } = buildDeps({ objectType: 'contact', propertiesFlagsConfig: FLAGS_ON });

    await useCase.execute({ config, tenantContext: { tenantModels: {} } });

    const fields = selectedFields(fetchData);
    expect(fields).toContain('ContactEmployees');
    expect(fields).toContain('Properties1');
    expect(fields).toContain('Properties3');
  });

  it('para company inyecta las PropertiesN pero NO ContactEmployees', async () => {
    const { fetchData, useCase, config } = buildDeps({ objectType: 'company', propertiesFlagsConfig: FLAGS_ON });

    await useCase.execute({ config, tenantContext: { tenantModels: {} } });

    const fields = selectedFields(fetchData);
    expect(fields).not.toContain('ContactEmployees');
    expect(fields).toContain('Properties1');
  });

  // GUARDIA DE REGRESION
  it('con la config apagada el $select queda exactamente como hoy', async () => {
    const { fetchData, useCase, config } = buildDeps({ objectType: 'company', propertiesFlagsConfig: FLAGS_OFF });

    await useCase.execute({ config, tenantContext: { tenantModels: {} } });

    expect(selectedFields(fetchData)).toEqual(['CardCode']);
  });

  it('sin el repositorio inyectado el $select no cambia', async () => {
    const fetchData = jest.fn().mockResolvedValue([]);
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: { fetchData },
      mappingRepository: {
        ensureDefaultMappings: async () => {},
        findMappings: async () => ([{ sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true }]),
        getDynamicDescriptionConfig: async () => null,
        mapRecords: async () => [],
      },
      hubspotSyncTarget: { send: jest.fn() },
      syncLogRepository: { start: async () => ({ _id: 'log1' }), finish: async () => {}, markSyncSucceeded: async () => {} },
      clientConfigRepository: { findById: async () => CONFIG('contact') },
      hubspotCredentialRepository: { findByClientConfig: async () => null },
      dateProvider: () => new Date('2026-08-11T00:00:00Z'),
    });

    await useCase.execute({ config: CONFIG('contact'), tenantContext: { tenantModels: {} } });

    // ContactEmployees SI se inyecta (no depende de la config); las PropertiesN no.
    const fields = selectedFields(fetchData);
    expect(fields).toContain('ContactEmployees');
    expect(fields.filter((field) => field.startsWith('Properties'))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/application/syncSapConfigSelectInjection.test.js`
Expected: FAIL — los campos inyectados no aparecen en `fetchOptions.mappings`.

- [ ] **Step 3: Agrega los imports y las dependencias al constructor**

En `src/application/use-cases/SyncSapConfigToHubspot.js`, agrega los imports:

```js
import { withPropertiesFlagsSelectFields } from '#domain/business-partners/sap-properties-flags.service.js';
import { withContactEmployeesSelectField } from '#domain/business-partners/contact-employees-select.service.js';
```

En el constructor (líneas 6-33), agrega **cuatro** parámetros después de `warehouseStockEnricher = null,` — los cuatro con default, así ningún llamador existente se rompe:

```js
    warehouseStockEnricher = null,
    propertiesFlagsEnricher = null,
    businessPartnerCreationConfigRepository = null,
    addressSyncConfigRepository = null,
    // Este constructor no tenía logger. Las tareas 6 y 9 registran warnings, así
    // que se agrega ahora con default console, igual que HandleHubspotAssociations.
    logger = console,
    dateProvider = () => new Date(),
  }) {
```

y las cuatro asignaciones correspondientes en el cuerpo:

```js
    this.warehouseStockEnricher = warehouseStockEnricher;
    this.propertiesFlagsEnricher = propertiesFlagsEnricher;
    this.businessPartnerCreationConfigRepository = businessPartnerCreationConfigRepository;
    this.addressSyncConfigRepository = addressSyncConfigRepository;
    this.logger = logger;
    this.dateProvider = dateProvider;
```

> `propertiesFlagsEnricher` y `addressSyncConfigRepository` los usan las tareas 6 y 9; se declaran acá de una sola vez para no tocar el constructor tres veces.

- [ ] **Step 4: Envuelve `fetchOptions.mappings`**

Reemplaza el bloque de las líneas 88-94 por:

```js
      // Properties1..64 y ContactEmployees no pueden tener filas de FieldMapping
      // propias, así que se inyectan como mappings sintéticos. Solo afectan el
      // $select del request a SAP: mapRecords vuelve a consultar los mappings
      // desde Mongo y nunca ve estos.
      const propertiesFlagsConfig = this.businessPartnerCreationConfigRepository
        ? await this.businessPartnerCreationConfigRepository.getPropertiesFlagsConfig({
          tenantModels: tenantContext?.tenantModels,
        })
        : null;

      const fetchOptions = {
        ...buildSapFetchOptions(activeConfig, this.dateProvider),
        mappings: withContactEmployeesSelectField(
          withPropertiesFlagsSelectFields(
            withDynamicDescriptionSelectFields(sapMappings, dynamicDescriptionConfig, {
              objectType: activeConfig.objectType,
              sourceContext,
            }),
            propertiesFlagsConfig,
            { objectType: activeConfig.objectType, sourceContext }
          ),
          { objectType: activeConfig.objectType, sourceContext }
        ),
      };
```

- [ ] **Step 5: Corre el test y luego la suite completa**

Run: `npm test -- tests/unit/application/syncSapConfigSelectInjection.test.js`
Expected: PASS, 3 tests.

Run: `npm test`
Expected: sin fallos nuevos. Sin el repositorio inyectado (todos los tests existentes), `propertiesFlagsConfig` es `null` y las dos funciones devuelven los mappings intactos.

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/SyncSapConfigToHubspot.js tests/unit/application/syncSapConfigSelectInjection.test.js
git commit -m "feat: wire the \$select injections into the SAP sync use case"
```

---

### Task 5: El enricher de `Properties1..64`

**Files:**
- Create: `src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js`
- Test: `tests/unit/infrastructure/propertiesFlagsEnrichmentAdapter.test.js`

**Interfaces:**
- Consumes: `readSapPropertiesFlags` (plan hermano), `resolveSapFlavor` de `#infrastructure/config/SapFlavorConfigRepository.js`, `SAP_FLAVORS` de `#domain/sap/sap-flavor.constants.js`.
- Produces: `class PropertiesFlagsEnrichmentAdapter` con `enrich({ mappedRecords, objectType, tenantModels })`, cumpliendo `SapRecordEnricherPort`. Muta `record.properties` en el lugar; **nunca lanza**.

**Escribe en `record.properties`, no en `record.rawSapData`.** El enricher de almacenes usa `rawSapData` porque `product.handler.js` tiene un paso que lo mueve a properties; para company/contact **no existe** ese paso, y `ProcessCrmObjectBatches`/`SendMappedItemsToHubspot` leen `item.properties`.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/propertiesFlagsEnrichmentAdapter.test.js`:

```js
import { jest } from '@jest/globals';
import PropertiesFlagsEnrichmentAdapter
  from '../../../src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { SapRecordEnricherPort } from '../../../src/application/ports/sap/sap-record-enricher.port.js';

const ON = { strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 64, trueValue: 'tYES' };
const OFF = { strategy: 'none', hubspotProperty: null, min: 1, max: 64, trueValue: 'tYES' };

function buildAdapter({ config = ON, flavor = 'B1' } = {}) {
  return new PropertiesFlagsEnrichmentAdapter({
    configRepository: { getPropertiesFlagsConfig: jest.fn().mockResolvedValue(config) },
    flavorResolver: jest.fn().mockResolvedValue(flavor),
    logger: { warn: jest.fn(), error: jest.fn() },
  });
}

function buildRecords() {
  return [
    { properties: { idsap: 'C1' }, rawSapData: { Properties1: 'tYES', Properties2: 'tNO', Properties55: 'tYES' } },
    { properties: { idsap: 'C2' }, rawSapData: { Properties1: 'tNO' } },
  ];
}

describe('PropertiesFlagsEnrichmentAdapter', () => {
  it('cumple el puerto', () => {
    expect(() => assertPort(buildAdapter(), SapRecordEnricherPort)).not.toThrow();
  });

  it('escribe el string unido en la propiedad configurada', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties.groupname).toBe('1;55');
  });

  // EL CASO DE DESELECCION: SAP es la fuente de la verdad.
  it('escribe string vacio cuando ninguna bandera esta en tYES', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[1].properties.groupname).toBe('');
    expect(records[1].properties).toHaveProperty('groupname');
  });

  it('sirve igual para objectType contact', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'contact', tenantModels: {} });

    expect(records[0].properties.groupname).toBe('1;55');
  });

  it('no escribe nada cuando la strategy esta apagada', async () => {
    const records = buildRecords();
    await buildAdapter({ config: OFF }).enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('no escribe nada cuando falta hubspotProperty', async () => {
    const records = buildRecords();
    await buildAdapter({ config: { ...ON, hubspotProperty: null } })
      .enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('es no-op en S/4', async () => {
    const records = buildRecords();
    await buildAdapter({ flavor: 'S4' }).enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it.each(['product', 'deal', 'invoice'])('es no-op para objectType %s', async (objectType) => {
    const records = buildRecords();
    const adapter = buildAdapter();
    await adapter.enrich({ mappedRecords: records, objectType, tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
    expect(adapter.configRepository.getPropertiesFlagsConfig).not.toHaveBeenCalled();
  });

  it('sin tenantModels no hace nada', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: null });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('salta los registros sin rawSapData sin romper los demas', async () => {
    const records = [{ properties: {} }, ...buildRecords()];
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
    expect(records[1].properties.groupname).toBe('1;55');
  });

  it('NUNCA lanza: un fallo al leer la config se loguea y sigue', async () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const adapter = new PropertiesFlagsEnrichmentAdapter({
      configRepository: { getPropertiesFlagsConfig: jest.fn().mockRejectedValue(new Error('mongo caido')) },
      flavorResolver: jest.fn().mockResolvedValue('B1'),
      logger,
    });

    const records = buildRecords();
    await expect(adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} }))
      .resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('lee la config UNA sola vez por corrida, no por registro', async () => {
    const adapter = buildAdapter();
    await adapter.enrich({ mappedRecords: buildRecords(), objectType: 'company', tenantModels: {} });

    expect(adapter.configRepository.getPropertiesFlagsConfig).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/propertiesFlagsEnrichmentAdapter.test.js`
Expected: FAIL — `Cannot find module ... PropertiesFlagsEnrichmentAdapter.js`.

- [ ] **Step 3: Implementa el adapter**

Crea `src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js`:

```js
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';
import { readSapPropertiesFlags } from '#domain/business-partners/sap-properties-flags.service.js';

// Traduce las 64 banderas booleanas PropertiesN del BusinessPartner de SAP B1 a
// UNA propiedad multi-select de HubSpot, unida por ';'. Mismo contrato que
// S4ContactEnrichmentAdapter y WarehouseStockEnrichmentAdapter: enriquece el set
// de registros mapeados en el lugar y falla en silencio, para que una config
// rota nunca aborte la sincronización.
//
// No puede ser un FieldMapping: son N campos de SAP -> 1 propiedad de HubSpot, y
// el índice único del modelo es por sourceField.
const ENRICHED_OBJECT_TYPES = new Set(['company', 'contact']);

export class PropertiesFlagsEnrichmentAdapter {
  constructor({
    configRepository,
    // Overridable para los tests.
    flavorResolver = ({ tenantModels }) => resolveSapFlavor({ tenantModels }),
    logger = console,
  }) {
    this.configRepository = configRepository;
    this.flavorResolver = flavorResolver;
    this.logger = logger;
  }

  async enrich({ mappedRecords, objectType, tenantModels }) {
    // Un BusinessPartner puede ser jurídico (company) o persona (contact); las
    // PropertiesN son campos de la cabecera del BP, así que existen en ambos.
    if (!ENRICHED_OBJECT_TYPES.has(objectType) || !tenantModels) {
      return;
    }

    const records = Array.isArray(mappedRecords) ? mappedRecords : [];

    try {
      const config = await this.configRepository.getPropertiesFlagsConfig({ tenantModels });

      if (!config?.hubspotProperty) {
        return;
      }

      // Properties1..64 son campos de BusinessPartners de B1; A_BusinessPartner
      // de S/4 no los tiene.
      const sapFlavor = await this.flavorResolver({ tenantModels });

      if (sapFlavor !== SAP_FLAVORS.B1) {
        this.logger.warn?.('PropertiesN enrichment skipped: solo aplica a SAP B1', { sapFlavor });
        return;
      }

      for (const record of records) {
        if (!record?.rawSapData || !record?.properties) {
          continue;
        }

        const value = readSapPropertiesFlags({ sapRecord: record.rawSapData, config });

        // null = la strategy está apagada, no se toca la propiedad.
        // '' = la strategy está activa y no hay ninguna marcada: se escribe para
        // DESELECCIONAR todo en HubSpot. SAP es la fuente de la verdad, y
        // sanitizeProperties descarta null/undefined pero conserva ''.
        if (value !== null) {
          record.properties[config.hubspotProperty] = value;
        }
      }
    } catch (error) {
      this.logger.error?.('PropertiesN enrichment failed', { error: error?.message });
    }
  }
}

export default PropertiesFlagsEnrichmentAdapter;
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/infrastructure/propertiesFlagsEnrichmentAdapter.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js tests/unit/infrastructure/propertiesFlagsEnrichmentAdapter.test.js
git commit -m "feat: enrich company/contact records with SAP PropertiesN flags"
```

---

### Task 6: Cablear el enricher

**Files:**
- Modify: `src/application/use-cases/SyncSapConfigToHubspot.js:162-168`
- Modify: `src/composition/sap-sync.composition.js:69-97`
- Test: `tests/unit/composition/propertiesFlagsEnricherWiring.test.js`

**Interfaces:**
- Consumes: `PropertiesFlagsEnrichmentAdapter` (Tarea 5), `BusinessPartnerCreationConfigRepository` (plan hermano), `assertPort` + `SapRecordEnricherPort`.
- Produces: nada nuevo.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/composition/propertiesFlagsEnricherWiring.test.js`:

```js
import { jest } from '@jest/globals';
import PropertiesFlagsEnrichmentAdapter
  from '../../../src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js';
import BusinessPartnerCreationConfigRepository
  from '../../../src/infrastructure/config/BusinessPartnerCreationConfigRepository.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { SapRecordEnricherPort } from '../../../src/application/ports/sap/sap-record-enricher.port.js';

describe('cableado del enricher de PropertiesN', () => {
  it('el adapter cableado con su repositorio real cumple el puerto', () => {
    const adapter = new PropertiesFlagsEnrichmentAdapter({
      configRepository: new BusinessPartnerCreationConfigRepository(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });

    expect(() => assertPort(adapter, SapRecordEnricherPort)).not.toThrow();
  });
});
```

- [ ] **Step 2: Corre el test**

Run: `npm test -- tests/unit/composition/propertiesFlagsEnricherWiring.test.js`
Expected: PASS (las dos piezas ya existen). Es la red de seguridad del cableado que vas a escribir.

- [ ] **Step 3: Invoca el enricher en el use-case**

En `src/application/use-cases/SyncSapConfigToHubspot.js`, después del bloque de `warehouseStockEnricher` (líneas 162-168), agrega:

```js
      // Traduce las banderas PropertiesN de SAP a la propiedad multi-select de
      // HubSpot (no-op para product/deal y para tenants S/4). Corre después de
      // mapRecords porque necesita rawSapData, y antes de sendMappedRecords para
      // que sanitizeProperties vea el valor ya resuelto.
      if (this.propertiesFlagsEnricher) {
        await this.propertiesFlagsEnricher.enrich({
          mappedRecords: mappedRecordsWithRawSap,
          objectType,
          tenantModels: tenantContext?.tenantModels,
        });
      }
```

Agregá `propertiesFlagsEnricher = null` al constructor y asignalo a `this`.

- [ ] **Step 4: Cablea en la composition**

En `src/composition/sap-sync.composition.js`, junto a los otros enrichers, agrega los imports:

```js
import PropertiesFlagsEnrichmentAdapter from '#infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js';
import BusinessPartnerCreationConfigRepository from '#infrastructure/config/BusinessPartnerCreationConfigRepository.js';
```

y en la construcción del use-case:

```js
const businessPartnerCreationConfigRepository = new BusinessPartnerCreationConfigRepository();

// ... dentro de las dependencias de SyncSapConfigToHubspot:
  businessPartnerCreationConfigRepository,
  propertiesFlagsEnricher: assertPort(
    new PropertiesFlagsEnrichmentAdapter({
      configRepository: businessPartnerCreationConfigRepository,
      logger,
    }),
    SapRecordEnricherPort
  ),
```

> `businessPartnerCreationConfigRepository` se pasa **también** suelto porque la Tarea 4 lo usa para la inyección al `$select`. Es la misma instancia: una sola lectura de config por corrida.

> **Sobre la compuerta de flavor de `propertiesFlags`** (agregada durante la ejecución, dentro de `getPropertiesFlagsConfig`, para que un tenant que no sea B1 resuelva la config a "apagado" en el origen en vez de depender de la comprobación de flavor del enricher): como vive en el **repositorio** y no en el enricher, protege silenciosamente a un consumidor **aparte** del que motivó el cambio — el camino de creación HubSpot→SAP por webhook (`TenantWebhookRuntimeRepository.resolvePropertiesFlagsConfig` → `ProcessHubspotWebhookEvent.js` / `webhookQuotationSupport.js`), que con esa compuerta ya nunca puede escribir campos `PropertiesN` en un payload de creación de BusinessPartner de S/4, algo que `A_BusinessPartner` no soporta. Es la corrección de un bug latente como efecto secundario, no una regresión, pero vale documentarlo.

- [ ] **Step 5: Corre la suite completa**

Run: `npm test`
Expected: sin fallos nuevos.

- [ ] **Step 6: Commit**

```bash
git add src/application/use-cases/SyncSapConfigToHubspot.js src/composition/sap-sync.composition.js tests/unit/composition/propertiesFlagsEnricherWiring.test.js
git commit -m "feat: wire the PropertiesN enricher into the SAP sync"
```

---

### Task 7: Hijos con padre contacto — camino secuencial

**Files:**
- Modify: `src/application/use-cases/HandleHubspotAssociations.js:111-119` (pasar `syncLogId` y devolver el resultado)
- Modify: `src/application/use-cases/HandleHubspotAssociations.js:409-435` (llamar a `syncCompanyContacts`)
- Modify: `src/application/use-cases/HandleHubspotAssociations.js:214-221, 383-393` (`parentObjectType` y la guarda)
- Test: `tests/unit/application/contactParentChildContacts.test.js`

**Interfaces:**
- Consumes: `associationService.associateObjectsBySapId`, que **ya está exportada** (`associationService.js:268`) y ya recibe `fromObjectType` como parámetro — no hace falta ninguna función envoltorio nueva.
- Produces: `syncCompanyContacts` acepta `parentObjectType = 'company'`. `handleContactAssociations` devuelve `{ contactErrors }` igual que `handleCompanyAssociations`.

**`ASSOCIATION_MAP` no se toca.** Ese mapa gobierna qué asociaciones se buscan en SAP (`fetchAssociationsIfNeeded`), no la sincronización de hijos, que se invoca aparte al final de `handleCompanyAssociations`. Agregarle `contact: ['contact']` dispararía consultas que nadie pidió.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/application/contactParentChildContacts.test.js`.

**Constructor real, verificado** (`HandleHubspotAssociations.js:64-85`): `{ associationFetcher, associationRegistry, associationService, fieldMappingService, contactHandler, fallbackEmailGenerator, bypassEmailConfigRepository = null, syncWarningRepository = null, logger = console }`. Es un export nombrado **y** default.

```js
import { jest } from '@jest/globals';
import HandleHubspotAssociations from '../../../src/application/use-cases/HandleHubspotAssociations.js';

function buildHandler() {
  const associateObjectsBySapId = jest.fn().mockResolvedValue({ ok: true });
  const handler = new HandleHubspotAssociations({
    associationFetcher: { fetch: jest.fn().mockResolvedValue(null) },
    associationService: {
      associateObjectsBySapId,
      associateContactWithCompanies: jest.fn().mockResolvedValue({ ok: true }),
      associateCompanyWithContacts: jest.fn().mockResolvedValue({ ok: true }),
    },
    associationRegistry: {
      findHubspotIdForSapId: jest.fn().mockResolvedValue(null),
      registerBaseObjectMapping: jest.fn().mockResolvedValue(undefined),
    },
    fieldMappingService: {
      getMappingsByObjectType: jest.fn().mockResolvedValue([
        { sourceField: 'Name', targetField: 'firstname', isActive: true },
      ]),
      mapRecords: jest.fn().mockResolvedValue([{ properties: { firstname: 'Ana', email: 'ana@x.com' } }]),
    },
    contactHandler: {
      find: jest.fn().mockResolvedValue({ id: '900' }),
      update: jest.fn().mockResolvedValue({ id: '900' }),
      create: jest.fn().mockResolvedValue({ id: '900' }),
    },
    fallbackEmailGenerator: (parentEmail, sapId) => `sap-${sapId}@example.com`,
    bypassEmailConfigRepository: { getBypassEmail: jest.fn().mockResolvedValue(false) },
    syncWarningRepository: { record: jest.fn().mockResolvedValue(null) },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });

  return { handler, associateObjectsBySapId };
}

const CLIENT_CONFIG = { hubspotCredentialId: 'cred1', id: 'cfg1', associationFetchEnabled: false };

describe('padre contacto -> contactos hijo', () => {
  it('handleContactAssociations sincroniza los ContactEmployees', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();
    const item = {
      properties: { idsap: 'C1' },
      rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 11, Name: 'Ana', E_Mail: 'ana@x.com' }] },
    };

    await handler.execute({
      objectType: 'contact', token: 'tok', item, clientConfig: CLIENT_CONFIG,
      tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).toHaveBeenCalledWith(
      'tok', 'cred1', 'contact', '100', 'contact',
      [{ hubspotId: '900', sapId: 11 }],
      {}
    );
  });

  it('el padre company sigue asociando company -> contact', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();
    const item = {
      properties: { idsap: 'C1' },
      rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 11, Name: 'Ana', E_Mail: 'ana@x.com' }] },
    };

    await handler.execute({
      objectType: 'company', token: 'tok', item, clientConfig: CLIENT_CONFIG,
      tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).toHaveBeenCalledWith(
      'tok', 'cred1', 'company', '100', 'contact',
      [{ hubspotId: '900', sapId: 11 }],
      {}
    );
  });

  // GUARDA DE AUTO-ASOCIACION: caso nuevo, imposible con un padre company.
  it('descarta el par cuando el hijo resuelve al mismo contacto que el padre', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();
    handler.contactHandler.find = jest.fn().mockResolvedValue({ id: '100' }); // el mismo id del padre

    const item = {
      properties: { idsap: 'C1' },
      rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 11, Name: 'Ana', E_Mail: 'ana@x.com' }] },
    };

    await handler.execute({
      objectType: 'contact', token: 'tok', item, clientConfig: CLIENT_CONFIG,
      tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).not.toHaveBeenCalled();
    expect(handler.logger.warn).toHaveBeenCalled();
  });

  it('sin ContactEmployees no toca HubSpot', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();

    await handler.execute({
      objectType: 'contact', token: 'tok',
      item: { properties: { idsap: 'C1' }, rawSapData: { CardCode: 'C1' } },
      clientConfig: CLIENT_CONFIG, tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/application/contactParentChildContacts.test.js`
Expected: FAIL — el primer test no llama a `associateObjectsBySapId` (el camino de contacto no sincroniza hijos), y el segundo espera `associateObjectsBySapId` donde hoy se usa `associateCompanyWithContacts`.

- [ ] **Step 3: Agrega `parentObjectType` a `syncCompanyContacts`**

En `src/application/use-cases/HandleHubspotAssociations.js`, cambia la firma (líneas 214-221):

```js
  // El padre puede ser una company (BusinessPartner jurídico) o un contact
  // (BusinessPartner persona). El nombre del método se mantiene por compatibilidad
  // de imports; parentObjectType es lo que decide el tipo real.
  async syncCompanyContacts({
    token,
    item,
    clientConfig,
    tenantModels,
    companyHubspotId,
    parentObjectType = 'company',
    syncLogId = null,
  }) {
```

- [ ] **Step 4: Cambia la llamada de asociación y agrega la guarda**

Reemplaza el bloque de las líneas 383-393 por:

```js
        const contactHubspotId = existingContact?.id ?? createdContact?.id;

        // Guarda de auto-asociación: cuando el padre es un contact, un
        // ContactEmployee puede resolver al MISMO contacto de HubSpot (mismo
        // email). Asociar un contacto consigo mismo es basura. Caso imposible
        // mientras el padre fuera siempre una company. La comparación de ids
        // SOLO tiene sentido cuando ambos lados viven en el mismo espacio de
        // ids (contact<->contact): con un padre company, un id de company que
        // coincida numéricamente con un id de contact es pura coincidencia
        // (son tipos de objeto distintos en HubSpot) y NO debe descartar la
        // asociación.
        if (parentObjectType === 'contact' && contactHubspotId && String(contactHubspotId) === String(companyHubspotId)) {
          this.logger.warn?.('Se descarta la auto-asociacion de un contacto consigo mismo', {
            parentObjectType,
            hubspotId: contactHubspotId,
            sapInternalCode,
          });
        } else if (contactHubspotId) {
          // associateObjectsBySapId ya recibe fromObjectType como parámetro, así
          // que sirve para los dos tipos de padre sin envoltorio nuevo.
          await this.associationService.associateObjectsBySapId(
            token,
            clientConfig.hubspotCredentialId,
            parentObjectType,
            companyHubspotId,
            'contact',
            [{ hubspotId: contactHubspotId, sapId: sapInternalCode }],
            tenantModels
          );
        }
```

> **Por qué el prefijo `parentObjectType === 'contact'` es obligatorio** (corregido
> respecto a la versión original de este plan, que lo omitía y fue detectado como bug
> Critical durante la ejecución): el id de HubSpot de una company y el id de HubSpot de
> un contact viven en **espacios de ids de tipos de objeto distintos**, así que pueden
> coincidir numéricamente por pura casualidad. Sin la compuerta, esa coincidencia
> descartaría en silencio una asociación company→contact perfectamente legítima que ya
> funcionaba antes de esta tarea. La comparación de ids sólo significa "es el mismo
> objeto" cuando ambos lados son del mismo tipo, es decir contact↔contact. El código
> que se envió lleva la compuerta; ésta es la condición real, copiada verbatim de
> `src/application/use-cases/HandleHubspotAssociations.js`.

- [ ] **Step 5: Llama a `syncCompanyContacts` desde el camino de contacto**

Al final de `handleContactAssociations` (después de la línea 434), reemplaza el cierre por:

```js
    await this.associationService.associateContactWithCompanies(
      token,
      clientConfig.hubspotCredentialId,
      hubspotId,
      companyAssociations,
      tenantModels
    );

    // Simétrico con handleCompanyAssociations: un BusinessPartner persona
    // también tiene ContactEmployees, y van como contactos asociados a este
    // contacto.
    return this.syncCompanyContacts({
      token,
      item,
      clientConfig,
      tenantModels,
      companyHubspotId: hubspotId,
      parentObjectType: 'contact',
      syncLogId,
    });
  }
```

Y agregá `syncLogId = null` a los parámetros de `handleContactAssociations` (línea 409).

- [ ] **Step 6: Pasa `syncLogId` y devolvé el resultado desde `execute`**

En `execute` (líneas 116-119), reemplaza la rama de contacto por:

```js
    if (objectType === 'contact') {
      // Devuelve { contactErrors } para que los fallos de contactEmployee lleguen
      // al SyncLog, igual que la rama de company.
      return this.handleContactAssociations({
        token,
        item,
        clientConfig,
        tenantModels,
        hubspotId,
        syncLogId,
      });
    }
```

- [ ] **Step 7: Corre el test y luego la suite completa**

Run: `npm test -- tests/unit/application/contactParentChildContacts.test.js`
Expected: PASS, 4 tests.

Run: `npm test`
Expected: sin fallos nuevos. Si algún test existente esperaba `associateCompanyWithContacts` en este camino, **actualizalo** a `associateObjectsBySapId` con `'company'` como tercer argumento: es la misma asociación por la misma ruta, solo pasa por la función genérica.

- [ ] **Step 8: Commit**

```bash
git add src/application/use-cases/HandleHubspotAssociations.js tests/unit/application/contactParentChildContacts.test.js
git commit -m "feat: sync ContactEmployees for a contact-shaped BusinessPartner (sequential)"
```

---

### Task 8: Hijos con padre contacto — camino por lotes

**Files:**
- Modify: `src/application/use-cases/ProcessCrmObjectBatches.js:655-700`
- Modify: `src/application/use-cases/SyncCompanyContactsInBatches.js:119-130` y `:850-916`
- Test: `tests/unit/application/contactParentChildContactsBatch.test.js`

**Interfaces:**
- Consumes: `crmBatchClient.batchAssociateDefault` y `crmBatchClient.associateObjectsDefault` (Tarea 1).
- Produces: `SyncCompanyContactsInBatches.execute` acepta `parentObjectType = 'company'`.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/application/contactParentChildContactsBatch.test.js`:

```js
import { jest } from '@jest/globals';
import SyncCompanyContactsInBatches from '../../../src/application/use-cases/SyncCompanyContactsInBatches.js';

describe('associateContactBatches — tipo de padre parametrizable', () => {
  function buildUseCase() {
    const batchAssociateDefault = jest.fn().mockResolvedValue({ status: 'COMPLETE', results: [] });
    const useCase = new SyncCompanyContactsInBatches({
      crmBatchClient: {
        batchAssociateDefault,
        associateObjectsDefault: jest.fn().mockResolvedValue({}),
        listAllObjects: jest.fn().mockResolvedValue([]),
        batchCreateObjects: jest.fn().mockResolvedValue({ results: [] }),
        batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
        listWritablePropertyNames: jest.fn().mockResolvedValue(null),
      },
      fieldMappingService: { getMappingsByObjectType: jest.fn(), mapRecords: jest.fn() },
      associationRegistry: { registerBaseObjectMappings: jest.fn() },
      bypassEmailConfigRepository: { getBypassEmail: jest.fn().mockResolvedValue(false) },
      identityProperty: 'internalcode',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    return { useCase, batchAssociateDefault };
  }

  const entries = [{
    key: 'k1',
    company: { hubspotId: '100', sapCompanyId: 'C1' },
    sapInternalCode: 11,
    contactPayload: { properties: {} },
  }];

  it('con parentObjectType contact asocia contact -> contact', async () => {
    const { useCase, batchAssociateDefault } = buildUseCase();

    await useCase.associateContactBatches({
      entries,
      hubspotIdByKey: new Map([['k1', '900']]),
      clientConfig: { hubspotBatchSize: 10 },
      getToken: async () => 'tok',
      contactErrors: [],
      parentObjectType: 'contact',
    });

    expect(batchAssociateDefault).toHaveBeenCalledWith('tok', 'contact', 'contact', [{ fromId: '100', toId: '900' }]);
  });

  // GUARDIA DE REGRESION
  it('sin parentObjectType asocia company -> contact, como hoy', async () => {
    const { useCase, batchAssociateDefault } = buildUseCase();

    await useCase.associateContactBatches({
      entries,
      hubspotIdByKey: new Map([['k1', '900']]),
      clientConfig: { hubspotBatchSize: 10 },
      getToken: async () => 'tok',
      contactErrors: [],
    });

    expect(batchAssociateDefault).toHaveBeenCalledWith('tok', 'company', 'contact', [{ fromId: '100', toId: '900' }]);
  });

  it('descarta el par cuando el hijo es el mismo objeto que el padre', async () => {
    const { useCase, batchAssociateDefault } = buildUseCase();

    await useCase.associateContactBatches({
      entries,
      hubspotIdByKey: new Map([['k1', '100']]), // igual al padre
      clientConfig: { hubspotBatchSize: 10 },
      getToken: async () => 'tok',
      contactErrors: [],
      parentObjectType: 'contact',
    });

    expect(batchAssociateDefault).not.toHaveBeenCalled();
    expect(useCase.logger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/application/contactParentChildContactsBatch.test.js`
Expected: FAIL — el primer test recibe `('tok', 'company', 'contact', ...)`.

- [ ] **Step 3: Parametriza `associateContactBatches`**

En `src/application/use-cases/SyncCompanyContactsInBatches.js`, reemplaza la firma y el armado de pares (líneas 850-867) por:

```js
  async associateContactBatches({
    entries,
    hubspotIdByKey,
    clientConfig,
    getToken,
    contactErrors,
    parentObjectType = 'company',
  }) {
    const pairs = [];
    const seen = new Set();

    for (const entry of entries) {
      const contactHubspotId = entry.key ? hubspotIdByKey.get(entry.key) : entry.hubspotId;

      if (!contactHubspotId) {
        continue;
      }

      // Guarda de auto-asociación: con un padre contact, un ContactEmployee
      // puede resolver al MISMO contacto de HubSpot (mismo email). Con un
      // padre company esa comparación es pura coincidencia numérica entre dos
      // espacios de ids distintos (company vs contact) y NUNCA debe descartar
      // una asociación legítima.
      if (parentObjectType === 'contact' && String(contactHubspotId) === String(entry.company.hubspotId)) {
        this.logger.warn?.('Se descarta la auto-asociacion de un contacto consigo mismo', {
          parentObjectType,
          hubspotId: contactHubspotId,
          sapContactId: entry.sapInternalCode ?? null,
        });
        continue;
      }

      const pairKey = `${entry.company.hubspotId}:${contactHubspotId}`;
      if (seen.has(pairKey)) {
        continue;
      }
      seen.add(pairKey);
      pairs.push({ fromId: entry.company.hubspotId, toId: contactHubspotId, entry });
    }
```

> **Por qué el prefijo `parentObjectType === 'contact'` es obligatorio también aquí**
> (corregido respecto a la versión original de este plan, que lo omitía en los dos
> caminos y fue detectado como bug Critical durante la ejecución): el id de HubSpot de
> una company y el id de HubSpot de un contact pertenecen a **espacios de ids de tipos
> de objeto distintos**, así que una coincidencia numérica entre ellos no significa nada.
> Sin la compuerta, el camino batch descartaría en silencio una asociación
> company→contact legítima cada vez que los dos ids coincidieran por casualidad — y en
> el camino batch el daño es peor, porque se pierde el par entero de la ola sin que
> nada quede registrado como error. La comparación sólo significa "es el mismo objeto"
> cuando el padre es contact-shaped. Ésta es la condición real, copiada verbatim de
> `src/application/use-cases/SyncCompanyContactsInBatches.js`.

Y en el cuerpo de `runInWaves`, reemplaza los tres literales `'company'` (líneas 878, 889, 900) por `parentObjectType`, y `associateObjects` por `associateObjectsDefault`:

```js
          const response = await this.retry(() =>
            this.crmBatchClient.batchAssociateDefault(
              token,
              parentObjectType,
              'contact',
              pairChunk.map(({ fromId, toId }) => ({ fromId, toId }))
            )
          );

          const { errors } = summarizeBatchResponse(response, pairChunk.length);
          for (const batchError of errors) {
            this.logger.error?.('Batch association partial failure', {
              fromObjectType: parentObjectType,
              toObjectType: 'contact',
              error: batchError,
            });
          }
        } catch (error) {
          this.logger.error?.('Batch association failed, falling back per pair:', error);
          for (const { fromId, toId, entry } of pairChunk) {
            try {
              const token = await getToken();
              await this.retry(() =>
                this.crmBatchClient.associateObjectsDefault(token, parentObjectType, fromId, 'contact', toId)
              );
```

> **No asocies el par dos veces.** La asociación contacto↔contacto es simétrica: HubSpot crea las dos direcciones con una sola llamada.

- [ ] **Step 4: Propaga `parentObjectType` desde `execute`**

En `SyncCompanyContactsInBatches.execute` (línea 119), agrega `parentObjectType = 'company'` a los parámetros y pasalo a la llamada de `associateContactBatches`.

- [ ] **Step 5: Corré los hijos también para la rama de contacto**

En `src/application/use-cases/ProcessCrmObjectBatches.js`, reemplaza `handleAssociations` (líneas 655-700) por:

```js
  async handleAssociations({ objectType, processed, clientConfig, tenantModels, getToken, syncLogId, stats }) {
    if (processed.length === 0) {
      return;
    }

    if (objectType === 'contact') {
      await this.associateWithRegistry({
        processed,
        targetObjectType: 'company',
        pickTargets: (item) => item?.properties?.associations?.companies ?? [],
        fromObjectType: 'contact',
        toObjectType: 'company',
        clientConfig,
        tenantModels,
        getToken,
      });
    } else if (objectType === 'company') {
      await this.associateWithRegistry({
        processed,
        targetObjectType: 'contact',
        pickTargets: (item) => item?.properties?.associations?.contacts ?? [],
        fromObjectType: 'company',
        toObjectType: 'contact',
        clientConfig,
        tenantModels,
        getToken,
      });
    } else {
      return;
    }

    // Los ContactEmployees de un BusinessPartner van a HubSpot como contactos
    // asociados al BP, sea el BP una company (jurídico) o un contact (persona).
    // Antes esto vivía dentro de la rama de company y la de contact retornaba
    // temprano, así que un BP persona nunca sincronizaba sus hijos.
    if (this.syncCompanyContactsInBatches) {
      const { contactErrors } = await this.syncCompanyContactsInBatches.execute({
        companies: processed,
        clientConfig,
        tenantModels,
        getToken,
        syncLogId,
        parentObjectType: objectType,
      });

      if (Array.isArray(contactErrors) && contactErrors.length > 0) {
        stats.errors.push(...contactErrors);
      }
    }
  }
```

- [ ] **Step 6: Corre el test y luego la suite completa**

Run: `npm test -- tests/unit/application/contactParentChildContactsBatch.test.js`
Expected: PASS, 3 tests.

Run: `npm test`
Expected: sin fallos nuevos.

- [ ] **Step 7: Commit**

```bash
git add src/application/use-cases/ProcessCrmObjectBatches.js src/application/use-cases/SyncCompanyContactsInBatches.js tests/unit/application/contactParentChildContactsBatch.test.js
git commit -m "feat: sync ContactEmployees for a contact-shaped BusinessPartner (batched)"
```

---

### Task 9: La compuerta `requireAddress`

**Files:**
- Create: `src/infrastructure/config/AddressSyncConfigRepository.js`
- Modify: `src/application/use-cases/SyncSapConfigToHubspot.js`
- Modify: `src/infrastructure/tenants/tenantProvisioning.js:83-158`
- Modify: `configuration_examples.md`
- Test: `tests/unit/infrastructure/addressSyncConfigRepository.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `class AddressSyncConfigRepository` con `getAddressSyncConfig({ tenantModels }) -> { required: boolean }`. Nunca lanza.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/addressSyncConfigRepository.test.js`:

```js
import AddressSyncConfigRepository
  from '../../../src/infrastructure/config/AddressSyncConfigRepository.js';

function buildConfigurationModel(documentsByKey) {
  return {
    findOne({ key }) {
      return { lean: async () => (key in documentsByKey ? { key, value: documentsByKey[key] } : null) };
    },
  };
}

describe('AddressSyncConfigRepository', () => {
  const repository = new AddressSyncConfigRepository();

  it('la clave ausente significa apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({}) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false });
  });

  it('lee required true', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: { required: true } }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: true });
  });

  it('un valor que no es objeto queda apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({ requireAddress: 'si' }) };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false });
  });

  it('nunca lanza', async () => {
    const tenantModels = { Configuration: { findOne() { throw new Error('mongo caido'); } } };

    expect(await repository.getAddressSyncConfig({ tenantModels })).toEqual({ required: false });
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/addressSyncConfigRepository.test.js`
Expected: FAIL — `Cannot find module ... AddressSyncConfigRepository.js`.

- [ ] **Step 3: Implementa el repositorio**

Crea `src/infrastructure/config/AddressSyncConfigRepository.js`:

```js
// Compuerta de la sincronización de direcciones SAP -> HubSpot. Hoy siempre
// apagada: un BusinessPartner de SAP tiene N direcciones y una company de
// HubSpot un solo juego de propiedades de dirección, así que el destino correcto
// es un custom object de HubSpot y eso es un spec aparte. La clave existe para
// declarar la intención y para que un tenant no active algo que no está hecho
// sin enterarse.
export const REQUIRE_ADDRESS_CONFIG_KEY = 'requireAddress';
export const ADDRESS_SYNC_NOT_IMPLEMENTED = 'ADDRESS_SYNC_NOT_IMPLEMENTED';

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

export class AddressSyncConfigRepository {
  // Nunca lanza: una config ilegible no debe tumbar una sincronización.
  async getAddressSyncConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, REQUIRE_ADDRESS_CONFIG_KEY);

      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { required: false };
      }

      return { required: raw.required === true };
    } catch (error) {
      console.error('requireAddress config read error:', error);
      return { required: false };
    }
  }
}

export default AddressSyncConfigRepository;
```

- [ ] **Step 4: Agrega el warning en el use-case**

En `src/application/use-cases/SyncSapConfigToHubspot.js`, agregá `addressSyncConfigRepository = null` al constructor, y después de resolver `objectType` (cerca de la línea 129) agregá:

```js
      // La sincronización de direcciones SAP -> HubSpot no está implementada: el
      // destino correcto es un custom object de HubSpot (spec aparte). Si un
      // tenant la activó, que quede constancia en vez de fallar en silencio.
      if (this.addressSyncConfigRepository && (objectType === 'company' || objectType === 'contact')) {
        const { required } = await this.addressSyncConfigRepository.getAddressSyncConfig({
          tenantModels: tenantContext?.tenantModels,
        });

        if (required) {
          this.logger?.warn?.({
            msg: 'requireAddress esta activo pero la sincronizacion de direcciones no esta implementada',
            code: 'ADDRESS_SYNC_NOT_IMPLEMENTED',
            objectType,
          });
        }
      }
```

Cablealo en `src/composition/sap-sync.composition.js` como `addressSyncConfigRepository: new AddressSyncConfigRepository()`.

- [ ] **Step 5: Siembra la clave apagada**

En `src/infrastructure/tenants/tenantProvisioning.js`, importá `REQUIRE_ADDRESS_CONFIG_KEY` y agregá dentro de `ensureTenantConfigurations`, después del bloque de `UPSERT_DATA_SAP_CONFIG_KEY` (que cierra en la línea 157):

```js
  // Sembrada apagada: la sincronización de direcciones SAP -> HubSpot no está
  // implementada todavía. El documento existe para que sea visible en el admin.
  await Configuration.updateOne(
    { key: REQUIRE_ADDRESS_CONFIG_KEY },
    {
      $setOnInsert: {
        key: REQUIRE_ADDRESS_CONFIG_KEY,
        userUpdated: 'admin',
        value: { required: false },
      },
    },
    { upsert: true }
  );
```

- [ ] **Step 6: Documenta la clave en el catálogo**

Agregá al final de `configuration_examples.md`, con el formato del archivo (etiqueta `Detalle:` + prosa + el documento en una línea):

```markdown
Detalle: requireAddress
Compuerta de la sincronización de direcciones de SAP hacia HubSpot. Hoy siempre debe quedar en `false`: un BusinessPartner de SAP tiene N direcciones (`BPAddresses`) y una company de HubSpot un solo juego de propiedades de dirección, así que el destino correcto es un objeto personalizado de HubSpot para direcciones y eso todavía no está implementado. Si se pone en `true`, la corrida registra un warning `ADDRESS_SYNC_NOT_IMPLEMENTED` y continúa normalmente, sin sincronizar ninguna dirección. La dirección HubSpot -> SAP no usa esta clave: esa va por el array `bpAddress` del payload del webhook y se configura en `businessPartnerCreation`.
{ key: 'requireAddress', value: { required: false } }
```

- [ ] **Step 7: Corre el test y luego la suite completa**

Run: `npm test -- tests/unit/infrastructure/addressSyncConfigRepository.test.js`
Expected: PASS, 4 tests.

Run: `npm test`
Expected: sin fallos nuevos.

- [ ] **Step 8: Commit**

```bash
git add src/infrastructure/config/AddressSyncConfigRepository.js src/application/use-cases/SyncSapConfigToHubspot.js src/composition/sap-sync.composition.js src/infrastructure/tenants/tenantProvisioning.js configuration_examples.md tests/unit/infrastructure/addressSyncConfigRepository.test.js
git commit -m "feat: add the requireAddress gate for SAP -> HubSpot addresses"
```

---

## Verificación final

- [ ] **Corre la suite completa y compara contra la línea base**

Run: `npm test`

Compará el número de tests que pasan y fallan contra el estado anterior a la Tarea 1. Este proyecto tiene fallos de línea base conocidos; el criterio es **ningún fallo nuevo**, no "cero fallos". Si aparece uno nuevo, arreglalo — no lo declares preexistente sin haber verificado que ya fallaba antes.

- [ ] **Verificá las guardias de regresión explícitamente**

Run: `npm test -- tests/unit/application/syncSapConfigSelectInjection.test.js tests/unit/application/contactParentChildContactsBatch.test.js`

Los dos tests marcados "GUARDIA DE REGRESION" son los que garantizan que un tenant sin configurar nada se comporte igual que antes.

- [ ] **Prueba manual en el tenant de pruebas**

El flujo de prueba manual de este proyecto es `POST /sap-sync/run` dejando activa **solo** la config a probar. Corré dos veces:

1. Con la config de `objectType: 'contact'` activa y `propertiesFlags` configurado. Verificá en HubSpot que el contacto del BP tenga la propiedad multi-select con las opciones seleccionadas, y que sus ContactEmployees aparezcan como contactos asociados.
2. Con la config de `objectType: 'company'` activa, para confirmar que las companies siguen comportándose igual que antes.

- [ ] **Verificá el cambio de la Tarea 1 en HubSpot**

La Tarea 1 cambió la URL de todas las asociaciones de a una. Después de una corrida real, confirmá en HubSpot que las asociaciones company↔contact siguen creándose. Si algo se rompió, es la única tarea del plan que se puede revertir sola.

## Pendientes que este plan NO cubre

- **Direcciones SAP → HubSpot.** `requireAddress` queda apagada. El destino es un custom object de HubSpot; el spec documenta lo ya investigado (que `hubspotClient` no conoce custom objects para crear ni leer, aunque sí para asociar, y que hace falta una propiedad de identidad para reconciliar).
- **Dejar de tragar los errores de asociación** (`associationService.js:176-184`, `SyncCompanyContactsInBatches:884-893`). Es lo que hizo posible que la duda sobre la ruta del PUT existiera meses sin que nadie la notara. No entra acá porque cambia la forma de las métricas de todas las corridas de todos los tenants.
- **Sembrar las 64 opciones** de la propiedad multi-select en HubSpot. **Prerequisito manual:** la propiedad debe existir antes de activar `propertiesFlags`, con valores internos `1`..`64`.
- **S/4 HANA** para `Properties1..64`: no existen en `A_BusinessPartner`.
