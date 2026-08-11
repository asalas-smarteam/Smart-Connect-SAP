# Creación completa de BusinessPartner (HubSpot → SAP B1) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-11-business-partner-full-creation-design.md` — léelo antes de empezar. Contiene el problema, las 21 decisiones tomadas y las 12 alternativas descartadas.

**Goal:** Que el webhook de deal pueda crear un BusinessPartner de SAP B1 con `BPAddresses` y `ContactEmployees` anidados en un solo POST, con todos los campos mapeados, defaults por tenant y `Properties1..64` derivadas de un multi-select de HubSpot — sin cambiar la conducta de ningún tenant existente.

**Architecture:** El armado del payload de creación pasa de código fijo dentro de `SapWebhookOrderAdapter` a una *strategy* seleccionada por una clave de configuración del tenant. La strategy por defecto (`legacyWhitelist`) reproduce el payload actual campo por campo; la nueva (`fullMapped`) agrega lo mapeado, los defaults, las direcciones, los contactos y las banderas `PropertiesN`. Todo el armado es dominio puro sin I/O, así que se prueba unitariamente y no puede fallar por red.

**Tech Stack:** Node.js ESM (`"type": "module"`), Mongoose (multi-tenant, un modelo por conexión de tenant), Jest con `NODE_OPTIONS=--experimental-vm-modules`, SAP Business One Service Layer v2, HubSpot CRM v3.

## Global Constraints

- **Cero regresión.** Con la configuración ausente, el payload de creación debe ser idéntico campo por campo al que produce hoy `src/infrastructure/sap/SapWebhookOrderAdapter.js:268-299`. Esto se verifica con un test explícito en la Tarea 6.
- **Solo SAP B1 (`SERVICE_LAYER`).** S/4 está fuera de alcance.
- **Alias de import obligatorios** (definidos en `package.json` → `imports`): `#application/*`, `#domain/*`, `#infrastructure/*`, `#interfaces/*`, `#shared/*`, `#composition/*`. Dentro de `src/application/ports/` se usan rutas relativas (`../port-validator.js`), siguiendo `src/application/ports/sap/warehouse-stock-strategy.port.js:1`.
- **Los tests importan con rutas relativas**, no con alias: `import X from '../../../src/domain/...'`. Ver `tests/unit/domain/warehouseStockStrategyFactory.test.js:2`.
- **Comando de test:** `npm test` (equivale a `NODE_OPTIONS=--experimental-vm-modules jest`). Para un archivo: `npm test -- tests/unit/domain/archivo.test.js`.
- **Dirección de las columnas de `FieldMapping`:** `sourceField` es el campo de **SAP**, `targetField` la propiedad de **HubSpot**. `mapHubspotToSapFields` (`src/domain/orders/order-builder.service.js:6-27`) hace `mapped[sourceField] = pickByPath(source, targetField)` y **descarta** `null`/`undefined`/`''`.
- **Dos nombres parecidos que NO son lo mismo:** `internalcode` (minúsculas) es la **propiedad de HubSpot** (`HubspotWebhookAdapter.js:127`); las propiedades de HubSpot son siempre minúsculas. `internalCode` (camelCase) es una **llave del snapshot del payload guardado en `WebhookEvent`** (`webhook-payload.service.js:77`). No los intercambies.
- **Valores vacíos:** nunca se envía `null` explícito a SAP en una creación; el campo se omite.
- **Nombres de strategy en config:** exactamente `legacyWhitelist`, `fullMapped`, `dealContact`, `payloadArray`, `none`, `numberedMultiSelect`.
- **Un `console.error` no es manejo de errores.** Donde el spec dice "nunca lanza", devuelve el default; donde dice "lanza", usa `PermanentWebhookError` de `#shared/errors/index.js`.

## Estructura de archivos

| Archivo | Responsabilidad | Tarea |
|---|---|---|
| `src/domain/business-partners/business-partner-creation.constants.js` | Claves de config, nombres de strategy, defaults numéricos | 2 |
| `src/infrastructure/config/BusinessPartnerCreationConfigRepository.js` | Leer y normalizar las 2 claves; nunca lanza | 2 |
| `src/domain/business-partners/sap-properties-flags.service.js` | `PropertiesN` ↔ multi-select de HubSpot (bidireccional) | 3 |
| `src/domain/business-partners/bp-addresses.service.js` | Array del payload + config → `BPAddresses[]` | 4 |
| `src/domain/business-partners/contact-employee-source.service.js` | Quién es el BP, quiénes son los CE | 5 |
| `src/application/ports/sap/business-partner-payload-strategy.port.js` | Contrato de las strategies de payload | 6 |
| `src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js` | Payload actual, sin cambios de conducta | 6 |
| `src/domain/business-partners/business-partner-payload.factory.js` | Nombre → instancia; lanza si no existe | 6 |
| `src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js` | Payload completo con arrays anidados | 7 |

Todo lo demás son modificaciones a archivos existentes (tareas 1, 8-13).

---

### Task 1: Habilitar el contexto `bpAddress` sin romper la sync SAP → HubSpot

Esta tarea va primera porque es la que evita un daño: en cuanto alguien cree la primera fila de mapping con `sourceContext: 'bpAddress'`, el constructor de URLs la metería en el `$select` de `/BusinessPartners` y **rompería la sincronización SAP → HubSpot que hoy funciona** (`Street` no es un campo de cabecera del BusinessPartner, SAP rechaza el request completo).

**Files:**
- Modify: `src/infrastructure/database/models/tenant/FieldMapping.js:16-27`
- Modify: `src/infrastructure/sap/serviceLayerUrlBuilder.js:21-41`
- Test: `tests/unit/infrastructure/serviceLayerUrlBuilderBpAddress.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: el valor de enum `'bpAddress'` para `FieldMapping.sourceContext`, usable por todas las tareas siguientes.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/serviceLayerUrlBuilderBpAddress.test.js`:

```js
import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

describe('buildServiceLayerUrl — exclusión del contexto bpAddress', () => {
  const clientConfig = {
    apiUrl: 'https://sap.example.com',
    serviceLayerPath: '/BusinessPartners',
    objectType: 'company',
    mode: 'FULL',
  };

  it('deja fuera del $select los mappings de contexto bpAddress', () => {
    const url = buildServiceLayerUrl(clientConfig, [
      { sourceField: 'CardCode', sourceContext: 'businessPartner', includeInServiceLayerSelect: true },
      { sourceField: 'CardName', sourceContext: 'businessPartner', includeInServiceLayerSelect: true },
      { sourceField: 'Street', sourceContext: 'bpAddress', includeInServiceLayerSelect: true },
      { sourceField: 'County', sourceContext: 'bpAddress', includeInServiceLayerSelect: true },
    ]);

    expect(url).toContain('CardCode');
    expect(url).toContain('CardName');
    expect(url).not.toContain('Street');
    expect(url).not.toContain('County');
  });

  it('sigue dejando fuera los mappings de contexto contactEmployee', () => {
    const url = buildServiceLayerUrl(clientConfig, [
      { sourceField: 'CardCode', sourceContext: 'businessPartner', includeInServiceLayerSelect: true },
      { sourceField: 'Position', sourceContext: 'contactEmployee', includeInServiceLayerSelect: true },
    ]);

    expect(url).toContain('CardCode');
    expect(url).not.toContain('Position');
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/serviceLayerUrlBuilderBpAddress.test.js`
Expected: FAIL en el primer test — el `$select` incluye `Street` y `County`. El segundo test ya pasa.

- [ ] **Step 3: Agrega `'bpAddress'` al enum del modelo**

En `src/infrastructure/database/models/tenant/FieldMapping.js`, dentro del array `enum` de `sourceContext` (líneas 18-25), agrega la entrada después de `'contactEmployee'`:

```js
    sourceContext: {
      type: String,
      enum: [
        'businessPartner',
        'contactEmployee',
        // Campos de BPAddresses[]. Se mapean con objectType: 'address' porque el
        // array llega como entidad propia en el payload del webhook y no depende
        // de si el BusinessPartner es una company o un contact de HubSpot.
        'bpAddress',
        'product',
        'ItemWarehouseInfoCollection',
        'orders-quotations',
        'inventory-transfer-request',
      ],
      default: '',
    },
```

- [ ] **Step 4: Excluye `bpAddress` del `$select`**

En `src/infrastructure/sap/serviceLayerUrlBuilder.js`, reemplaza la función `sanitizeSelectFields` (líneas 21-41) por:

```js
// Contextos cuyos sourceField NO son campos de cabecera de la entidad SAP que
// se consulta: viajan dentro de una colección anidada (ContactEmployees) o de
// una entidad aparte (BPAddresses). Meterlos en el $select hace que el Service
// Layer rechace el request completo.
const SELECT_EXCLUDED_SOURCE_CONTEXTS = new Set(['contactEmployee', 'bpAddress']);

function sanitizeSelectFields(mappings) {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return [];
  }

  const unique = new Set();

  mappings.filter(
    (mapping) => !SELECT_EXCLUDED_SOURCE_CONTEXTS.has(mapping.sourceContext)
      && mapping.includeInServiceLayerSelect !== false
  )
    .forEach((mapping) => {
      const field = cleanValue(mapping.sourceField);

      if (field && SAP_FIELD_PATTERN.test(field)) {
        unique.add(field);
      }
    });

  return Array.from(unique);
}
```

- [ ] **Step 5: Corre el test nuevo y verifica que pasa**

Run: `npm test -- tests/unit/infrastructure/serviceLayerUrlBuilderBpAddress.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Corre la suite completa para confirmar que no rompiste la sync existente**

Run: `npm test`
Expected: el mismo resultado que antes de tu cambio. Presta atención a `tests/unit/serviceLayerFlow.test.js`, que verifica el `$select` generado. Si aparece un fallo nuevo ahí, tu filtro está excluyendo algo que no debía.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/database/models/tenant/FieldMapping.js src/infrastructure/sap/serviceLayerUrlBuilder.js tests/unit/infrastructure/serviceLayerUrlBuilderBpAddress.test.js
git commit -m "feat: add bpAddress mapping context and exclude it from the SAP \$select"
```

---

### Task 2: Constantes y repositorio de configuración

**Files:**
- Create: `src/domain/business-partners/business-partner-creation.constants.js`
- Create: `src/infrastructure/config/BusinessPartnerCreationConfigRepository.js`
- Test: `tests/unit/infrastructure/businessPartnerCreationConfigRepository.test.js`

**Interfaces:**
- Consumes: `resolveSapFlavor` de `#infrastructure/config/SapFlavorConfigRepository.js` y `SAP_FLAVORS` de `#domain/sap/sap-flavor.constants.js` (`SAP_FLAVORS.B1 === 'B1'`), para el guard de flavor.
- Produces:
  - `BUSINESS_PARTNER_CREATION_CONFIG_KEY`, `PROPERTIES_FLAGS_CONFIG_KEY` (strings)
  - `BP_PAYLOAD_STRATEGIES`, `DEFAULT_BP_PAYLOAD_STRATEGY`
  - `CONTACT_EMPLOYEE_SOURCES`, `DEFAULT_CONTACT_EMPLOYEE_SOURCE`
  - `BP_ADDRESS_STRATEGIES`, `DEFAULT_BP_ADDRESS_STRATEGY`
  - `PROPERTIES_FLAGS_STRATEGIES`, `DEFAULT_PROPERTIES_FLAGS_STRATEGY`
  - `BP_ADDRESS_OBJECT_TYPE = 'address'`, `BP_ADDRESS_SOURCE_CONTEXT = 'bpAddress'`
  - `class BusinessPartnerCreationConfigRepository` con
    `getBusinessPartnerCreationConfig({ tenantModels }) -> { payloadStrategy, contactEmployeeSource, defaults: { BusinessPartner, ContactEmployee, BPAddress }, addresses: { strategy, byName, required } }`
    y `getPropertiesFlagsConfig({ tenantModels }) -> { strategy, hubspotProperty, min, max, trueValue }`

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/businessPartnerCreationConfigRepository.test.js`:

```js
import BusinessPartnerCreationConfigRepository
  from '../../../src/infrastructure/config/BusinessPartnerCreationConfigRepository.js';

function buildConfigurationModel(documentsByKey) {
  return {
    findOne({ key }) {
      return { lean: async () => (key in documentsByKey ? { key, value: documentsByKey[key] } : null) };
    },
  };
}

describe('BusinessPartnerCreationConfigRepository', () => {
  const repository = new BusinessPartnerCreationConfigRepository();

  it('devuelve los defaults cuando la clave no existe', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({}) };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config).toEqual({
      payloadStrategy: 'legacyWhitelist',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    });
  });

  it('normaliza byName y required a minusculas sin espacios', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        businessPartnerCreation: {
          payloadStrategy: 'fullMapped',
          contactEmployeeSource: 'payloadArray',
          defaults: { BusinessPartner: { CardType: 'cCustomer' }, BPAddress: { TaxCode: 'IVA' } },
          addresses: {
            strategy: 'payloadArray',
            byName: { '  Factura ': { AddressType: 'bo_BillTo' }, Entrega: { AddressType: 'bo_ShipTo' } },
            required: [' Factura', 'ENTREGA'],
          },
        },
      }),
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config.payloadStrategy).toBe('fullMapped');
    expect(config.contactEmployeeSource).toBe('payloadArray');
    expect(config.defaults.BusinessPartner).toEqual({ CardType: 'cCustomer' });
    expect(config.defaults.BPAddress).toEqual({ TaxCode: 'IVA' });
    expect(config.defaults.ContactEmployee).toEqual({});
    expect(config.addresses.byName).toEqual({
      factura: { AddressType: 'bo_BillTo' },
      entrega: { AddressType: 'bo_ShipTo' },
    });
    expect(config.addresses.required).toEqual(['factura', 'entrega']);
  });

  it('nunca lanza: ante un error de lectura devuelve los defaults', async () => {
    const tenantModels = {
      Configuration: {
        findOne() { throw new Error('mongo caido'); },
      },
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config.payloadStrategy).toBe('legacyWhitelist');
    expect(config.addresses.strategy).toBe('none');
  });

  it('degrada a los defaults cuando el tenant no es B1', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        sapFlavor: 'S4',
        businessPartnerCreation: {
          payloadStrategy: 'fullMapped',
          contactEmployeeSource: 'payloadArray',
          addresses: { strategy: 'payloadArray', byName: { factura: {} }, required: ['factura'] },
        },
      }),
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config.payloadStrategy).toBe('legacyWhitelist');
    expect(config.addresses.strategy).toBe('none');
    expect(config.addresses.required).toEqual([]);
  });

  it('respeta la config cuando el tenant es B1', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        sapFlavor: 'B1',
        businessPartnerCreation: { payloadStrategy: 'fullMapped' },
      }),
    };

    expect((await repository.getBusinessPartnerCreationConfig({ tenantModels })).payloadStrategy)
      .toBe('fullMapped');
  });

  it('lee y normaliza propertiesFlags', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        propertiesFlags: {
          strategy: 'numberedMultiSelect',
          hubspotProperty: ' groupname ',
          min: 1,
          max: 64,
          trueValue: 'tYES',
        },
      }),
    };

    expect(await repository.getPropertiesFlagsConfig({ tenantModels })).toEqual({
      strategy: 'numberedMultiSelect',
      hubspotProperty: 'groupname',
      min: 1,
      max: 64,
      trueValue: 'tYES',
    });
  });

  it('propertiesFlags ausente queda apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({}) };

    expect(await repository.getPropertiesFlagsConfig({ tenantModels })).toEqual({
      strategy: 'none',
      hubspotProperty: null,
      min: 1,
      max: 64,
      trueValue: 'tYES',
    });
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/businessPartnerCreationConfigRepository.test.js`
Expected: FAIL — `Cannot find module ... BusinessPartnerCreationConfigRepository.js`.

- [ ] **Step 3: Crea el archivo de constantes**

Crea `src/domain/business-partners/business-partner-creation.constants.js`:

```js
// Configuración por tenant que decide cómo se arma el payload de creación del
// BusinessPartner (HubSpot -> SAP B1). Ver
// docs/superpowers/specs/2026-08-11-business-partner-full-creation-design.md
export const BUSINESS_PARTNER_CREATION_CONFIG_KEY = 'businessPartnerCreation';

// Bidireccional: el spec SAP -> HubSpot reutiliza esta misma clave.
export const PROPERTIES_FLAGS_CONFIG_KEY = 'propertiesFlags';

export const BP_PAYLOAD_STRATEGIES = Object.freeze({
  // Reproduce campo por campo el payload que el adapter armaba antes de este
  // cambio. Ningún tenant cambia de conducta sin configurar nada.
  LEGACY_WHITELIST: 'legacyWhitelist',
  // Todo lo mapeado + defaults + BPAddresses + ContactEmployees + PropertiesN.
  FULL_MAPPED: 'fullMapped',
});

export const DEFAULT_BP_PAYLOAD_STRATEGY = BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST;

export const CONTACT_EMPLOYEE_SOURCES = Object.freeze({
  // Conducta actual: el contact del deal es el ContactEmployee, y solo cuando
  // el deal trae company y contact a la vez.
  DEAL_CONTACT: 'dealContact',
  // El workflow de HubSpot manda payload.contactEmployees; el contact del deal
  // se ignora como CE.
  PAYLOAD_ARRAY: 'payloadArray',
});

export const DEFAULT_CONTACT_EMPLOYEE_SOURCE = CONTACT_EMPLOYEE_SOURCES.DEAL_CONTACT;

export const BP_ADDRESS_STRATEGIES = Object.freeze({
  NONE: 'none',
  // El workflow de HubSpot manda payload.bpAddress como array.
  PAYLOAD_ARRAY: 'payloadArray',
});

export const DEFAULT_BP_ADDRESS_STRATEGY = BP_ADDRESS_STRATEGIES.NONE;

export const PROPERTIES_FLAGS_STRATEGIES = Object.freeze({
  NONE: 'none',
  // El valor interno de la opción del multi-select de HubSpot ES el número:
  // '55' -> Properties55: 'tYES'.
  NUMBERED_MULTI_SELECT: 'numberedMultiSelect',
});

export const DEFAULT_PROPERTIES_FLAGS_STRATEGY = PROPERTIES_FLAGS_STRATEGIES.NONE;

// Las filas de FieldMapping de las direcciones. objectType nombra la cosa del
// payload que estas filas leen (igual que line_items usa objectType 'product'),
// y un solo juego sirve tanto si el BP es company como si es contact.
export const BP_ADDRESS_OBJECT_TYPE = 'address';
export const BP_ADDRESS_SOURCE_CONTEXT = 'bpAddress';

// SAP B1 expone Properties1 .. Properties64.
export const DEFAULT_PROPERTIES_MIN = 1;
export const DEFAULT_PROPERTIES_MAX = 64;
export const DEFAULT_PROPERTIES_TRUE_VALUE = 'tYES';

export default {
  BUSINESS_PARTNER_CREATION_CONFIG_KEY,
  PROPERTIES_FLAGS_CONFIG_KEY,
  BP_PAYLOAD_STRATEGIES,
  DEFAULT_BP_PAYLOAD_STRATEGY,
  CONTACT_EMPLOYEE_SOURCES,
  DEFAULT_CONTACT_EMPLOYEE_SOURCE,
  BP_ADDRESS_STRATEGIES,
  DEFAULT_BP_ADDRESS_STRATEGY,
  PROPERTIES_FLAGS_STRATEGIES,
  DEFAULT_PROPERTIES_FLAGS_STRATEGY,
  BP_ADDRESS_OBJECT_TYPE,
  BP_ADDRESS_SOURCE_CONTEXT,
  DEFAULT_PROPERTIES_MIN,
  DEFAULT_PROPERTIES_MAX,
  DEFAULT_PROPERTIES_TRUE_VALUE,
};
```

- [ ] **Step 4: Crea el repositorio de configuración**

Crea `src/infrastructure/config/BusinessPartnerCreationConfigRepository.js`. Sigue el patrón de `WarehouseStockConfigRepository.js`: lee con `findOne` directo (no con el `getValue` de `tenantConfiguration.service.js`, que hace upsert y crearía documentos vacíos en tenants que no usan esto) y nunca lanza.

```js
import {
  BUSINESS_PARTNER_CREATION_CONFIG_KEY,
  PROPERTIES_FLAGS_CONFIG_KEY,
  BP_PAYLOAD_STRATEGIES,
  DEFAULT_BP_PAYLOAD_STRATEGY,
  CONTACT_EMPLOYEE_SOURCES,
  DEFAULT_CONTACT_EMPLOYEE_SOURCE,
  BP_ADDRESS_STRATEGIES,
  DEFAULT_BP_ADDRESS_STRATEGY,
  PROPERTIES_FLAGS_STRATEGIES,
  DEFAULT_PROPERTIES_FLAGS_STRATEGY,
  DEFAULT_PROPERTIES_MIN,
  DEFAULT_PROPERTIES_MAX,
  DEFAULT_PROPERTIES_TRUE_VALUE,
} from '#domain/business-partners/business-partner-creation.constants.js';
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';
import { normalizeInteger, toNonEmptyString } from '#shared/utils/string.utils.js';

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

function pickAllowed(value, allowedValues, fallback) {
  const normalized = String(value ?? '').trim();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

// Las llaves de byName y los valores de required se comparan contra el
// AddressName que llega del workflow de HubSpot, así que se normalizan igual
// en los tres lados: trim + minúsculas.
function normalizeAddressName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeByName(rawByName) {
  const byName = {};

  for (const [rawKey, rawValue] of Object.entries(toPlainObject(rawByName))) {
    const key = normalizeAddressName(rawKey);
    if (key) {
      byName[key] = toPlainObject(rawValue);
    }
  }

  return byName;
}

function normalizeRequired(rawRequired) {
  if (!Array.isArray(rawRequired)) {
    return [];
  }

  return [...new Set(rawRequired.map(normalizeAddressName).filter(Boolean))];
}

const CREATION_DEFAULTS = Object.freeze({
  payloadStrategy: DEFAULT_BP_PAYLOAD_STRATEGY,
  contactEmployeeSource: DEFAULT_CONTACT_EMPLOYEE_SOURCE,
  defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
  addresses: { strategy: DEFAULT_BP_ADDRESS_STRATEGY, byName: {}, required: [] },
});

function buildCreationDefaults() {
  return {
    payloadStrategy: CREATION_DEFAULTS.payloadStrategy,
    contactEmployeeSource: CREATION_DEFAULTS.contactEmployeeSource,
    defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
    addresses: { strategy: CREATION_DEFAULTS.addresses.strategy, byName: {}, required: [] },
  };
}

function buildPropertiesFlagsDefaults() {
  return {
    strategy: DEFAULT_PROPERTIES_FLAGS_STRATEGY,
    hubspotProperty: null,
    min: DEFAULT_PROPERTIES_MIN,
    max: DEFAULT_PROPERTIES_MAX,
    trueValue: DEFAULT_PROPERTIES_TRUE_VALUE,
  };
}

export class BusinessPartnerCreationConfigRepository {
  // Nunca lanza: una config ilegible no debe tumbar un webhook de deal, solo
  // significa "usa la conducta de siempre".
  async getBusinessPartnerCreationConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, BUSINESS_PARTNER_CREATION_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildCreationDefaults();
      }

      // BPAddresses y ContactEmployees anidados son forma de SAP B1. En S/4 son
      // entidades separadas, así que la config se ignora en vez de generar un
      // payload que el gateway rechazaría.
      const sapFlavor = await resolveSapFlavor({ tenantModels });

      if (sapFlavor !== SAP_FLAVORS.B1) {
        console.warn('businessPartnerCreation ignorada: solo aplica a SAP B1', { sapFlavor });
        return buildCreationDefaults();
      }

      const rawDefaults = toPlainObject(raw.defaults);
      const rawAddresses = toPlainObject(raw.addresses);

      return {
        payloadStrategy: pickAllowed(
          raw.payloadStrategy,
          Object.values(BP_PAYLOAD_STRATEGIES),
          DEFAULT_BP_PAYLOAD_STRATEGY
        ),
        contactEmployeeSource: pickAllowed(
          raw.contactEmployeeSource,
          Object.values(CONTACT_EMPLOYEE_SOURCES),
          DEFAULT_CONTACT_EMPLOYEE_SOURCE
        ),
        defaults: {
          BusinessPartner: toPlainObject(rawDefaults.BusinessPartner),
          ContactEmployee: toPlainObject(rawDefaults.ContactEmployee),
          BPAddress: toPlainObject(rawDefaults.BPAddress),
        },
        addresses: {
          strategy: pickAllowed(
            rawAddresses.strategy,
            Object.values(BP_ADDRESS_STRATEGIES),
            DEFAULT_BP_ADDRESS_STRATEGY
          ),
          byName: normalizeByName(rawAddresses.byName),
          required: normalizeRequired(rawAddresses.required),
        },
      };
    } catch (error) {
      console.error('BusinessPartner creation config read error:', error);
      return buildCreationDefaults();
    }
  }

  async getPropertiesFlagsConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, PROPERTIES_FLAGS_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildPropertiesFlagsDefaults();
      }

      return {
        strategy: pickAllowed(
          raw.strategy,
          Object.values(PROPERTIES_FLAGS_STRATEGIES),
          DEFAULT_PROPERTIES_FLAGS_STRATEGY
        ),
        hubspotProperty: toNonEmptyString(raw.hubspotProperty),
        min: normalizeInteger(raw.min, DEFAULT_PROPERTIES_MIN),
        max: normalizeInteger(raw.max, DEFAULT_PROPERTIES_MAX),
        trueValue: toNonEmptyString(raw.trueValue) || DEFAULT_PROPERTIES_TRUE_VALUE,
      };
    } catch (error) {
      console.error('propertiesFlags config read error:', error);
      return buildPropertiesFlagsDefaults();
    }
  }
}

export default BusinessPartnerCreationConfigRepository;
```

- [ ] **Step 5: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/infrastructure/businessPartnerCreationConfigRepository.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain/business-partners/business-partner-creation.constants.js src/infrastructure/config/BusinessPartnerCreationConfigRepository.js tests/unit/infrastructure/businessPartnerCreationConfigRepository.test.js
git commit -m "feat: add businessPartnerCreation and propertiesFlags tenant configs"
```

---

### Task 3: `Properties1..64` ↔ multi-select de HubSpot

HubSpot serializa un multi-select como string unido por `;` (`'1;2;55'`). **Este es el primer split/join por `;` del repositorio**, así que reutiliza la constante existente en vez de escribir un literal nuevo.

**Files:**
- Create: `src/domain/business-partners/sap-properties-flags.service.js`
- Test: `tests/unit/domain/sapPropertiesFlags.test.js`

**Interfaces:**
- Consumes: `PROPERTIES_FLAGS_STRATEGIES` (Tarea 2); `HUBSPOT_OPTION_VALUE_SEPARATOR` de `src/domain/sync/dropdown-options.constants.js:54`.
- Produces:
  - `buildSapPropertiesFlags({ hubspotValue, config }) -> { flags: { [`Properties${n}`]: string }, invalid: string[] }`
  - `readSapPropertiesFlags({ sapRecord, config }) -> string | null` (usado por el spec SAP → HubSpot)
  - `listSapPropertiesFieldNames(config) -> string[]` (para el `$select` del spec SAP → HubSpot)

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/domain/sapPropertiesFlags.test.js`:

```js
import {
  buildSapPropertiesFlags,
  readSapPropertiesFlags,
  listSapPropertiesFieldNames,
} from '../../../src/domain/business-partners/sap-properties-flags.service.js';

const ON = {
  strategy: 'numberedMultiSelect',
  hubspotProperty: 'groupname',
  min: 1,
  max: 64,
  trueValue: 'tYES',
};

describe('buildSapPropertiesFlags', () => {
  it('convierte un multi-select separado por ; en banderas tYES', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: '1;2;3;55;64', config: ON })).toEqual({
      flags: {
        Properties1: 'tYES',
        Properties2: 'tYES',
        Properties3: 'tYES',
        Properties55: 'tYES',
        Properties64: 'tYES',
      },
      invalid: [],
    });
  });

  it('acepta tambien un array', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: [2, '7'], config: ON }).flags).toEqual({
      Properties2: 'tYES',
      Properties7: 'tYES',
    });
  });

  it('solo emite las seleccionadas, nunca las no seleccionadas', () => {
    const { flags } = buildSapPropertiesFlags({ hubspotValue: '3', config: ON });

    expect(flags).toEqual({ Properties3: 'tYES' });
    expect(Object.keys(flags)).toHaveLength(1);
  });

  it('ignora valores fuera de rango, no numericos y vacios, y los reporta', () => {
    const { flags, invalid } = buildSapPropertiesFlags({
      hubspotValue: '0;65;abc;;12.5; 9 ',
      config: ON,
    });

    expect(flags).toEqual({ Properties9: 'tYES' });
    expect(invalid).toEqual(['0', '65', 'abc', '12.5']);
  });

  it('deduplica valores repetidos', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: '5;5;5', config: ON }).flags).toEqual({
      Properties5: 'tYES',
    });
  });

  it('devuelve vacio cuando el valor de HubSpot no viene', () => {
    expect(buildSapPropertiesFlags({ hubspotValue: undefined, config: ON })).toEqual({
      flags: {}, invalid: [],
    });
    expect(buildSapPropertiesFlags({ hubspotValue: '', config: ON }).flags).toEqual({});
  });

  it('devuelve vacio cuando la strategy esta apagada', () => {
    const off = { ...ON, strategy: 'none' };

    expect(buildSapPropertiesFlags({ hubspotValue: '1;2', config: off })).toEqual({
      flags: {}, invalid: [],
    });
  });

  it('respeta un rango personalizado', () => {
    const narrow = { ...ON, min: 10, max: 12 };

    expect(buildSapPropertiesFlags({ hubspotValue: '9;10;12;13', config: narrow })).toEqual({
      flags: { Properties10: 'tYES', Properties12: 'tYES' },
      invalid: ['9', '13'],
    });
  });
});

describe('readSapPropertiesFlags', () => {
  it('convierte las banderas de SAP en un valor de multi-select', () => {
    const sapRecord = {
      Properties1: 'tYES',
      Properties2: 'tNO',
      Properties3: 'tYES',
      Properties64: 'tYES',
    };

    expect(readSapPropertiesFlags({ sapRecord, config: ON })).toBe('1;3;64');
  });

  it('devuelve string vacio cuando ninguna esta en tYES', () => {
    expect(readSapPropertiesFlags({ sapRecord: { Properties1: 'tNO' }, config: ON })).toBe('');
  });

  it('devuelve null cuando la strategy esta apagada', () => {
    expect(readSapPropertiesFlags({ sapRecord: { Properties1: 'tYES' }, config: { ...ON, strategy: 'none' } }))
      .toBeNull();
  });
});

describe('listSapPropertiesFieldNames', () => {
  it('lista los nombres de campo del rango configurado', () => {
    expect(listSapPropertiesFieldNames({ ...ON, min: 1, max: 3 }))
      .toEqual(['Properties1', 'Properties2', 'Properties3']);
  });

  it('devuelve vacio cuando la strategy esta apagada', () => {
    expect(listSapPropertiesFieldNames({ ...ON, strategy: 'none' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/domain/sapPropertiesFlags.test.js`
Expected: FAIL — `Cannot find module ... sap-properties-flags.service.js`.

- [ ] **Step 3: Implementa el servicio**

Crea `src/domain/business-partners/sap-properties-flags.service.js`:

```js
import { HUBSPOT_OPTION_VALUE_SEPARATOR } from '#domain/sync/dropdown-options.constants.js';
import { PROPERTIES_FLAGS_STRATEGIES } from './business-partner-creation.constants.js';

function isEnabled(config) {
  return config?.strategy === PROPERTIES_FLAGS_STRATEGIES.NUMBERED_MULTI_SELECT;
}

function fieldNameFor(number) {
  return `Properties${number}`;
}

// El valor de un multi-select de HubSpot llega como string unido por ';'
// ('1;2;55'). Un array se acepta por si el workflow ya lo manda desarmado.
function splitHubspotValue(hubspotValue) {
  if (Array.isArray(hubspotValue)) {
    return hubspotValue;
  }

  return String(hubspotValue ?? '').split(HUBSPOT_OPTION_VALUE_SEPARATOR);
}

// Un valor inválido nunca tumba el webhook: se reporta en `invalid` para que
// el llamador lo registre como warning y sigue con los que sí sirven.
export function parseSelectedPropertyNumbers(hubspotValue, { min, max }) {
  const selected = [];
  const invalid = [];
  const seen = new Set();

  for (const rawValue of splitHubspotValue(hubspotValue)) {
    const trimmed = String(rawValue ?? '').trim();

    if (!trimmed) {
      continue;
    }

    const parsed = Number(trimmed);

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      invalid.push(trimmed);
      continue;
    }

    if (seen.has(parsed)) {
      continue;
    }

    seen.add(parsed);
    selected.push(parsed);
  }

  return { selected: selected.sort((left, right) => left - right), invalid };
}

// HubSpot -> SAP. Solo emite las seleccionadas: en un POST de creación omitir
// un campo deja que SAP aplique su propio default.
export function buildSapPropertiesFlags({ hubspotValue, config }) {
  if (!isEnabled(config)) {
    return { flags: {}, invalid: [] };
  }

  const { selected, invalid } = parseSelectedPropertyNumbers(hubspotValue, config);
  const flags = {};

  for (const number of selected) {
    flags[fieldNameFor(number)] = config.trueValue;
  }

  return { flags, invalid };
}

// SAP -> HubSpot. Devuelve el string listo para escribir en la propiedad
// multi-select; null significa "esta strategy no aplica a este tenant", que es
// distinto de '' ("aplica y no hay ninguna seleccionada").
export function readSapPropertiesFlags({ sapRecord, config }) {
  if (!isEnabled(config)) {
    return null;
  }

  const selected = [];

  for (let number = config.min; number <= config.max; number += 1) {
    if (sapRecord?.[fieldNameFor(number)] === config.trueValue) {
      selected.push(number);
    }
  }

  return selected.join(HUBSPOT_OPTION_VALUE_SEPARATOR);
}

// Para el $select de la dirección SAP -> HubSpot.
export function listSapPropertiesFieldNames(config) {
  if (!isEnabled(config)) {
    return [];
  }

  const names = [];

  for (let number = config.min; number <= config.max; number += 1) {
    names.push(fieldNameFor(number));
  }

  return names;
}

export default {
  parseSelectedPropertyNumbers,
  buildSapPropertiesFlags,
  readSapPropertiesFlags,
  listSapPropertiesFieldNames,
};
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/domain/sapPropertiesFlags.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/business-partners/sap-properties-flags.service.js tests/unit/domain/sapPropertiesFlags.test.js
git commit -m "feat: map HubSpot multi-select to SAP Properties1..64 flags"
```

---

### Task 4: Construcción de `BPAddresses`

**Files:**
- Create: `src/domain/business-partners/bp-addresses.service.js`
- Test: `tests/unit/domain/bpAddresses.test.js`

**Interfaces:**
- Consumes: `BP_ADDRESS_STRATEGIES` (Tarea 2); `PermanentWebhookError` de `#shared/errors/index.js`.
- Produces: `buildBpAddresses({ mappedAddresses, addressesConfig, addressDefaults }) -> { addresses: object[], warnings: { code, addressName? }[] }`. Lanza `PermanentWebhookError` si falta un `AddressName` listado en `addressesConfig.required`.

**Precedencia por campo (later wins en el spread):** `addressDefaults` → `byName[nombre]` → entrada del payload.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/domain/bpAddresses.test.js`:

```js
import { buildBpAddresses } from '../../../src/domain/business-partners/bp-addresses.service.js';

const CONFIG = {
  strategy: 'payloadArray',
  byName: {
    factura: { AddressType: 'bo_BillTo', Country: 'GT' },
    entrega: { AddressType: 'bo_ShipTo', Country: 'GT' },
  },
  required: [],
};

const DEFAULTS = { TaxCode: 'IVA' };

describe('buildBpAddresses', () => {
  it('arma dos direcciones uniendo payload, byName y defaults', () => {
    const { addresses, warnings } = buildBpAddresses({
      mappedAddresses: [
        { AddressName: 'factura', Street: 'Calle 1', County: 'La Habana' },
        { AddressName: 'Entrega', Street: 'Calle 2', County: 'La Habana' },
      ],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(warnings).toEqual([]);
    expect(addresses).toEqual([
      { TaxCode: 'IVA', AddressType: 'bo_BillTo', Country: 'GT', AddressName: 'factura', Street: 'Calle 1', County: 'La Habana' },
      { TaxCode: 'IVA', AddressType: 'bo_ShipTo', Country: 'GT', AddressName: 'Entrega', Street: 'Calle 2', County: 'La Habana' },
    ]);
  });

  it('soporta una sola direccion', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'Unica' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toHaveLength(1);
    expect(addresses[0].AddressType).toBe('bo_BillTo');
  });

  it('soporta mas de dos direcciones', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [
        { AddressName: 'factura', Street: 'A' },
        { AddressName: 'entrega', Street: 'B' },
        { AddressName: 'entrega', Street: 'C' },
      ],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toHaveLength(3);
    expect(addresses.map((address) => address.Street)).toEqual(['A', 'B', 'C']);
  });

  it('une byName sin importar mayusculas ni espacios en el AddressName', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: '  FACTURA  ', Street: 'A' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses[0].AddressType).toBe('bo_BillTo');
    expect(addresses[0].AddressName).toBe('FACTURA');
  });

  it('el valor del payload gana sobre byName y sobre los defaults', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', AddressType: 'bo_ShipTo', TaxCode: 'EXE', Country: 'CU' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses[0]).toMatchObject({ AddressType: 'bo_ShipTo', TaxCode: 'EXE', Country: 'CU' });
  });

  it('avisa cuando el AddressName no esta en byName pero crea la direccion', () => {
    const { addresses, warnings } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'bodega', Street: 'X' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toEqual([{ TaxCode: 'IVA', AddressName: 'bodega', Street: 'X' }]);
    expect(warnings).toEqual([{ code: 'BP_ADDRESS_NAME_NOT_CONFIGURED', addressName: 'bodega' }]);
  });

  it('descarta entradas sin AddressName y avisa', () => {
    const { addresses, warnings } = buildBpAddresses({
      mappedAddresses: [{ Street: 'Sin nombre' }, { AddressName: 'factura', Street: 'A' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toHaveLength(1);
    expect(warnings).toEqual([{ code: 'BP_ADDRESS_WITHOUT_NAME' }]);
  });

  it('omite los campos vacios en vez de mandar null a SAP', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'A', ZipCode: null, County: '' }],
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses[0]).not.toHaveProperty('ZipCode');
    expect(addresses[0]).not.toHaveProperty('County');
  });

  it('lanza PermanentWebhookError cuando falta una direccion obligatoria', () => {
    expect(() => buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'A' }],
      addressesConfig: { ...CONFIG, required: ['factura', 'entrega'] },
      addressDefaults: DEFAULTS,
    })).toThrow(/entrega/);
  });

  it('no lanza cuando todas las obligatorias estan presentes', () => {
    expect(() => buildBpAddresses({
      mappedAddresses: [{ AddressName: 'Factura', Street: 'A' }, { AddressName: 'ENTREGA', Street: 'B' }],
      addressesConfig: { ...CONFIG, required: ['factura', 'entrega'] },
      addressDefaults: DEFAULTS,
    })).not.toThrow();
  });

  it('devuelve vacio cuando la strategy esta apagada', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: [{ AddressName: 'factura', Street: 'A' }],
      addressesConfig: { strategy: 'none', byName: {}, required: [] },
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toEqual([]);
  });

  it('devuelve vacio cuando el payload no trae direcciones', () => {
    const { addresses } = buildBpAddresses({
      mappedAddresses: undefined,
      addressesConfig: CONFIG,
      addressDefaults: DEFAULTS,
    });

    expect(addresses).toEqual([]);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/domain/bpAddresses.test.js`
Expected: FAIL — `Cannot find module ... bp-addresses.service.js`.

- [ ] **Step 3: Implementa el servicio**

Crea `src/domain/business-partners/bp-addresses.service.js`:

```js
import { PermanentWebhookError } from '#shared/errors/index.js';
import { BP_ADDRESS_STRATEGIES } from './business-partner-creation.constants.js';

export const BP_ADDRESS_WARNINGS = Object.freeze({
  WITHOUT_NAME: 'BP_ADDRESS_WITHOUT_NAME',
  NAME_NOT_CONFIGURED: 'BP_ADDRESS_NAME_NOT_CONFIGURED',
});

function normalizeAddressName(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Nunca se manda null explícito a SAP en una creación: un campo vacío se omite
// y SAP aplica su propio default.
function omitBlank(source) {
  const result = {};

  for (const [field, value] of Object.entries(source || {})) {
    if (value === null || typeof value === 'undefined' || value === '') {
      continue;
    }

    result[field] = value;
  }

  return result;
}

export function buildBpAddresses({ mappedAddresses, addressesConfig, addressDefaults }) {
  if (addressesConfig?.strategy !== BP_ADDRESS_STRATEGIES.PAYLOAD_ARRAY) {
    return { addresses: [], warnings: [] };
  }

  const entries = Array.isArray(mappedAddresses) ? mappedAddresses : [];
  const byName = addressesConfig.byName || {};
  const addresses = [];
  const warnings = [];
  const presentNames = new Set();

  for (const entry of entries) {
    const addressName = String(entry?.AddressName ?? '').trim();

    if (!addressName) {
      warnings.push({ code: BP_ADDRESS_WARNINGS.WITHOUT_NAME });
      continue;
    }

    const normalizedName = normalizeAddressName(addressName);
    presentNames.add(normalizedName);

    const configuredValues = byName[normalizedName];

    if (!configuredValues) {
      warnings.push({ code: BP_ADDRESS_WARNINGS.NAME_NOT_CONFIGURED, addressName });
    }

    // Precedencia: defaults -> byName -> payload. AddressName se reafirma al
    // final porque el que va a SAP es el del payload (con trim), no el de la
    // llave normalizada de la config.
    addresses.push({
      ...omitBlank(addressDefaults),
      ...omitBlank(configuredValues),
      ...omitBlank(entry),
      AddressName: addressName,
    });
  }

  const missing = (addressesConfig.required || []).filter((name) => !presentNames.has(name));

  if (missing.length > 0) {
    throw new PermanentWebhookError(
      `El payload no trae las direcciones obligatorias (bpAddress): ${missing.join(', ')}`
    );
  }

  return { addresses, warnings };
}

export default { buildBpAddresses, BP_ADDRESS_WARNINGS };
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/domain/bpAddresses.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/business-partners/bp-addresses.service.js tests/unit/domain/bpAddresses.test.js
git commit -m "feat: build SAP BPAddresses from the webhook payload array"
```

---

### Task 5: Resolver quién es el BP y quiénes son los ContactEmployees

Hoy esta decisión vive inline y duplicada en tres archivos, siempre como la expresión `companyExists: companyExists || !contactExists`:
`ProcessHubspotWebhookEvent.js:74`, `webhookQuotationSupport.js:141`, `ProcessHubspotInventoryTransferRequest.js:46`. Esta tarea la extrae; la Tarea 10 cambia los tres call sites.

**Files:**
- Create: `src/domain/business-partners/contact-employee-source.service.js`
- Test: `tests/unit/domain/contactEmployeeSource.test.js`

**Interfaces:**
- Consumes: `CONTACT_EMPLOYEE_SOURCES` (Tarea 2); `PermanentWebhookError`.
- Produces: `resolveBusinessPartnerAndContactEmployees({ company, contact, contactEmployees, source }) -> { businessPartnerSource: 'company'|'contact', businessPartner: object, isCompanyBusinessPartner: boolean, contactEmployeeSources: object[], warnings: { code }[] }`. Lanza `PermanentWebhookError` si no hay company ni contact.

**Equivalencia que debes preservar:** `isCompanyBusinessPartner` es exactamente lo que hoy vale la expresión `companyExists || !contactExists`, que es el flag `companyExists` que espera `SapWebhookOrderAdapter.findOrCreateBusinessPartner`. Es `false` únicamente cuando hay contact y no hay company.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/domain/contactEmployeeSource.test.js`:

```js
import { resolveBusinessPartnerAndContactEmployees }
  from '../../../src/domain/business-partners/contact-employee-source.service.js';

const company = { hs_object_id: '1', name: 'ACME' };
const contact = { hs_object_id: '2', firstname: 'Juan' };
const employees = [{ hs_object_id: '3', firstname: 'Ana' }, { hs_object_id: '4', firstname: 'Luis' }];

describe('resolveBusinessPartnerAndContactEmployees — dealContact (conducta actual)', () => {
  const source = 'dealContact';

  it('company + contact: BP es la company y el contact es el CE', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company, contact, source });

    expect(result.businessPartnerSource).toBe('company');
    expect(result.businessPartner).toBe(company);
    expect(result.isCompanyBusinessPartner).toBe(true);
    expect(result.contactEmployeeSources).toEqual([contact]);
  });

  it('solo contact: BP es el contact y no hay CE', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company: null, contact, source });

    expect(result.businessPartnerSource).toBe('contact');
    expect(result.isCompanyBusinessPartner).toBe(false);
    expect(result.contactEmployeeSources).toEqual([]);
  });

  it('solo company: BP es la company y no hay CE', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company, contact: null, source });

    expect(result.businessPartnerSource).toBe('company');
    expect(result.isCompanyBusinessPartner).toBe(true);
    expect(result.contactEmployeeSources).toEqual([]);
  });

  it('ignora payload.contactEmployees', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact, contactEmployees: employees, source,
    });

    expect(result.contactEmployeeSources).toEqual([contact]);
  });
});

describe('resolveBusinessPartnerAndContactEmployees — payloadArray (nuevo)', () => {
  const source = 'payloadArray';

  it('company + contact: BP es la company y los CE son el array; el contact del deal se ignora', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact, contactEmployees: employees, source,
    });

    expect(result.businessPartnerSource).toBe('company');
    expect(result.contactEmployeeSources).toEqual(employees);
    expect(result.contactEmployeeSources).not.toContain(contact);
    expect(result.warnings).toEqual([]);
  });

  it('solo contact: BP es el contact y los CE son el array', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company: null, contact, contactEmployees: employees, source,
    });

    expect(result.businessPartnerSource).toBe('contact');
    expect(result.isCompanyBusinessPartner).toBe(false);
    expect(result.contactEmployeeSources).toEqual(employees);
  });

  it('solo company: BP es la company y los CE son el array', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact: null, contactEmployees: employees, source,
    });

    expect(result.contactEmployeeSources).toEqual(employees);
  });

  it('envuelve un objeto suelto en array', () => {
    const single = { hs_object_id: '9' };
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact: null, contactEmployees: single, source,
    });

    expect(result.contactEmployeeSources).toEqual([single]);
  });

  it('array ausente: CE vacio y warning, SIN caer al contact del deal', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company, contact, source });

    expect(result.contactEmployeeSources).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'BP_CONTACT_EMPLOYEES_ARRAY_MISSING' }]);
  });

  it('array vacio: CE vacio y warning', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact, contactEmployees: [], source,
    });

    expect(result.contactEmployeeSources).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'BP_CONTACT_EMPLOYEES_ARRAY_MISSING' }]);
  });

  it('descarta entradas que no son objetos', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact: null, contactEmployees: [null, 'texto', employees[0]], source,
    });

    expect(result.contactEmployeeSources).toEqual([employees[0]]);
  });
});

describe('resolveBusinessPartnerAndContactEmployees — validacion', () => {
  it.each(['dealContact', 'payloadArray'])('lanza si no hay company ni contact (%s)', (source) => {
    expect(() => resolveBusinessPartnerAndContactEmployees({ company: null, contact: null, source }))
      .toThrow(/company o un contact/);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/domain/contactEmployeeSource.test.js`
Expected: FAIL — `Cannot find module ... contact-employee-source.service.js`.

- [ ] **Step 3: Implementa el servicio**

Crea `src/domain/business-partners/contact-employee-source.service.js`:

```js
import { PermanentWebhookError } from '#shared/errors/index.js';
import { CONTACT_EMPLOYEE_SOURCES } from './business-partner-creation.constants.js';

export const CONTACT_EMPLOYEE_WARNINGS = Object.freeze({
  ARRAY_MISSING: 'BP_CONTACT_EMPLOYEES_ARRAY_MISSING',
});

// El workflow puede mandar un objeto suelto en vez de un array; envolverlo
// cuesta dos líneas y evita una clase entera de errores de configuración.
function toObjectList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object');
  }

  return value && typeof value === 'object' ? [value] : [];
}

export function resolveBusinessPartnerAndContactEmployees({
  company,
  contact,
  contactEmployees,
  source,
}) {
  const companyExists = Boolean(company);
  const contactExists = Boolean(contact);

  if (!companyExists && !contactExists) {
    throw new PermanentWebhookError(
      'El deal debe tener una company o un contact asociado para resolver el BusinessPartner'
    );
  }

  // El BP es la company si viene; si no, el contact. La regla es la misma en
  // ambas strategies: lo único que cambia es de dónde salen los CE.
  const businessPartnerSource = companyExists ? 'company' : 'contact';
  const warnings = [];
  let contactEmployeeSources = [];

  if (source === CONTACT_EMPLOYEE_SOURCES.PAYLOAD_ARRAY) {
    contactEmployeeSources = toObjectList(contactEmployees);

    if (contactEmployeeSources.length === 0) {
      // A propósito NO se cae al contact del deal: hacerlo reproduciría, de
      // forma invisible, la conducta que este modo existe para cambiar.
      warnings.push({ code: CONTACT_EMPLOYEE_WARNINGS.ARRAY_MISSING });
    }
  } else if (companyExists && contactExists) {
    contactEmployeeSources = [contact];
  }

  return {
    businessPartnerSource,
    businessPartner: companyExists ? company : contact,
    // Equivale exactamente a la expresión `companyExists || !contactExists`
    // que los use-cases pasaban como `companyExists` al adapter.
    isCompanyBusinessPartner: businessPartnerSource === 'company',
    contactEmployeeSources,
    warnings,
  };
}

export default { resolveBusinessPartnerAndContactEmployees, CONTACT_EMPLOYEE_WARNINGS };
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/domain/contactEmployeeSource.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/business-partners/contact-employee-source.service.js tests/unit/domain/contactEmployeeSource.test.js
git commit -m "feat: extract BusinessPartner and ContactEmployee source resolution"
```

---

### Task 6: Puerto, factory y strategy `legacyWhitelist` (guardia de regresión)

Esta es la tarea más importante del plan. La strategy `legacyWhitelist` debe producir **exactamente** el payload que hoy arma `SapWebhookOrderAdapter.js:268-299`. Ese test es lo que te permite refactorizar el adapter en la Tarea 9 sin miedo.

**Files:**
- Create: `src/application/ports/sap/business-partner-payload-strategy.port.js`
- Create: `src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js`
- Create: `src/domain/business-partners/business-partner-payload.factory.js`
- Test: `tests/unit/domain/businessPartnerPayloadStrategies.test.js`

**Interfaces:**
- Consumes: `BP_PAYLOAD_STRATEGIES` (Tarea 2); `createPort` de `../port-validator.js`; `toNonEmptyString` de `#shared/utils/string.utils.js`.
- Produces:
  - `BusinessPartnerPayloadStrategyPort` con métodos `['buildCreatePayload', 'includesContactEmployeesInCreate']`
  - `class LegacyWhitelistBusinessPartnerPayloadStrategy`
  - `class BusinessPartnerPayloadStrategyFactory` con `getStrategy(name)`
  - **Contrato de `buildCreatePayload`**, que la Tarea 7 debe respetar igual:
    ```
    buildCreatePayload({
      mappedBusinessPartner,   // { [sapField]: value } ya fusionado: { ...mappedContact, ...mappedCompany }
      addresses,               // object[] de la Tarea 4
      contactEmployees,        // object[] ya mapeados a campos de SAP
      propertiesFlags,         // { [`Properties${n}`]: 'tYES' } de la Tarea 3
      defaults,                // { BusinessPartner, ContactEmployee, BPAddress }
      resolved,                // ver abajo
    }) -> object
    ```
    `resolved` = `{ cardName, cardCode, defaultSeries, priceListNum, payTermsGrpCode, federalTaxId, mappedEmail, isCompanyBusinessPartner }`.

**Por qué `mappedBusinessPartner` puede ser un objeto fusionado:** hoy el adapter resuelve cada campo como `mappedCompany?.X || mappedContact?.X`. Como `mapHubspotToSapFields` (`order-builder.service.js:20-23`) ya descarta `null`/`undefined`/`''`, una llave solo existe en `mappedCompany` cuando tiene valor real, así que `{ ...mappedContact, ...mappedCompany }` da el mismo resultado. **Excepción:** `federalTaxId` y `cardName` NO son fallback en el código actual (dependen de `companyExists`), por eso viajan ya resueltos dentro de `resolved`.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/domain/businessPartnerPayloadStrategies.test.js`:

```js
import { jest } from '@jest/globals';
import BusinessPartnerPayloadStrategyFactory
  from '../../../src/domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import { BP_PAYLOAD_STRATEGIES }
  from '../../../src/domain/business-partners/business-partner-creation.constants.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { BusinessPartnerPayloadStrategyPort }
  from '../../../src/application/ports/sap/business-partner-payload-strategy.port.js';

describe('LegacyWhitelistBusinessPartnerPayloadStrategy', () => {
  const strategy = new LegacyWhitelistBusinessPartnerPayloadStrategy();

  it('cumple el puerto', () => {
    expect(() => assertPort(strategy, BusinessPartnerPayloadStrategyPort)).not.toThrow();
  });

  it('no incluye ContactEmployees en la creacion', () => {
    expect(strategy.includesContactEmployeesInCreate()).toBe(false);
  });

  // GUARDIA DE REGRESION: este objeto es literalmente el que armaba
  // SapWebhookOrderAdapter.js:268-299 antes del refactor.
  it('reproduce el payload historico cuando el BP es una company con CardCode', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { Phone1: '+50259877130', GroupCode: 105, U_TIPO: 'N' },
      resolved: {
        cardName: 'ACME',
        cardCode: 'CL123',
        defaultSeries: 59,
        priceListNum: 1,
        payTermsGrpCode: 13,
        federalTaxId: '0003004080-9',
        mappedEmail: 'ac@example.com',
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload).toEqual({
      CardName: 'ACME',
      CardType: 'C',
      CompanyPrivate: 'C',
      EmailAddress: 'ac@example.com',
      Phone1: '+50259877130',
      PriceListNum: 1,
      FederalTaxID: '0003004080-9',
      Frozen: 'tNO',
      Valid: 'tYES',
      CardCode: 'CL123',
      PayTermsGrpCode: 13,
    });
  });

  it('descarta los campos mapeados que no estan en el whitelist', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { GroupCode: 105, U_TIPO_IND: 'IP', Currency: 'GTQ' },
      resolved: {
        cardName: 'ACME', cardCode: null, defaultSeries: null, priceListNum: 1,
        payTermsGrpCode: null, federalTaxId: null, mappedEmail: null,
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload).not.toHaveProperty('GroupCode');
    expect(payload).not.toHaveProperty('U_TIPO_IND');
    expect(payload).not.toHaveProperty('Currency');
  });

  it('usa Series cuando no hay CardCode, y CompanyPrivate I cuando el BP es un contact', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      resolved: {
        cardName: 'Juan Perez', cardCode: null, defaultSeries: 59, priceListNum: 2,
        payTermsGrpCode: null, federalTaxId: null, mappedEmail: null,
        isCompanyBusinessPartner: false,
      },
    });

    expect(payload.Series).toBe(59);
    expect(payload).not.toHaveProperty('CardCode');
    expect(payload.CompanyPrivate).toBe('I');
    expect(payload.EmailAddress).toBe('');
    expect(payload).not.toHaveProperty('PayTermsGrpCode');
  });

  it('omite Phone1 y FederalTaxID cuando vienen vacios', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { Phone1: '   ' },
      resolved: {
        cardName: 'ACME', cardCode: 'X', defaultSeries: null, priceListNum: 1,
        payTermsGrpCode: null, federalTaxId: '  ', mappedEmail: null,
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload).not.toHaveProperty('Phone1');
    expect(payload).not.toHaveProperty('FederalTaxID');
  });

  it('conserva PayTermsGrpCode y PriceListNum en cero', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      resolved: {
        cardName: 'ACME', cardCode: 'X', defaultSeries: null, priceListNum: 0,
        payTermsGrpCode: 0, federalTaxId: null, mappedEmail: null,
        isCompanyBusinessPartner: true,
      },
    });

    expect(payload.PriceListNum).toBe(0);
    expect(payload.PayTermsGrpCode).toBe(0);
  });
});

describe('BusinessPartnerPayloadStrategyFactory', () => {
  const legacyStrategy = { name: 'legacy' };
  const fullMappedStrategy = { name: 'full' };

  it('resuelve la strategy legacy por nombre', () => {
    const factory = new BusinessPartnerPayloadStrategyFactory({ legacyStrategy, fullMappedStrategy });

    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST)).toBe(legacyStrategy);
  });

  it('resuelve la strategy fullMapped por nombre', () => {
    const factory = new BusinessPartnerPayloadStrategyFactory({ legacyStrategy, fullMappedStrategy });

    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.FULL_MAPPED)).toBe(fullMappedStrategy);
  });

  it('lanza con la lista de validas ante un nombre desconocido', () => {
    const logger = { error: jest.fn() };
    const factory = new BusinessPartnerPayloadStrategyFactory({ legacyStrategy, fullMappedStrategy, logger });

    expect(() => factory.getStrategy('nope'))
      .toThrow('BusinessPartner payload strategy not supported: nope');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      strategyName: 'nope',
      validStrategies: Object.values(BP_PAYLOAD_STRATEGIES),
    }));
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/domain/businessPartnerPayloadStrategies.test.js`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 3: Crea el puerto**

Crea `src/application/ports/sap/business-partner-payload-strategy.port.js`:

```js
import { createPort } from '../port-validator.js';

// Interfaz uniforme que implementa cada strategy de payload de creación del
// BusinessPartner, para que SapWebhookOrderAdapter no sepa cuál le dio el
// factory. includesContactEmployeesInCreate() existe para que el use-case sepa
// si debe saltarse el PATCH posterior de ContactEmployees, en vez de inferirlo
// del nombre de la strategy.
export const BusinessPartnerPayloadStrategyPort = createPort({
  name: 'BusinessPartnerPayloadStrategyPort',
  methods: [
    'buildCreatePayload',
    'includesContactEmployeesInCreate',
  ],
});

export default BusinessPartnerPayloadStrategyPort;
```

- [ ] **Step 4: Crea la strategy `legacyWhitelist`**

Crea `src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js`:

```js
import { toNonEmptyString } from '#shared/utils/string.utils.js';

// Reproduce campo por campo el payload que SapWebhookOrderAdapter armaba en
// línea antes de que el armado se extrajera a strategies. NO agregues campos
// aquí: cualquier cambio de conducta va en full-mapped-bp-payload.strategy.js.
// El test tests/unit/domain/businessPartnerPayloadStrategies.test.js es la
// guardia de regresión de todos los tenants existentes.
export class LegacyWhitelistBusinessPartnerPayloadStrategy {
  buildCreatePayload({ mappedBusinessPartner, resolved }) {
    const payload = {
      CardName: resolved.cardName,
      CardType: 'C',
      CompanyPrivate: resolved.isCompanyBusinessPartner ? 'C' : 'I',
      EmailAddress: resolved.mappedEmail || '',
      Phone1: toNonEmptyString(mappedBusinessPartner?.Phone1) || undefined,
      PriceListNum: resolved.priceListNum,
      FederalTaxID: toNonEmptyString(resolved.federalTaxId) || undefined,
      Frozen: 'tNO',
      Valid: 'tYES',
    };

    // Mismo orden de decisión que el código original: CardCode si hay, y solo
    // si no hay se recurre a la Series por defecto del tenant.
    if (resolved.cardCode) {
      payload.CardCode = resolved.cardCode;
    } else if (resolved.defaultSeries) {
      payload.Series = resolved.defaultSeries;
    }

    if (resolved.payTermsGrpCode !== null && typeof resolved.payTermsGrpCode !== 'undefined') {
      payload.PayTermsGrpCode = resolved.payTermsGrpCode;
    }

    // El original construía el objeto con `Phone1: ... || undefined`, y un
    // undefined explícito no viaja en el JSON del POST. Se borra la llave para
    // que el payload sea comparable con toEqual en los tests.
    for (const [field, value] of Object.entries(payload)) {
      if (typeof value === 'undefined') {
        delete payload[field];
      }
    }

    return payload;
  }

  includesContactEmployeesInCreate() {
    return false;
  }
}

export default LegacyWhitelistBusinessPartnerPayloadStrategy;
```

- [ ] **Step 5: Crea el factory**

Crea `src/domain/business-partners/business-partner-payload.factory.js`, siguiendo el molde de `src/domain/warehouses/warehouse-stock-strategy.factory.js`:

```js
import { BP_PAYLOAD_STRATEGIES } from './business-partner-creation.constants.js';

export class BusinessPartnerPayloadStrategyFactory {
  constructor({
    legacyStrategy,
    fullMappedStrategy,
    logger = console,
  }) {
    this.strategies = {
      [BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST]: legacyStrategy,
      [BP_PAYLOAD_STRATEGIES.FULL_MAPPED]: fullMappedStrategy,
    };
    this.logger = logger;
  }

  // Lanza a propósito: una strategy mal escrita en la config debe fallar antes
  // de que el webhook escriba nada en SAP, no a mitad del flujo.
  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    if (Object.hasOwn(this.strategies, normalizedStrategyName)) {
      return this.strategies[normalizedStrategyName];
    }

    this.logger.error?.({
      msg: 'BusinessPartner payload strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(BP_PAYLOAD_STRATEGIES),
    });

    throw new Error(`BusinessPartner payload strategy not supported: ${normalizedStrategyName}`);
  }
}

export default BusinessPartnerPayloadStrategyFactory;
```

- [ ] **Step 6: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/domain/businessPartnerPayloadStrategies.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/application/ports/sap/business-partner-payload-strategy.port.js src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js src/domain/business-partners/business-partner-payload.factory.js tests/unit/domain/businessPartnerPayloadStrategies.test.js
git commit -m "feat: add BusinessPartner payload strategy port, factory and legacy strategy"
```

---

### Task 7: Strategy `fullMapped`

**Files:**
- Create: `src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js`
- Test: `tests/unit/domain/fullMappedBpPayload.test.js`

**Interfaces:**
- Consumes: el contrato de `buildCreatePayload` definido en la Tarea 6, tal cual.
- Produces: `class FullMappedBusinessPartnerPayloadStrategy`. `includesContactEmployeesInCreate()` devuelve `true`.

**Reglas de armado:**
1. Base: `defaults.BusinessPartner`, sobreescrito por `mappedBusinessPartner`, sobreescrito por `propertiesFlags`.
2. `CardName` siempre se reafirma desde `resolved.cardName` (es el único obligatorio de SAP y el adapter ya lo validó).
3. `BPAddresses`/`ContactEmployees` nunca pueden venir de un mapping: se borran de la base y se asignan solo desde los arrays.
4. `CardCode` si hay; si no, `Series` (respetando una `Series` que ya venga mapeada o de defaults).
5. `PriceListNum` y `PayTermsGrpCode` de `resolved` solo si no vinieron ya en la base. **Cuidado: `0` es un valor válido**, así que la comprobación es "tiene valor", no truthiness.
6. `CardType` cae a `'C'` si nadie lo puso (SAP lo exige).
7. Los arrays vacíos no se envían.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/domain/fullMappedBpPayload.test.js`:

```js
import FullMappedBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { BusinessPartnerPayloadStrategyPort }
  from '../../../src/application/ports/sap/business-partner-payload-strategy.port.js';

const strategy = new FullMappedBusinessPartnerPayloadStrategy();

const RESOLVED = {
  cardName: 'EMPRESA DE PRUEBA 29052026',
  cardCode: null,
  defaultSeries: 59,
  priceListNum: 1,
  payTermsGrpCode: 13,
  federalTaxId: '0003004080-9',
  mappedEmail: 'ac123@gmail.com',
  isCompanyBusinessPartner: true,
};

const DEFAULTS = {
  BusinessPartner: { CardType: 'cCustomer', PayTermsGrpCode: 13, Series: 59, PriceListNum: 1 },
  ContactEmployee: { Active: 'tYES' },
  BPAddress: { TaxCode: 'IVA' },
};

describe('FullMappedBusinessPartnerPayloadStrategy', () => {
  it('cumple el puerto e incluye ContactEmployees en la creacion', () => {
    expect(() => assertPort(strategy, BusinessPartnerPayloadStrategyPort)).not.toThrow();
    expect(strategy.includesContactEmployeesInCreate()).toBe(true);
  });

  // TEST DE ACEPTACION: reproduce el JSON objetivo del spec.
  it('produce el payload objetivo del cliente', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {
        CardName: 'EMPRESA DE PRUEBA 29052026',
        GroupCode: 105,
        Phone1: '+50259877130',
        FederalTaxID: '0003004080-9',
        SalesPersonCode: 1,
        EmailAddress: 'ac123@gmail.com',
        U_TIPO_IND: 'IP',
        U_SUBGRUPO: 'EMPRESAS MERCANTILES',
        U_TIPO: 'N',
        U_VENDEQUI: 'CHIEQP - Luis Lee',
        U_CORREO_FACTURA: 'asalas@smarteamcr.com',
      },
      addresses: [
        { AddressName: 'factura', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_BillTo' },
        { AddressName: 'Entrega', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_ShipTo' },
      ],
      contactEmployees: [
        { Name: 'Juan Mazariegos', Position: 'Sr.', Phone1: '3038-5327', Title: 'Lic.', Active: 'tYES', FirstName: 'Juan', LastName: 'Mazariegos', U_SUCURSAL: 'central' },
      ],
      propertiesFlags: { Properties1: 'tYES' },
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload).toEqual({
      CardName: 'EMPRESA DE PRUEBA 29052026',
      CardType: 'cCustomer',
      GroupCode: 105,
      Phone1: '+50259877130',
      PayTermsGrpCode: 13,
      FederalTaxID: '0003004080-9',
      PriceListNum: 1,
      SalesPersonCode: 1,
      EmailAddress: 'ac123@gmail.com',
      Properties1: 'tYES',
      U_TIPO_IND: 'IP',
      Series: 59,
      U_SUBGRUPO: 'EMPRESAS MERCANTILES',
      U_TIPO: 'N',
      U_VENDEQUI: 'CHIEQP - Luis Lee',
      U_CORREO_FACTURA: 'asalas@smarteamcr.com',
      BPAddresses: [
        { AddressName: 'factura', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_BillTo' },
        { AddressName: 'Entrega', Street: 'Carretera vieja', County: 'La Habana', Country: 'GT', TaxCode: 'IVA', AddressType: 'bo_ShipTo' },
      ],
      ContactEmployees: [
        { Name: 'Juan Mazariegos', Position: 'Sr.', Phone1: '3038-5327', Title: 'Lic.', Active: 'tYES', FirstName: 'Juan', LastName: 'Mazariegos', U_SUCURSAL: 'central' },
      ],
    });
  });

  it('el valor mapeado gana sobre el default de config', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { PriceListNum: 7, CardType: 'cSupplier' },
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload.PriceListNum).toBe(7);
    expect(payload.CardType).toBe('cSupplier');
  });

  it('cae al default de config cuando no hay valor mapeado', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload.CardType).toBe('cCustomer');
    expect(payload.PayTermsGrpCode).toBe(13);
  });

  it('omite el campo cuando no hay valor en ningun lado', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: { ...RESOLVED, priceListNum: null, payTermsGrpCode: null, defaultSeries: null },
    });

    expect(payload).not.toHaveProperty('PriceListNum');
    expect(payload).not.toHaveProperty('PayTermsGrpCode');
    expect(payload).not.toHaveProperty('Series');
  });

  it('nunca manda null: los valores vacios se omiten', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { U_TIPO: null, U_SUBGRUPO: '', GroupCode: 105 },
      defaults: { BusinessPartner: { Currency: null }, ContactEmployee: {}, BPAddress: {} },
      resolved: RESOLVED,
    });

    expect(payload).not.toHaveProperty('U_TIPO');
    expect(payload).not.toHaveProperty('U_SUBGRUPO');
    expect(payload).not.toHaveProperty('Currency');
    expect(payload.GroupCode).toBe(105);
  });

  it('conserva PriceListNum y PayTermsGrpCode en cero', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: { ...RESOLVED, priceListNum: 0, payTermsGrpCode: 0 },
    });

    expect(payload.PriceListNum).toBe(0);
    expect(payload.PayTermsGrpCode).toBe(0);
  });

  it('usa CardCode y omite Series cuando hay CardCode', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: { ...RESOLVED, cardCode: 'CL999' },
    });

    expect(payload.CardCode).toBe('CL999');
    expect(payload).not.toHaveProperty('Series');
  });

  it('cae a CardType C cuando nadie lo define', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      resolved: RESOLVED,
    });

    expect(payload.CardType).toBe('C');
  });

  it('no manda arrays vacios', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: {},
      addresses: [],
      contactEmployees: [],
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload).not.toHaveProperty('BPAddresses');
    expect(payload).not.toHaveProperty('ContactEmployees');
  });

  it('ignora BPAddresses y ContactEmployees que vengan de un mapping', () => {
    const payload = strategy.buildCreatePayload({
      mappedBusinessPartner: { BPAddresses: 'basura', ContactEmployees: 'basura' },
      addresses: [{ AddressName: 'factura' }],
      contactEmployees: [],
      defaults: DEFAULTS,
      resolved: RESOLVED,
    });

    expect(payload.BPAddresses).toEqual([{ AddressName: 'factura' }]);
    expect(payload).not.toHaveProperty('ContactEmployees');
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/domain/fullMappedBpPayload.test.js`
Expected: FAIL — `Cannot find module ... full-mapped-bp-payload.strategy.js`.

- [ ] **Step 3: Implementa la strategy**

Crea `src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js`:

```js
// Colecciones anidadas: nunca pueden salir de un FieldMapping (el mapper copia
// valores escalares), así que se borran de la base y se asignan solo desde los
// arrays que arma el llamador.
const NESTED_COLLECTION_FIELDS = ['BPAddresses', 'ContactEmployees'];

// SAP B1 exige CardType. 'C' (cCustomer) es lo que usaba el código anterior.
const FALLBACK_CARD_TYPE = 'C';

function hasValue(value) {
  return value !== null && typeof value !== 'undefined' && value !== '';
}

function omitBlank(source) {
  const result = {};

  for (const [field, value] of Object.entries(source || {})) {
    if (hasValue(value)) {
      result[field] = value;
    }
  }

  return result;
}

export class FullMappedBusinessPartnerPayloadStrategy {
  buildCreatePayload({
    mappedBusinessPartner,
    addresses,
    contactEmployees,
    propertiesFlags,
    defaults,
    resolved,
  }) {
    // Precedencia: defaults de config -> valores mapeados de HubSpot ->
    // banderas PropertiesN (que no pueden venir de un mapping).
    const payload = {
      ...omitBlank(defaults?.BusinessPartner),
      ...omitBlank(mappedBusinessPartner),
      ...omitBlank(propertiesFlags),
    };

    for (const field of NESTED_COLLECTION_FIELDS) {
      delete payload[field];
    }

    // CardName es el único obligatorio de SAP y el adapter ya lo validó.
    payload.CardName = resolved.cardName;

    if (!hasValue(payload.CardType)) {
      payload.CardType = FALLBACK_CARD_TYPE;
    }

    if (resolved.cardCode) {
      payload.CardCode = resolved.cardCode;
      delete payload.Series;
    } else if (!hasValue(payload.Series) && hasValue(resolved.defaultSeries)) {
      payload.Series = resolved.defaultSeries;
    }

    // hasValue y no truthiness: PriceListNum 0 y PayTermsGrpCode 0 son valores
    // válidos en SAP B1.
    if (!hasValue(payload.PriceListNum) && hasValue(resolved.priceListNum)) {
      payload.PriceListNum = resolved.priceListNum;
    }

    if (!hasValue(payload.PayTermsGrpCode) && hasValue(resolved.payTermsGrpCode)) {
      payload.PayTermsGrpCode = resolved.payTermsGrpCode;
    }

    if (Array.isArray(addresses) && addresses.length > 0) {
      payload.BPAddresses = addresses;
    }

    if (Array.isArray(contactEmployees) && contactEmployees.length > 0) {
      payload.ContactEmployees = contactEmployees;
    }

    return payload;
  }

  includesContactEmployeesInCreate() {
    return true;
  }
}

export default FullMappedBusinessPartnerPayloadStrategy;
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/domain/fullMappedBpPayload.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js tests/unit/domain/fullMappedBpPayload.test.js
git commit -m "feat: add fullMapped BusinessPartner payload strategy"
```

---

### Task 8: Exponer los arrays del payload y los mappings de dirección

**Files:**
- Modify: `src/application/services/webhook-payload.service.js:3-14`
- Modify: `src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js:33-92` y el bloque de resolvers (después de `resolveDefaultFindSAP`, línea ~209)
- Test: `tests/unit/application/webhookPayloadBpArrays.test.js`

**Interfaces:**
- Consumes: `BP_ADDRESS_OBJECT_TYPE`, `BP_ADDRESS_SOURCE_CONTEXT` (Tarea 2); `BusinessPartnerCreationConfigRepository` (Tarea 2).
- Produces:
  - `resolveEventPayload(event)` ahora devuelve además `contactEmployees` y `bpAddress` (siempre arrays; `[]` cuando no vienen).
  - `context.mappings.addressMappings` en el runtime context.
  - `runtimeRepository.resolveBusinessPartnerCreationConfig(tenantModels)` y `.resolvePropertiesFlagsConfig(tenantModels)`.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/application/webhookPayloadBpArrays.test.js`:

```js
import { resolveEventPayload } from '../../../src/application/services/webhook-payload.service.js';

describe('resolveEventPayload — arrays de BusinessPartner', () => {
  it('expone contactEmployees y bpAddress desde payload', () => {
    const result = resolveEventPayload({
      payload: {
        deal: { hs_object_id: '1' },
        company: { hs_object_id: '2' },
        contact: null,
        contactEmployees: [{ hs_object_id: '3' }],
        bpAddress: [{ AddressName: 'factura' }],
        line_items: [],
      },
    });

    expect(result.contactEmployees).toEqual([{ hs_object_id: '3' }]);
    expect(result.bpAddress).toEqual([{ AddressName: 'factura' }]);
  });

  it('los lee tambien desde payload.data', () => {
    const result = resolveEventPayload({
      payload: {
        data: {
          contactEmployees: [{ hs_object_id: '3' }],
          bpAddress: [{ AddressName: 'entrega' }],
        },
      },
    });

    expect(result.contactEmployees).toEqual([{ hs_object_id: '3' }]);
    expect(result.bpAddress).toEqual([{ AddressName: 'entrega' }]);
  });

  it('envuelve un objeto suelto en array', () => {
    const result = resolveEventPayload({
      payload: { contactEmployees: { hs_object_id: '3' } },
    });

    expect(result.contactEmployees).toEqual([{ hs_object_id: '3' }]);
  });

  it('devuelve arrays vacios cuando no vienen (payload legacy)', () => {
    const result = resolveEventPayload({
      payload: { deal: { hs_object_id: '1' }, company: { hs_object_id: '2' } },
    });

    expect(result.contactEmployees).toEqual([]);
    expect(result.bpAddress).toEqual([]);
  });

  it('no rompe los campos que ya devolvia', () => {
    const result = resolveEventPayload({
      payload: {
        deal: { hs_object_id: '1' },
        company: { hs_object_id: '2' },
        contact: { hs_object_id: '3' },
        line_items: [{ hs_object_id: '4' }],
      },
    });

    expect(result.deal).toEqual({ hs_object_id: '1' });
    expect(result.company).toEqual({ hs_object_id: '2' });
    expect(result.contact).toEqual({ hs_object_id: '3' });
    expect(result.lineItems).toEqual([{ hs_object_id: '4' }]);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/application/webhookPayloadBpArrays.test.js`
Expected: FAIL — `contactEmployees` y `bpAddress` son `undefined`.

- [ ] **Step 3: Extiende `resolveEventPayload`**

En `src/application/services/webhook-payload.service.js`, reemplaza las líneas 1-14 por:

```js
import { toNonEmptyString } from '#shared/utils/string.utils.js';

// El workflow de HubSpot puede mandar una colección como array o, por descuido
// de configuración, como objeto suelto. Envolverlo evita una clase entera de
// errores silenciosos.
function toObjectArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object');
  }

  return value && typeof value === 'object' ? [value] : [];
}

export function resolveEventPayload(event) {
  const payload = event?.payload || {};
  return {
    payload,
    deal: payload?.deal || payload?.data?.deal || null,
    company: payload?.company || payload?.data?.company || null,
    contact: payload?.contact || payload?.data?.contact || null,
    lineItems: Array.isArray(payload?.line_items)
      ? payload.line_items
      : (Array.isArray(payload?.data?.line_items) ? payload.data.line_items : []),
    // Contactos que se convierten en ContactEmployees de SAP. Solo se usa
    // cuando el tenant configura contactEmployeeSource: 'payloadArray'.
    contactEmployees: toObjectArray(payload?.contactEmployees ?? payload?.data?.contactEmployees),
    // Direcciones que se convierten en BPAddresses de SAP. La llave es
    // singular porque así la manda el workflow de HubSpot.
    bpAddress: toObjectArray(payload?.bpAddress ?? payload?.data?.bpAddress),
  };
}
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/application/webhookPayloadBpArrays.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Agrega los mappings de dirección al runtime context**

En `src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js`:

Primero, agrega los imports al inicio del archivo:

```js
import BusinessPartnerCreationConfigRepository from '#infrastructure/config/BusinessPartnerCreationConfigRepository.js';
import {
  BP_ADDRESS_OBJECT_TYPE,
  BP_ADDRESS_SOURCE_CONTEXT,
} from '#domain/business-partners/business-partner-creation.constants.js';
```

y después de la línea `const GROUP_CODE_DEFAULTS_CONFIG_KEY = 'groupCodeDefauls';`:

```js
const businessPartnerCreationConfigRepository = new BusinessPartnerCreationConfigRepository();
```

Luego, en el array desestructurado de `Promise.all` (líneas 33-45), agrega `addressMappings` justo después de `contactEmployeeMappings`, y la llamada correspondiente después de la línea 49:

```js
      // Direcciones de BPAddresses. El fallback a businessPartner queda
      // APAGADO a propósito: sin eso, un tenant sin filas bpAddress recibiría
      // las de contexto businessPartner y filtraría campos de cabecera
      // (CardName, CardCode, DocEntry...) dentro de cada BPAddresses[].
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        BP_ADDRESS_OBJECT_TYPE,
        BP_ADDRESS_SOURCE_CONTEXT,
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
```

Finalmente, agrega la llave al objeto `mappings` del `return` de `resolveRuntimeContext` (líneas 101-111), justo después de `contactEmployeeMappings`:

```js
      mappings: {
        companyMappings,
        contactBusinessPartnerMappings,
        contactEmployeeMappings,
        addressMappings,
        productMappings,
        productOrdersQuotationsMappings,
        dealMappings,
        dealOrdersQuotationsMappings,
        dealInventoryTransferRequestMappings,
        productInventoryTransferRequestMappings,
      },
```

> El orden de `addressMappings` en el array desestructurado del `Promise.all` (Step 5) tiene que coincidir con la posición de su llamada `getMappingsByObjectType`. Si las pones desalineadas, `addressMappings` recibirá los mappings de producto y nada fallará en voz alta: solo saldrán direcciones con campos de `Items`. Cuéntalas.

- [ ] **Step 6: Agrega los resolvers de configuración**

En la misma clase, junto a `resolveDefaultFindSAP` (línea ~203) y `resolveUpsertDataSap` (línea ~217), agrega:

```js
  async resolveBusinessPartnerCreationConfig(tenantModels) {
    return businessPartnerCreationConfigRepository.getBusinessPartnerCreationConfig({ tenantModels });
  }

  async resolvePropertiesFlagsConfig(tenantModels) {
    return businessPartnerCreationConfigRepository.getPropertiesFlagsConfig({ tenantModels });
  }
```

- [ ] **Step 7: Corre la suite completa**

Run: `npm test`
Expected: sin fallos nuevos. `addressMappings` será `[]` en todos los tenants actuales, y los dos resolvers devuelven los defaults, así que nada cambia de conducta todavía.

- [ ] **Step 8: Commit**

```bash
git add src/application/services/webhook-payload.service.js src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js tests/unit/application/webhookPayloadBpArrays.test.js
git commit -m "feat: expose bpAddress/contactEmployees payload arrays and address mappings"
```

---

### Task 9: El adapter usa la strategy y sabe agregar varios ContactEmployees

Los parámetros nuevos de `findOrCreateBusinessPartner` son **opcionales con default**, siguiendo el patrón que el método ya usa (`resolveRequireRandCardCode = async () => true`, etc.). Sin ellos, el comportamiento es idéntico al de hoy, así que ningún test existente se rompe.

`addContactEmployeeIfNeeded` **no se toca**. Se agrega un método nuevo que lo llama en bucle: riesgo cero para los tres call sites actuales.

**Files:**
- Modify: `src/infrastructure/sap/SapWebhookOrderAdapter.js:154-321` (firma y armado del payload)
- Modify: `src/infrastructure/sap/SapWebhookOrderAdapter.js` (método nuevo tras `addContactEmployeeIfNeeded`, línea ~453)
- Test: `tests/unit/infrastructure/sapWebhookOrderAdapter.fullCreation.test.js`

**Interfaces:**
- Consumes: `BusinessPartnerPayloadStrategyFactory`, `LegacyWhitelistBusinessPartnerPayloadStrategy` (Tarea 6); `FullMappedBusinessPartnerPayloadStrategy` (Tarea 7).
- Produces:
  - `findOrCreateBusinessPartner` acepta además: `payloadStrategy` (instancia, default una `LegacyWhitelist...`), `bpAddresses = []`, `mappedContactEmployees = []`, `propertiesFlags = {}`, `creationDefaults = null`.
  - **Nota de nomenclatura:** `bpAddresses` es el array **ya listo para SAP** que devuelve `buildBpAddresses` (Tarea 4), no el resultado crudo de mapear cada entrada del payload. Ese intermedio no cruza esta frontera.
  - `addContactEmployeesIfNeeded({ sapConfig, cardCode, businessPartner, contacts, contactEmployeeMappings, upsertConfig }) -> { created, internalCodes: [{ contact, internalCode }], results: object[], requestPayload: object[], responsePayload: object[] }`

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/sapWebhookOrderAdapter.fullCreation.test.js`:

```js
import { jest } from '@jest/globals';
import SapWebhookOrderAdapter from '../../../src/infrastructure/sap/SapWebhookOrderAdapter.js';
import FullMappedBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';

function buildAdapter(requestImpl) {
  const adapter = new SapWebhookOrderAdapter();
  adapter.request = jest.fn(requestImpl);
  return adapter;
}

const BASE_ARGS = {
  sapConfig: { serviceLayerBaseUrl: 'https://sap.example.com' },
  tenantModels: {},
  company: { hs_object_id: '1', name: 'ACME' },
  contact: null,
  mappedContact: {},
  companyExists: true,
  resolveDefaultPriceListNum: async () => 1,
  resolveRequireRandCardCode: async () => false,
  resolveDefaultSeries: async () => 59,
  resolveDefaultFindSAP: async () => 'EmailAddress',
  resolveGroupCodeDefaults: async () => null,
};

describe('findOrCreateBusinessPartner — payload con la strategy fullMapped', () => {
  it('manda BPAddresses, ContactEmployees y PropertiesN anidados en el POST', async () => {
    const adapter = buildAdapter(async (config, { method, path }) => {
      if (method === 'get' && path.startsWith("/BusinessPartners('")) {
        const error = new Error('not found');
        error.response = { status: 404 };
        throw error;
      }
      if (method === 'get') { return { value: [] }; }
      return { CardCode: 'CL999' };
    });

    const result = await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', GroupCode: 105, U_TIPO: 'N' },
      payloadStrategy: new FullMappedBusinessPartnerPayloadStrategy(),
      bpAddresses: [{ AddressName: 'factura', AddressType: 'bo_BillTo', Street: 'Calle 1' }],
      mappedContactEmployees: [{ Name: 'Juan', Active: 'tYES' }],
      propertiesFlags: { Properties1: 'tYES', Properties55: 'tYES' },
      creationDefaults: { BusinessPartner: { CardType: 'cCustomer' }, ContactEmployee: {}, BPAddress: {} },
    });

    const postCall = adapter.request.mock.calls.find(([, options]) => options.method === 'post');

    expect(postCall[1].path).toBe('/BusinessPartners');
    expect(postCall[1].data).toMatchObject({
      CardName: 'ACME',
      CardType: 'cCustomer',
      GroupCode: 105,
      U_TIPO: 'N',
      Properties1: 'tYES',
      Properties55: 'tYES',
      BPAddresses: [{ AddressName: 'factura', AddressType: 'bo_BillTo', Street: 'Calle 1' }],
      ContactEmployees: [{ Name: 'Juan', Active: 'tYES' }],
    });
    expect(result.created).toBe(true);
    expect(result.cardCode).toBe('CL999');
  });

  it('sin payloadStrategy conserva el payload historico de nueve campos', async () => {
    const adapter = buildAdapter(async (config, { method, path }) => {
      if (method === 'get' && path.startsWith("/BusinessPartners('")) {
        const error = new Error('not found');
        error.response = { status: 404 };
        throw error;
      }
      if (method === 'get') { return { value: [] }; }
      return { CardCode: 'CL999' };
    });

    await adapter.findOrCreateBusinessPartner({
      ...BASE_ARGS,
      mappedCompany: { CardName: 'ACME', GroupCode: 105, U_TIPO: 'N' },
    });

    const postCall = adapter.request.mock.calls.find(([, options]) => options.method === 'post');

    expect(postCall[1].data).not.toHaveProperty('GroupCode');
    expect(postCall[1].data).not.toHaveProperty('U_TIPO');
    expect(postCall[1].data).not.toHaveProperty('BPAddresses');
    expect(postCall[1].data.CardType).toBe('C');
    expect(postCall[1].data.Frozen).toBe('tNO');
  });
});

describe('addContactEmployeesIfNeeded', () => {
  it('agrega cada contacto de la lista y devuelve sus internalCodes', async () => {
    const adapter = new SapWebhookOrderAdapter();
    adapter.addContactEmployeeIfNeeded = jest.fn()
      .mockResolvedValueOnce({ created: true, internalCode: 11, requestPayload: { Name: 'Ana' }, responsePayload: {} })
      .mockResolvedValueOnce({ created: true, internalCode: 12, requestPayload: { Name: 'Luis' }, responsePayload: {} });

    const contacts = [{ firstname: 'Ana' }, { firstname: 'Luis' }];
    const result = await adapter.addContactEmployeesIfNeeded({
      sapConfig: {}, cardCode: 'CL999', businessPartner: { CardCode: 'CL999' },
      contacts, contactEmployeeMappings: [], upsertConfig: null,
    });

    expect(adapter.addContactEmployeeIfNeeded).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(true);
    expect(result.internalCodes).toEqual([
      { contact: contacts[0], internalCode: 11 },
      { contact: contacts[1], internalCode: 12 },
    ]);
    expect(result.requestPayload).toEqual([{ Name: 'Ana' }, { Name: 'Luis' }]);
  });

  it('con lista vacia no llama a SAP', async () => {
    const adapter = new SapWebhookOrderAdapter();
    adapter.addContactEmployeeIfNeeded = jest.fn();

    const result = await adapter.addContactEmployeesIfNeeded({
      sapConfig: {}, cardCode: 'CL999', businessPartner: {}, contacts: [],
      contactEmployeeMappings: [], upsertConfig: null,
    });

    expect(adapter.addContactEmployeeIfNeeded).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.internalCodes).toEqual([]);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/sapWebhookOrderAdapter.fullCreation.test.js`
Expected: FAIL — el primer test no encuentra `BPAddresses` en el POST; `addContactEmployeesIfNeeded` no existe.

- [ ] **Step 3: Cambia el armado del payload en el adapter**

En `src/infrastructure/sap/SapWebhookOrderAdapter.js`, agrega el import al inicio:

```js
import LegacyWhitelistBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
```

y una instancia compartida (es sin estado) después de los imports:

```js
const DEFAULT_BP_PAYLOAD_STRATEGY_INSTANCE = new LegacyWhitelistBusinessPartnerPayloadStrategy();
```

Agrega los parámetros nuevos a la firma de `findOrCreateBusinessPartner` (después de `upsertConfig = null,` en la línea 167):

```js
    upsertConfig = null,
    // Sin estos, el payload es idéntico al que armaba el código anterior.
    payloadStrategy = DEFAULT_BP_PAYLOAD_STRATEGY_INSTANCE,
    bpAddresses = [],
    mappedContactEmployees = [],
    propertiesFlags = {},
    creationDefaults = null,
  }) {
```

Reemplaza el bloque de construcción del payload (líneas 268-299, desde `const payload = {` hasta el cierre del `if (resolvedPayTermsGrpCode !== null) { ... }`) por:

```js
    const mappedPayTermsGrpCode = normalizeInteger(
      mappedCompany?.PayTermsGrpCode ?? mappedContact?.PayTermsGrpCode
    );
    const resolvedPayTermsGrpCode = mappedPayTermsGrpCode !== null
      ? mappedPayTermsGrpCode
      : normalizeInteger((await resolveGroupCodeDefaults(tenantModels))?.PayTermsGrpCode);

    const resolvedDefaultSeries = resolvedCardCode
      ? null
      : await resolveDefaultSeries(tenantModels);

    // mapHubspotToSapFields ya descarta null/undefined/'', así que una llave
    // solo existe en mappedCompany cuando tiene valor real. Por eso este
    // spread equivale exactamente al `mappedCompany?.X || mappedContact?.X`
    // que usaba el código anterior campo por campo.
    const mappedBusinessPartner = { ...mappedContact, ...mappedCompany };

    const payload = payloadStrategy.buildCreatePayload({
      mappedBusinessPartner,
      addresses: bpAddresses,
      contactEmployees: mappedContactEmployees,
      propertiesFlags,
      defaults: creationDefaults,
      resolved: {
        cardName,
        cardCode: resolvedCardCode,
        defaultSeries: resolvedDefaultSeries,
        priceListNum: resolvedPriceListNum,
        payTermsGrpCode: resolvedPayTermsGrpCode,
        federalTaxId,
        mappedEmail,
        isCompanyBusinessPartner: Boolean(companyExists),
      },
    });
```

> **Cuidado con el orden:** en el código original `resolveDefaultSeries` solo se llamaba cuando NO había `CardCode` (línea 283), y `resolveGroupCodeDefaults` solo cuando el valor mapeado era `null` (línea 295). El bloque de arriba preserva las dos condiciones. No las cambies: son llamadas a base de datos y algún test existente cuenta las invocaciones.

- [ ] **Step 4: Agrega `addContactEmployeesIfNeeded`**

Justo después del cierre de `addContactEmployeeIfNeeded` (línea ~453), agrega:

```js
  // Envoltura de addContactEmployeeIfNeeded para varios contactos. Se usa
  // cuando contactEmployeeSource es 'payloadArray'. Deliberadamente NO cambia
  // el método de un solo contacto, para no arriesgar los flujos existentes.
  // Secuencial a propósito: B1 reemplaza el array completo de ContactEmployees
  // en cada PATCH, así que dos llamadas en paralelo se pisarían entre sí.
  async addContactEmployeesIfNeeded({
    sapConfig,
    cardCode,
    businessPartner,
    contacts,
    contactEmployeeMappings,
    upsertConfig = null,
  }) {
    const contactList = Array.isArray(contacts) ? contacts.filter(Boolean) : [];
    const results = [];
    const internalCodes = [];
    const requestPayload = [];
    const responsePayload = [];
    let created = false;
    let currentBusinessPartner = businessPartner;

    for (const contact of contactList) {
      const result = await this.addContactEmployeeIfNeeded({
        sapConfig,
        cardCode,
        businessPartner: currentBusinessPartner,
        contact,
        contactEmployeeMappings,
        upsertConfig,
      });

      results.push(result);
      created = created || Boolean(result?.created);

      if (result?.internalCode) {
        internalCodes.push({ contact, internalCode: result.internalCode });
      }

      if (result?.requestPayload) {
        requestPayload.push(result.requestPayload);
      }

      if (result?.responsePayload) {
        responsePayload.push(result.responsePayload);
      }

      // Cada append devuelve el BP recargado; usarlo en la vuelta siguiente
      // evita que el segundo contacto borre al primero.
      if (result?.businessPartner) {
        currentBusinessPartner = result.businessPartner;
      }
    }

    return { created, internalCodes, results, requestPayload, responsePayload };
  }
```

- [ ] **Step 5: Verifica que `addContactEmployeeIfNeeded` devuelva el BP recargado**

Lee `src/infrastructure/sap/SapWebhookOrderAdapter.js:435-452`. Ya hace un re-GET para recuperar el `InternalCode`. Si el objeto que retorna **no** incluye el BusinessPartner recargado, agrégalo como `businessPartner` en el `return` (sin quitar ninguna llave existente). Sin eso, agregar dos contactos hace que el segundo PATCH borre al primero.

- [ ] **Step 6: Corre el test nuevo**

Run: `npm test -- tests/unit/infrastructure/sapWebhookOrderAdapter.fullCreation.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 7: Corre la suite completa — esta es la verificación crítica de regresión**

Run: `npm test`
Expected: sin fallos nuevos. Presta especial atención a `tests/unit/infrastructure/sapWebhookOrderAdapter.contactEmployee.test.js`, `tests/unit/infrastructure/sapWebhookOrderAdapter.upsertBusinessPartner.test.js`, `tests/unit/webhookProcessor.flow.test.js` y `tests/unit/application/processQuotationFlows.test.js`. Si alguno falla, tu payload por defecto **no** es idéntico al anterior: compara el objeto esperado del test contra lo que produce la strategy legacy y corrige la strategy, no el test.

- [ ] **Step 8: Commit**

```bash
git add src/infrastructure/sap/SapWebhookOrderAdapter.js tests/unit/infrastructure/sapWebhookOrderAdapter.fullCreation.test.js
git commit -m "feat: build BusinessPartner create payload through a strategy"
```

---

### Task 10: Conectar los tres use-cases

**Files:**
- Modify: `src/application/use-cases/ProcessHubspotWebhookEvent.js:37-143`
- Modify: `src/application/use-cases/webhookQuotationSupport.js:112-230`
- Modify: `src/application/use-cases/ProcessHubspotInventoryTransferRequest.js:46-101`
- Test: `tests/unit/application/processFullBusinessPartnerCreation.test.js`

**Interfaces:**
- Consumes: `resolveBusinessPartnerAndContactEmployees` (Tarea 5); `buildBpAddresses` (Tarea 4); `buildSapPropertiesFlags` (Tarea 3); `addContactEmployeesIfNeeded` (Tarea 9); `resolveBusinessPartnerCreationConfig` / `resolvePropertiesFlagsConfig` (Tarea 8).
- Produces: nada nuevo hacia otras tareas. La Tarea 11 consume `contactEmployeeResult.internalCodes`.

**Solo DOS archivos llevan el bloque de cableado**, aunque son tres los flujos afectados: `ProcessHubspotWebhookEvent.js` tiene su propia copia de la resolución del BP (Step 3), y `webhookQuotationSupport.js` sirve a la vez a cotizaciones y a inventory transfer request (Step 4). El tercer archivo, `ProcessHubspotInventoryTransferRequest.js`, solo tiene que pasar los arrays hacia el helper (Step 5). El código completo de los dos bloques está escrito abajo; no hay nada que deducir por analogía.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/application/processFullBusinessPartnerCreation.test.js`. Modela el use-case con dobles y verifica el cableado, no la lógica de dominio (que ya está probada en las tareas 3-7):

```js
import { jest } from '@jest/globals';
import { resolveBusinessPartnerAndContactEmployees }
  from '../../../src/domain/business-partners/contact-employee-source.service.js';
import { buildBpAddresses } from '../../../src/domain/business-partners/bp-addresses.service.js';
import { buildSapPropertiesFlags }
  from '../../../src/domain/business-partners/sap-properties-flags.service.js';
import { mapHubspotToSapFields } from '../../../src/domain/orders/order-builder.service.js';

// Reproduce el bloque de cableado que las tareas insertan en los tres
// use-cases, para poder probarlo de forma aislada.
function wireBusinessPartnerInputs({ company, contact, contactEmployees, bpAddress, mappings, creationConfig, propertiesConfig }) {
  const shape = resolveBusinessPartnerAndContactEmployees({
    company, contact, contactEmployees, source: creationConfig.contactEmployeeSource,
  });

  const mappedAddresses = bpAddress.map((entry) => mapHubspotToSapFields(entry, mappings.addressMappings));
  const { addresses } = buildBpAddresses({
    mappedAddresses,
    addressesConfig: creationConfig.addresses,
    addressDefaults: creationConfig.defaults.BPAddress,
  });

  const mappedContactEmployees = shape.contactEmployeeSources.map((source) => ({
    ...creationConfig.defaults.ContactEmployee,
    ...mapHubspotToSapFields(source, mappings.contactEmployeeMappings),
  }));

  const { flags } = buildSapPropertiesFlags({
    hubspotValue: shape.businessPartner?.[propertiesConfig.hubspotProperty],
    config: propertiesConfig,
  });

  return { shape, addresses, mappedContactEmployees, propertiesFlags: flags };
}

describe('cableado de la creacion completa del BusinessPartner', () => {
  const mappings = {
    addressMappings: [
      { sourceField: 'AddressName', targetField: 'nombre_direccion', isActive: true },
      { sourceField: 'Street', targetField: 'calle', isActive: true },
    ],
    contactEmployeeMappings: [
      { sourceField: 'Name', targetField: 'firstname', isActive: true },
    ],
  };

  const creationConfig = {
    payloadStrategy: 'fullMapped',
    contactEmployeeSource: 'payloadArray',
    defaults: { BusinessPartner: {}, ContactEmployee: { Active: 'tYES' }, BPAddress: { TaxCode: 'IVA' } },
    addresses: {
      strategy: 'payloadArray',
      byName: { factura: { AddressType: 'bo_BillTo' }, entrega: { AddressType: 'bo_ShipTo' } },
      required: ['factura', 'entrega'],
    },
  };

  const propertiesConfig = {
    strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 64, trueValue: 'tYES',
  };

  it('arma direcciones, contactos y banderas desde el payload', () => {
    const result = wireBusinessPartnerInputs({
      company: { hs_object_id: '1', name: 'ACME', groupname: '1;2;55' },
      contact: { hs_object_id: '2', firstname: 'Ignorado' },
      contactEmployees: [{ firstname: 'Ana' }, { firstname: 'Luis' }],
      bpAddress: [
        { nombre_direccion: 'factura', calle: 'Calle 1' },
        { nombre_direccion: 'entrega', calle: 'Calle 2' },
      ],
      mappings, creationConfig, propertiesConfig,
    });

    expect(result.shape.businessPartnerSource).toBe('company');
    expect(result.addresses).toEqual([
      { TaxCode: 'IVA', AddressType: 'bo_BillTo', AddressName: 'factura', Street: 'Calle 1' },
      { TaxCode: 'IVA', AddressType: 'bo_ShipTo', AddressName: 'entrega', Street: 'Calle 2' },
    ]);
    expect(result.mappedContactEmployees).toEqual([
      { Active: 'tYES', Name: 'Ana' },
      { Active: 'tYES', Name: 'Luis' },
    ]);
    expect(result.propertiesFlags).toEqual({
      Properties1: 'tYES', Properties2: 'tYES', Properties55: 'tYES',
    });
  });

  it('con la config por defecto no arma nada nuevo', () => {
    const legacyConfig = {
      payloadStrategy: 'legacyWhitelist',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    };

    const result = wireBusinessPartnerInputs({
      company: { hs_object_id: '1', name: 'ACME' },
      contact: { hs_object_id: '2', firstname: 'Juan' },
      contactEmployees: [],
      bpAddress: [],
      mappings,
      creationConfig: legacyConfig,
      propertiesConfig: { strategy: 'none', hubspotProperty: null, min: 1, max: 64, trueValue: 'tYES' },
    });

    expect(result.addresses).toEqual([]);
    expect(result.propertiesFlags).toEqual({});
    expect(result.shape.contactEmployeeSources).toHaveLength(1);
  });

  it('lanza cuando falta una direccion obligatoria', () => {
    expect(() => wireBusinessPartnerInputs({
      company: { hs_object_id: '1' },
      contact: null,
      contactEmployees: [{ firstname: 'Ana' }],
      bpAddress: [{ nombre_direccion: 'factura', calle: 'Calle 1' }],
      mappings, creationConfig, propertiesConfig,
    })).toThrow(/entrega/);
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/application/processFullBusinessPartnerCreation.test.js`
Expected: FAIL en el primer test — todavía no existe el cableado que reproduce, pero como el helper vive en el test, en realidad debería pasar si las tareas 3-7 están bien. **Si pasa desde el principio, está bien:** confirma que las piezas encajan. Sigue al Step 3.

- [ ] **Step 3: Cablea `ProcessHubspotWebhookEvent.js`**

Agrega los imports al inicio del archivo:

```js
import { resolveBusinessPartnerAndContactEmployees } from '#domain/business-partners/contact-employee-source.service.js';
import { buildBpAddresses } from '#domain/business-partners/bp-addresses.service.js';
import { buildSapPropertiesFlags } from '#domain/business-partners/sap-properties-flags.service.js';
import { BP_PAYLOAD_STRATEGIES } from '#domain/business-partners/business-partner-creation.constants.js';
```

Cambia la desestructuración de la línea 37 para incluir los arrays nuevos:

```js
    const { payload, deal, company, contact, lineItems, contactEmployees, bpAddress } = resolveEventPayload(event);
```

Reemplaza el bloque de las líneas 62-86 (desde `const mappedCompany = ...` hasta el cierre de `findOrCreateBusinessPartner`) por:

```js
      const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings);
      const mappedContact = mapHubspotToSapFields(contact || {}, mappings.contactBusinessPartnerMappings);
      // Resolved once per event (not a resolver-per-item like the others below) so
      // findOrCreateBusinessPartner/addContactEmployeeIfNeeded don't each trigger their own read.
      const upsertConfig = await this.runtimeRepository.resolveUpsertDataSap(tenantModels);
      const creationConfig = await this.runtimeRepository.resolveBusinessPartnerCreationConfig(tenantModels);
      const propertiesConfig = await this.runtimeRepository.resolvePropertiesFlagsConfig(tenantModels);

      const businessPartnerShape = resolveBusinessPartnerAndContactEmployees({
        company,
        contact,
        contactEmployees,
        source: creationConfig.contactEmployeeSource,
      });

      for (const warning of businessPartnerShape.warnings) {
        this.logger?.warn?.({ msg: 'BusinessPartner shape warning', ...warning });
      }

      // Cada entrada del array se mapea por separado, igual que line_items.
      const { addresses: bpAddresses, warnings: addressWarnings } = buildBpAddresses({
        mappedAddresses: bpAddress.map(
          (entry) => mapHubspotToSapFields(entry, mappings.addressMappings)
        ),
        addressesConfig: creationConfig.addresses,
        addressDefaults: creationConfig.defaults.BPAddress,
      });

      for (const warning of addressWarnings) {
        this.logger?.warn?.({ msg: 'BPAddresses warning', ...warning });
      }

      const mappedContactEmployees = businessPartnerShape.contactEmployeeSources.map((source) => ({
        ...creationConfig.defaults.ContactEmployee,
        ...mapHubspotToSapFields(source, mappings.contactEmployeeMappings),
      }));

      const { flags: propertiesFlags, invalid: invalidProperties } = buildSapPropertiesFlags({
        hubspotValue: propertiesConfig.hubspotProperty
          ? businessPartnerShape.businessPartner?.[propertiesConfig.hubspotProperty]
          : null,
        config: propertiesConfig,
      });

      if (invalidProperties.length > 0) {
        this.logger?.warn?.({ msg: 'PropertiesN values ignored', invalid: invalidProperties });
      }

      const payloadStrategy = this.businessPartnerPayloadStrategyFactory
        .getStrategy(creationConfig.payloadStrategy);

      const businessPartnerResult = await this.sapOrderAdapter.findOrCreateBusinessPartner({
        sapConfig,
        tenantModels,
        company,
        contact,
        mappedCompany,
        mappedContact,
        companyExists: businessPartnerShape.isCompanyBusinessPartner,
        resolveDefaultPriceListNum: (models) =>
          this.runtimeRepository.resolveDefaultPriceListNum(models),
        resolveRequireRandCardCode: (models) =>
          this.runtimeRepository.resolveRequireRandCardCode(models),
        resolveDefaultSeries: (models) =>
          this.runtimeRepository.resolveDefaultSeries(models),
        resolveDefaultFindSAP: (models) =>
          this.runtimeRepository.resolveDefaultFindSAP(models),
        resolveGroupCodeDefaults: (models) =>
          this.runtimeRepository.resolveGroupCodeDefaults(models),
        upsertConfig,
        payloadStrategy,
        bpAddresses,
        mappedContactEmployees,
        propertiesFlags,
        creationDefaults: creationConfig.defaults,
      });
```

Reemplaza el bloque de ContactEmployee de las líneas 134-143 por:

```js
      // Si la strategy ya mandó los ContactEmployees anidados en el POST, un
      // PATCH posterior los duplicaría. Si el BP ya existía, se reconcilian.
      const contactEmployeesWentInCreate = businessPartnerResult.created
        && payloadStrategy.includesContactEmployeesInCreate();

      if (!contactEmployeesWentInCreate && businessPartnerShape.contactEmployeeSources.length > 0) {
        contactEmployeeResult = await this.sapOrderAdapter.addContactEmployeesIfNeeded({
          sapConfig,
          cardCode,
          businessPartner: businessPartnerResult.businessPartner,
          contacts: businessPartnerShape.contactEmployeeSources,
          contactEmployeeMappings: mappings.contactEmployeeMappings,
          upsertConfig,
        });
      }
```

> `contactEmployeeResult` se inicializa en la línea 102 con `{ created: false, internalCode: null, ... }`. Agrégale `internalCodes: []` a ese inicializador para que la Tarea 11 pueda iterarlo siempre.

Ajusta el `if (contactEmployeeResult.internalCode)` de la línea 145: pasa a `if (contactEmployeeResult.internalCodes?.length > 0)`. La escritura real a HubSpot es la Tarea 11; por ahora deja el `persistReferences` como está, tomando el primer código:

```js
      if (contactEmployeeResult.internalCodes?.length > 0) {
        await this.webhookReferenceRepository.persistReferences({
          WebhookEvent,
          eventId: event?._id,
          payload,
          companyExists,
          contactExists,
          contactEmployeeCode: contactEmployeeResult.internalCodes[0].internalCode,
        });
      }
```

- [ ] **Step 4: Cablea `webhookQuotationSupport.js`**

`resolveBusinessPartnerForDocument` (líneas 112-230) es una función, no un método: recibe sus colaboradores como parámetros y `tenantModels` vive en `context.tenantModels`.

Agrega los mismos cuatro imports del Step 3 al inicio del archivo. Luego agrega cuatro parámetros al objeto que la función recibe (junto a `contactExists,` en la línea 123):

```js
  contactExists,
  contactEmployees = [],
  bpAddress = [],
  businessPartnerPayloadStrategyFactory,
  logger = console,
  context,
  auditTrail,
}) {
```

Reemplaza las líneas 127-148 (desde `const { mappings, sapConfig, hubspotCredentials } = context;` hasta el cierre de `findOrCreateBusinessPartner`) por:

```js
  const { mappings, sapConfig, hubspotCredentials } = context;
  const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings);
  const mappedContact = mapHubspotToSapFields(contact || {}, mappings.contactBusinessPartnerMappings);
  // Resolved once per event (not a resolver-per-item like the others below) so
  // findOrCreateBusinessPartner/addContactEmployeeIfNeeded don't each trigger their own read.
  const upsertConfig = await runtimeRepository.resolveUpsertDataSap(context.tenantModels);
  const creationConfig = await runtimeRepository
    .resolveBusinessPartnerCreationConfig(context.tenantModels);
  const propertiesConfig = await runtimeRepository
    .resolvePropertiesFlagsConfig(context.tenantModels);

  const businessPartnerShape = resolveBusinessPartnerAndContactEmployees({
    company,
    contact,
    contactEmployees,
    source: creationConfig.contactEmployeeSource,
  });

  for (const warning of businessPartnerShape.warnings) {
    logger?.warn?.({ msg: 'BusinessPartner shape warning', ...warning });
  }

  // Cada entrada del array se mapea por separado, igual que line_items.
  const { addresses: bpAddresses, warnings: addressWarnings } = buildBpAddresses({
    mappedAddresses: bpAddress.map(
      (entry) => mapHubspotToSapFields(entry, mappings.addressMappings)
    ),
    addressesConfig: creationConfig.addresses,
    addressDefaults: creationConfig.defaults.BPAddress,
  });

  for (const warning of addressWarnings) {
    logger?.warn?.({ msg: 'BPAddresses warning', ...warning });
  }

  const mappedContactEmployees = businessPartnerShape.contactEmployeeSources.map((source) => ({
    ...creationConfig.defaults.ContactEmployee,
    ...mapHubspotToSapFields(source, mappings.contactEmployeeMappings),
  }));

  const { flags: propertiesFlags, invalid: invalidProperties } = buildSapPropertiesFlags({
    hubspotValue: propertiesConfig.hubspotProperty
      ? businessPartnerShape.businessPartner?.[propertiesConfig.hubspotProperty]
      : null,
    config: propertiesConfig,
  });

  if (invalidProperties.length > 0) {
    logger?.warn?.({ msg: 'PropertiesN values ignored', invalid: invalidProperties });
  }

  const payloadStrategy = businessPartnerPayloadStrategyFactory
    .getStrategy(creationConfig.payloadStrategy);

  const businessPartnerResult = await sapOrderAdapter.findOrCreateBusinessPartner({
    sapConfig,
    tenantModels: context.tenantModels,
    company,
    contact,
    mappedCompany,
    mappedContact,
    companyExists: businessPartnerShape.isCompanyBusinessPartner,
    resolveDefaultPriceListNum: (models) => runtimeRepository.resolveDefaultPriceListNum(models),
    resolveRequireRandCardCode: (models) => runtimeRepository.resolveRequireRandCardCode(models),
    resolveDefaultSeries: (models) => runtimeRepository.resolveDefaultSeries(models),
    resolveDefaultFindSAP: (models) => runtimeRepository.resolveDefaultFindSAP(models),
    resolveGroupCodeDefaults: (models) => runtimeRepository.resolveGroupCodeDefaults(models),
    upsertConfig,
    payloadStrategy,
    bpAddresses,
    mappedContactEmployees,
    propertiesFlags,
    creationDefaults: creationConfig.defaults,
  });
```

Cambia el inicializador de `contactEmployeeResult` (líneas 165-170) para incluir `internalCodes`:

```js
  let contactEmployeeResult = {
    created: false,
    internalCode: null,
    internalCodes: [],
    requestPayload: null,
    responsePayload: null,
  };
```

Y reemplaza el bloque de las líneas 197-217 por:

```js
  // Si la strategy ya mandó los ContactEmployees anidados en el POST, un PATCH
  // posterior los duplicaría. Si el BP ya existía, se reconcilian.
  const contactEmployeesWentInCreate = businessPartnerResult.created
    && payloadStrategy.includesContactEmployeesInCreate();

  if (!contactEmployeesWentInCreate && businessPartnerShape.contactEmployeeSources.length > 0) {
    contactEmployeeResult = await sapOrderAdapter.addContactEmployeesIfNeeded({
      sapConfig,
      cardCode,
      businessPartner: businessPartnerResult.businessPartner,
      contacts: businessPartnerShape.contactEmployeeSources,
      contactEmployeeMappings: mappings.contactEmployeeMappings,
      upsertConfig,
    });
  }

  if (contactEmployeeResult.internalCodes?.length > 0) {
    await webhookReferenceRepository.persistReferences({
      WebhookEvent,
      eventId,
      payload,
      companyExists,
      contactExists,
      contactEmployeeCode: contactEmployeeResult.internalCodes[0].internalCode,
    });
  }
```

- [ ] **Step 5: Pasa los arrays desde los dos llamadores**

En `src/application/use-cases/ProcessHubspotCreateQuotation.js`, agrega `contactEmployees` y `bpAddress` a la desestructuración de `resolveEventPayload` (línea ~47) y pásalos a `resolveBusinessPartnerForDocument` (línea ~88). Haz lo mismo en `src/application/use-cases/ProcessHubspotInventoryTransferRequest.js` (líneas ~46 y ~87).

- [ ] **Step 6: Corre el test nuevo y luego la suite completa**

Run: `npm test -- tests/unit/application/processFullBusinessPartnerCreation.test.js`
Expected: PASS, 3 tests.

Run: `npm test`
Expected: sin fallos nuevos. Si `tests/unit/webhookProcessor.flow.test.js` o `tests/unit/application/processQuotationFlows.test.js` fallan por un `businessPartnerPayloadStrategyFactory` faltante, agrega el doble al constructor del use-case en el test — el cableado real es la Tarea 12.

- [ ] **Step 7: Commit**

```bash
git add src/application/use-cases/ProcessHubspotWebhookEvent.js src/application/use-cases/webhookQuotationSupport.js src/application/use-cases/ProcessHubspotCreateQuotation.js src/application/use-cases/ProcessHubspotInventoryTransferRequest.js tests/unit/application/processFullBusinessPartnerCreation.test.js
git commit -m "feat: wire full BusinessPartner creation into the deal webhook flows"
```

---

### Task 11: Write-back de `internalcode` a cada ContactEmployee real

Hoy `internalcode` se escribe al contact del deal (`HubspotWebhookAdapter.js:121-133`) y solo cuando hay company y contact. Con `payloadArray` ese contact puede no ser ContactEmployee, y escribirle el código dejaría un dato falso en HubSpot.

**Files:**
- Modify: `src/infrastructure/hubspot/HubspotWebhookAdapter.js:67-136`
- Modify: `src/application/services/webhook-payload.service.js:44-83`
- Test: `tests/unit/infrastructure/hubspotContactEmployeeWriteBack.test.js`

**Interfaces:**
- Consumes: `contactEmployeeResult.internalCodes` (Tarea 9/10), forma `[{ contact, internalCode }]`.
- Produces: `HubspotWebhookAdapter.updateContactEmployeeCodes({ token, internalCodes }) -> object[]`.

**Recordatorio:** la propiedad de HubSpot es `internalcode` en **minúsculas** (las propiedades de HubSpot siempre lo son). La llave `internalCode` en camelCase es la del snapshot guardado en `WebhookEvent`.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/hubspotContactEmployeeWriteBack.test.js`:

```js
import { jest } from '@jest/globals';

const updateContact = jest.fn();
jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  updateContact,
  updateCompany: jest.fn(),
  updateDeal: jest.fn(),
}));

const { HubspotWebhookAdapter } = await import('../../../src/infrastructure/hubspot/HubspotWebhookAdapter.js');

describe('updateContactEmployeeCodes', () => {
  beforeEach(() => { updateContact.mockReset(); updateContact.mockResolvedValue({ id: 'ok' }); });

  it('escribe internalcode en minusculas a cada contacto que fue ContactEmployee', async () => {
    const adapter = new HubspotWebhookAdapter();

    await adapter.updateContactEmployeeCodes({
      token: 'tok',
      internalCodes: [
        { contact: { hs_object_id: '10' }, internalCode: 11 },
        { contact: { hs_object_id: '20' }, internalCode: 12 },
      ],
    });

    expect(updateContact).toHaveBeenCalledTimes(2);
    expect(updateContact).toHaveBeenNthCalledWith(1, 'tok', '10', { properties: { internalcode: '11' } });
    expect(updateContact).toHaveBeenNthCalledWith(2, 'tok', '20', { properties: { internalcode: '12' } });
  });

  it('salta los contactos sin hs_object_id', async () => {
    const adapter = new HubspotWebhookAdapter();

    await adapter.updateContactEmployeeCodes({
      token: 'tok',
      internalCodes: [{ contact: {}, internalCode: 11 }],
    });

    expect(updateContact).not.toHaveBeenCalled();
  });

  it('no llama a HubSpot con una lista vacia', async () => {
    const adapter = new HubspotWebhookAdapter();

    expect(await adapter.updateContactEmployeeCodes({ token: 'tok', internalCodes: [] })).toEqual([]);
    expect(updateContact).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/hubspotContactEmployeeWriteBack.test.js`
Expected: FAIL — `adapter.updateContactEmployeeCodes is not a function`.

- [ ] **Step 3: Agrega el método al adapter**

En `src/infrastructure/hubspot/HubspotWebhookAdapter.js`, después de `updateAfterSap` (línea 136), agrega:

```js
  // Escribe el InternalCode de SAP en cada contacto de HubSpot que sí quedó
  // como ContactEmployee. Secuencial para no disparar el rate limit de
  // HubSpot con una empresa que tenga muchos contactos asociados.
  async updateContactEmployeeCodes({ token, internalCodes }) {
    const entries = Array.isArray(internalCodes) ? internalCodes : [];
    const responses = [];

    for (const entry of entries) {
      const contactObjectId = toNonEmptyString(entry?.contact?.hs_object_id);

      if (!contactObjectId || !entry?.internalCode) {
        continue;
      }

      responses.push(await hubspotClient.updateContact(token, contactObjectId, {
        // La propiedad de HubSpot es minúscula. No la confundas con la llave
        // internalCode del snapshot que se guarda en WebhookEvent.
        properties: { internalcode: String(entry.internalCode) },
      }));
    }

    return responses;
  }
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/infrastructure/hubspotContactEmployeeWriteBack.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Llama al método nuevo desde los use-cases**

En `ProcessHubspotWebhookEvent.js` y en `webhookQuotationSupport.js`, después del bloque de `addContactEmployeesIfNeeded`, agrega (obteniendo el token si aún no se resolvió):

```js
      if (contactEmployeeResult.internalCodes?.length > 0) {
        const tokenForContactEmployees = hubspotToken || await this.hubspotWebhookAdapter.getAccessToken({
          tenantModels,
          hubspotCredentials,
        });

        auditTrail.response_hubspot_contactEmployees = await this.hubspotWebhookAdapter
          .updateContactEmployeeCodes({
            token: tokenForContactEmployees,
            internalCodes: contactEmployeeResult.internalCodes,
          });
      }
```

En `webhookQuotationSupport.js` usa `hubspotWebhookAdapter` y `context.tenantModels` en vez de `this.` y `tenantModels`.

- [ ] **Step 6: Corre la suite completa**

Run: `npm test`
Expected: sin fallos nuevos. Con la config por defecto, `internalCodes` tiene a lo sumo un elemento (el contact del deal), así que el resultado observable no cambia.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/hubspot/HubspotWebhookAdapter.js src/application/use-cases/ProcessHubspotWebhookEvent.js src/application/use-cases/webhookQuotationSupport.js tests/unit/infrastructure/hubspotContactEmployeeWriteBack.test.js
git commit -m "feat: write SAP InternalCode back to every real ContactEmployee contact"
```

---

### Task 12: Cableado en composition

**Files:**
- Modify: `src/composition/webhook-processing.composition.js`
- Test: `tests/unit/composition/webhookProcessingComposition.test.js`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: los use-cases reciben `businessPartnerPayloadStrategyFactory` ya construido y validado contra el puerto.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/composition/webhookProcessingComposition.test.js`:

```js
import BusinessPartnerPayloadStrategyFactory
  from '../../../src/domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import FullMappedBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { BusinessPartnerPayloadStrategyPort }
  from '../../../src/application/ports/sap/business-partner-payload-strategy.port.js';
import { BP_PAYLOAD_STRATEGIES }
  from '../../../src/domain/business-partners/business-partner-creation.constants.js';

describe('cableado del factory de strategies de payload', () => {
  it('ambas strategies cumplen el puerto y el factory las resuelve', () => {
    const factory = new BusinessPartnerPayloadStrategyFactory({
      legacyStrategy: assertPort(
        new LegacyWhitelistBusinessPartnerPayloadStrategy(),
        BusinessPartnerPayloadStrategyPort
      ),
      fullMappedStrategy: assertPort(
        new FullMappedBusinessPartnerPayloadStrategy(),
        BusinessPartnerPayloadStrategyPort
      ),
    });

    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST).includesContactEmployeesInCreate())
      .toBe(false);
    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.FULL_MAPPED).includesContactEmployeesInCreate())
      .toBe(true);
  });
});
```

- [ ] **Step 2: Corre el test**

Run: `npm test -- tests/unit/composition/webhookProcessingComposition.test.js`
Expected: PASS (todas las piezas existen desde la Tarea 7). Este test es la red de seguridad de que el cableado que vas a escribir es válido.

- [ ] **Step 3: Cablea el factory en la composition**

En `src/composition/webhook-processing.composition.js`, agrega los imports y construye el factory siguiendo el patrón de `src/composition/sap-sync.composition.js:69-97`:

```js
import BusinessPartnerPayloadStrategyFactory from '#domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import FullMappedBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { BusinessPartnerPayloadStrategyPort } from '#application/ports/sap/business-partner-payload-strategy.port.js';
import { assertPort } from '#application/ports/port-validator.js';
```

y dentro de la función que arma los use-cases:

```js
const businessPartnerPayloadStrategyFactory = new BusinessPartnerPayloadStrategyFactory({
  legacyStrategy: assertPort(
    new LegacyWhitelistBusinessPartnerPayloadStrategy(),
    BusinessPartnerPayloadStrategyPort
  ),
  fullMappedStrategy: assertPort(
    new FullMappedBusinessPartnerPayloadStrategy(),
    BusinessPartnerPayloadStrategyPort
  ),
  logger,
});
```

Pásalo a `ProcessHubspotWebhookEvent`, `ProcessHubspotCreateQuotation` y `ProcessHubspotInventoryTransferRequest` como `businessPartnerPayloadStrategyFactory`, y asígnalo en sus constructores (`this.businessPartnerPayloadStrategyFactory = businessPartnerPayloadStrategyFactory;`).

- [ ] **Step 4: Corre la suite completa**

Run: `npm test`
Expected: sin fallos nuevos.

- [ ] **Step 5: Commit**

```bash
git add src/composition/webhook-processing.composition.js src/application/use-cases/ProcessHubspotWebhookEvent.js src/application/use-cases/ProcessHubspotCreateQuotation.js src/application/use-cases/ProcessHubspotInventoryTransferRequest.js tests/unit/composition/webhookProcessingComposition.test.js
git commit -m "feat: wire BusinessPartner payload strategy factory in composition"
```

---

### Task 13: Semilla de provisioning y catálogo de configuraciones

**Files:**
- Modify: `src/infrastructure/tenants/tenantProvisioning.js:83-157`
- Modify: `configuration_examples.md`
- Test: `tests/unit/infrastructure/tenantProvisioningBpKeys.test.js`

**Interfaces:**
- Consumes: `BUSINESS_PARTNER_CREATION_CONFIG_KEY`, `PROPERTIES_FLAGS_CONFIG_KEY` (Tarea 2).
- Produces: nada.

La siembra vive en `ensureTenantConfigurations` (`tenantProvisioning.js:83-158`), que hace un `Configuration.updateOne` con `$setOnInsert` + `{ upsert: true }` por clave — idempotente, y nunca sobreescribe lo que un tenant ya configuró.

- [ ] **Step 1: Escribe el test que falla**

Crea `tests/unit/infrastructure/tenantProvisioningBpKeys.test.js`:

```js
import { jest } from '@jest/globals';
import { ensureTenantConfigurations } from '../../../src/infrastructure/tenants/tenantProvisioning.js';
import { BUSINESS_PARTNER_CREATION_CONFIG_KEY, PROPERTIES_FLAGS_CONFIG_KEY }
  from '../../../src/domain/business-partners/business-partner-creation.constants.js';

describe('ensureTenantConfigurations — claves del BusinessPartner', () => {
  it('siembra businessPartnerCreation apagada, con upsert e idempotente', async () => {
    const updateOne = jest.fn().mockResolvedValue({});

    await ensureTenantConfigurations({ Configuration: { updateOne } });

    const call = updateOne.mock.calls.find(
      ([filter]) => filter.key === BUSINESS_PARTNER_CREATION_CONFIG_KEY
    );

    expect(call).toBeDefined();
    expect(call[1].$setOnInsert.value).toEqual({
      payloadStrategy: 'legacyWhitelist',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    });
    expect(call[1].$setOnInsert.userUpdated).toBe('admin');
    expect(call[2]).toEqual({ upsert: true });
  });

  it('siembra propertiesFlags apagada', async () => {
    const updateOne = jest.fn().mockResolvedValue({});

    await ensureTenantConfigurations({ Configuration: { updateOne } });

    const call = updateOne.mock.calls.find(
      ([filter]) => filter.key === PROPERTIES_FLAGS_CONFIG_KEY
    );

    expect(call).toBeDefined();
    expect(call[1].$setOnInsert.value).toEqual({
      strategy: 'none',
      hubspotProperty: null,
      min: 1,
      max: 64,
      trueValue: 'tYES',
    });
  });
});
```

> Si `ensureTenantConfigurations` no está exportada, expórtala (`export async function ensureTenantConfigurations`) sin quitar el `export` que ya tenga la función pública del módulo.

- [ ] **Step 2: Corre el test y verifica que falla**

Run: `npm test -- tests/unit/infrastructure/tenantProvisioningBpKeys.test.js`
Expected: FAIL — `call` es `undefined` en ambos tests.

- [ ] **Step 3: Siembra las dos claves apagadas**

Agrega los imports al inicio de `src/infrastructure/tenants/tenantProvisioning.js`:

```js
import {
  BUSINESS_PARTNER_CREATION_CONFIG_KEY,
  PROPERTIES_FLAGS_CONFIG_KEY,
} from '#domain/business-partners/business-partner-creation.constants.js';
```

Y dentro de `ensureTenantConfigurations`, después del bloque de `UPSERT_DATA_SAP_CONFIG_KEY` (que cierra en la línea 157), agrega:

```js
  // Sembradas apagadas (legacyWhitelist / none) para que el documento sea
  // visible en el admin sin cambiar la conducta de ningún tenant. Un cliente
  // las activa cambiando payloadStrategy y llenando addresses.byName.
  await Configuration.updateOne(
    { key: BUSINESS_PARTNER_CREATION_CONFIG_KEY },
    {
      $setOnInsert: {
        key: BUSINESS_PARTNER_CREATION_CONFIG_KEY,
        userUpdated: 'admin',
        value: {
          payloadStrategy: 'legacyWhitelist',
          contactEmployeeSource: 'dealContact',
          defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
          addresses: { strategy: 'none', byName: {}, required: [] },
        },
      },
    },
    { upsert: true }
  );
  await Configuration.updateOne(
    { key: PROPERTIES_FLAGS_CONFIG_KEY },
    {
      $setOnInsert: {
        key: PROPERTIES_FLAGS_CONFIG_KEY,
        userUpdated: 'admin',
        value: {
          strategy: 'none',
          hubspotProperty: null,
          min: 1,
          max: 64,
          trueValue: 'tYES',
        },
      },
    },
    { upsert: true }
  );
```

- [ ] **Step 4: Corre el test y verifica que pasa**

Run: `npm test -- tests/unit/infrastructure/tenantProvisioningBpKeys.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Documenta las dos claves en el catálogo**

Agrega al final de `configuration_examples.md`, siguiendo el formato del archivo (etiqueta `Detalle:` + prosa en español + el documento literal en una línea de objeto JS):

```markdown
Detalle: businessPartnerCreation
Controla cómo se arma el payload de creación del BusinessPartner en SAP B1 desde un webhook de deal. `payloadStrategy: 'legacyWhitelist'` (el default) manda los nueve campos históricos; `'fullMapped'` manda todo lo que esté mapeado más los defaults, las direcciones y los contactos. `contactEmployeeSource: 'dealContact'` (default) toma el contact del deal como ContactEmployee; `'payloadArray'` toma `payload.contactEmployees` que envía el workflow de HubSpot e ignora el contact del deal. En `addresses`, las llaves de `byName` se comparan contra el `AddressName` de cada entrada de `payload.bpAddress` normalizado a minúsculas sin espacios, y aportan los valores fijos (`AddressType`, `Country`); el valor que venga del payload siempre gana sobre la config. `required` lista los `AddressName` obligatorios: si falta alguno, el webhook falla antes de escribir en SAP (vacío o ausente = no valida). `defaults.BPAddress` aplica a todas las direcciones. Solo aplica a SAP B1.
{ key: 'businessPartnerCreation', value: { payloadStrategy: 'fullMapped', contactEmployeeSource: 'payloadArray', defaults: { BusinessPartner: { CardType: 'cCustomer', PayTermsGrpCode: 13, Series: 59, PriceListNum: 1 }, ContactEmployee: { Active: 'tYES' }, BPAddress: { TaxCode: 'IVA' } }, addresses: { strategy: 'payloadArray', byName: { factura: { AddressType: 'bo_BillTo', Country: 'GT' }, entrega: { AddressType: 'bo_ShipTo', Country: 'GT' } }, required: ['factura', 'entrega'] } } }

Detalle: propertiesFlags
SAP B1 expone 64 campos booleanos `Properties1` .. `Properties64`. Esta clave los conecta con UNA propiedad multi-select de HubSpot cuyos valores internos son los números 1..64: si el cliente tiene seleccionados 1, 2 y 55, se envían `Properties1`, `Properties2` y `Properties55` en `tYES` y las demás se omiten. En sentido inverso (SAP → HubSpot) se seleccionan en la lista las que estén en `tYES`. No puede expresarse como FieldMapping porque es una propiedad de HubSpot hacia N campos de SAP. `strategy: 'none'` (o la clave ausente) lo deja apagado, que es lo que necesitan los tenants que no usan estos campos. Los valores no numéricos o fuera de `[min, max]` se ignoran con un warning y nunca tumban el webhook.
{ key: 'propertiesFlags', value: { strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 64, trueValue: 'tYES' } }
```

- [ ] **Step 6: Corre la suite completa**

Run: `npm test`
Expected: sin fallos nuevos.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/tenants/tenantProvisioning.js configuration_examples.md tests/unit/infrastructure/tenantProvisioningBpKeys.test.js
git commit -m "docs: seed and document businessPartnerCreation and propertiesFlags configs"
```

---

## Verificación final

- [ ] **Corre la suite completa y compara contra la línea base**

Run: `npm test`

Antes de declarar el trabajo terminado, compara el número de tests que pasan y fallan contra el estado de `main` antes de la Tarea 1. Este proyecto tiene fallos de línea base conocidos; el criterio es **ningún fallo nuevo**, no "cero fallos". Si aparece un fallo nuevo, arréglalo antes de continuar — no lo declares preexistente sin haber verificado que ya fallaba antes.

- [ ] **Verifica la guardia de regresión explícitamente**

Run: `npm test -- tests/unit/domain/businessPartnerPayloadStrategies.test.js tests/unit/domain/fullMappedBpPayload.test.js`

El test "reproduce el payload historico" y el test "produce el payload objetivo del cliente" son los dos extremos del trabajo. Si ambos pasan, la funcionalidad está completa y ningún tenant existente cambió de conducta.

- [ ] **Prueba manual en el tenant de pruebas**

El flujo de prueba manual de este proyecto es `POST /sap-sync/run` con solo una config activa, pero eso cubre la dirección SAP → HubSpot. Para esta funcionalidad, que es HubSpot → SAP, dispara un webhook de deal real contra el endpoint de `src/interfaces/http/routes/webhook.routes.js` con un payload que incluya `contactEmployees` y `bpAddress`, y revisa el documento de `WebhookEvent` resultante: `payload_SAP.businessPartner` debe contener el payload completo con `BPAddresses` y `ContactEmployees` anidados.

## Pendientes que este plan NO cubre

- La dirección SAP → HubSpot (spec hermano). `readSapPropertiesFlags` y `listSapPropertiesFieldNames` ya están implementados y probados para ese trabajo.
- Actualizar direcciones o `PropertiesN` de un BusinessPartner que ya existe en SAP.
- S/4 HANA.
- Unificar la duplicación entre `ProcessHubspotWebhookEvent.js` y `webhookQuotationSupport.js`.
- Configurar el workflow de HubSpot para que envíe `contactEmployees` y `bpAddress`. **Sin esto, la funcionalidad no tiene datos de entrada.** Es trabajo manual en HubSpot, no en el código.
