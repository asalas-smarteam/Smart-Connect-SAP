# Crear ofertas de venta en S/4HANA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un tenant `sapFlavor: "S4"` cree ofertas de venta en S/4HANA por el webhook `POST /webhooks/hubspot/createQuotation`, sin que el camino de los cuatro tenants B1 cambie ni un byte de payload.

**Architecture:** Tres puertos nuevos (resolver de cliente, builder de documento, adapter de envío) resueltos por una sola factory según el `sapFlavor` del tenant. El caso de uso `ProcessHubspotCreateQuotation` conserva intactas su idempotencia, su persistencia en `SapDocumentLink`, su audit trail y su write-back a HubSpot: el adapter de S/4 devuelve una respuesta **con forma de B1** (`{ DocEntry, DocNum, DocumentLines[].LineNum, raw }`) para que nada río abajo se entere del flavor.

**Tech Stack:** Node 24 ESM, Fastify, Mongoose, axios, Jest (`@jest/globals`), OData v2 sobre SAP Gateway.

**Spec:** [docs/superpowers/specs/2026-09-14-s4-create-quotation-design.md](../specs/2026-09-14-s4-create-quotation-design.md)

> **Corrección posterior a la ejecución (2026-09-14).** Este plan usa
> `to_Customer.BPTaxLongNumber` como ejemplo de ruta fiscal. **Ese campo no existe**: el gateway
> responde 404 para ese segmento. La ruta real es `to_BusinessPartnerTax.BPTaxLongNumber`, y es
> una colección (un socio de negocio trae una fila por tipo de impuesto). En los bloques de test
> del plan la cadena es solo un dato de prueba y da igual cuál se use; donde importa es en la
> configuración que se le entrega al cliente, ya corregida en el spec y en
> `configuration_examples.md`.

## Global Constraints

- **NO se hace `git add`, `git commit`, `git merge` ni `git push`.** Cada tarea termina dejando el cambio en el working tree y reportando en el chat qué se cambió, en qué archivos y por qué. El commit lo hace el usuario. Comandos de git de solo lectura (`status`, `diff`, `log`) sí.
- **Se trabaja en `main`, en el checkout principal.** Nada de ramas ni worktrees.
- **Comando de tests:** `node --experimental-vm-modules node_modules/jest/bin/jest.js <ruta>`. **`npm test` NO funciona** en este Windows: el script es `NODE_OPTIONS=--experimental-vm-modules jest` y npm lo lanza con `cmd.exe`, donde ese prefijo no es sintaxis válida.
- **Baseline de la suite completa: 178 suites, 5 rojas preexistentes.** Una tarea está bien si no suma rojas nuevas; no hay que arreglar las 5 viejas.
- **Imports en `src/`** usan los alias de `package.json`: `#domain/*`, `#application/*`, `#infrastructure/*`, `#shared/*`, `#composition/*`. **Los tests usan rutas relativas** (`../../../src/...`), que es la convención vigente del repo.
- **Los comentarios explican el porqué, no el qué**, en español, al nivel de densidad del código vecino. Un comentario que solo repite la línea siguiente sobra.
- **`PermanentWebhookError`** (desde `#shared/errors/index.js`) = no reintentar. Cualquier otro error = reintentable. Un dato de configuración faltante que no se arregla solo va como permanente.
- **Nada de valores de SAP hardcodeados en código.** Sociedad, cuenta de reconciliación, moneda, clase de oferta y función de interlocutor salen de configuración. La única excepción documentada es el default `ZC01` de `BusinessPartnerGrouping`, que sale de un ClientConfig real del tenant.

---

## Estructura de archivos

**Nuevos:**

| Archivo | Responsabilidad |
|---|---|
| `src/domain/sap/s4-odata-payload.service.js` | Expandir claves punteadas planas a objetos/colecciones OData |
| `src/infrastructure/config/S4SalesDocumentConfigRepository.js` | Leer y normalizar `s4SalesDocument` y `s4BusinessPartnerCreation` |
| `src/domain/orders/s4-sales-document-builder.service.js` | Armar el payload de `A_SalesQuotation` |
| `src/domain/business-partners/s4-business-partner-payload.service.js` | Armar el deep create de `A_BusinessPartner` |
| `src/application/ports/sap/sap-sales-document.port.js` | Puerto del adapter de envío |
| `src/application/ports/sap/sales-document-builder.port.js` | Puerto del builder |
| `src/application/ports/sap/sap-document-business-partner.port.js` | Puerto del resolver de cliente |
| `src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js` | Adapter B1 (delega en el de hoy) |
| `src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js` | Adapter S/4 + normalización a forma B1 |
| `src/infrastructure/sap/salesDocuments/recordedS4Transport.js` | Envolver el transporte S/4 con el grabador de auditoría |
| `src/infrastructure/sap/salesDocuments/salesDocumentStrategyFactory.js` | Devolver el trío coherente según flavor |
| `src/application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js` | Delegación pura al resolver B1 actual |
| `src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js` | Buscar/crear cliente en S/4 |
| `scripts/verify-s4-sales-quotation.mjs` | Verificación en vivo (Tarea 0) |

**Modificados:**

| Archivo | Cambio |
|---|---|
| `src/application/use-cases/ProcessHubspotCreateQuotation.js` | Inyectar la strategy factory; construir el trío tras resolver el contexto |
| `src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js` | Exponer `sapFlavor` en el contexto |
| `src/composition/webhook-processing.composition.js` | Cablear la factory real |

**Tests nuevos:** uno por módulo, en `tests/unit/domain/`, `tests/unit/infrastructure/` y `tests/unit/application/`, siguiendo la ubicación del módulo que prueban.

---

## Task 0: Script de verificación en vivo contra S/4

**Bloquea las tareas 3, 4, 5 y 6 en cuanto a nombres de campo.** Las tareas 1 y 2 no dependen de él y pueden arrancar en paralelo.

**Al momento de escribir este plan no hay red:** la ruta VPN a `172.23.0.0/22` existe pero `172.23.2.28:44300` da TCP timeout. El script se escribe igual y se corre apenas vuelva la conexión. Si al ejecutar el plan sigue sin red, **anotar el resultado como "no verificado" y seguir**: las tareas 1–7 se pueden completar contra las suposiciones del spec, y la corrección de nombres es un cambio de constantes, no de arquitectura.

**Files:**
- Create: `scripts/verify-s4-sales-quotation.mjs`

**Interfaces:**
- Consumes: nada.
- Produces: un reporte por consola. Ningún módulo de producción lo importa.

- [ ] **Step 1: Escribir el script**

```js
// scripts/verify-s4-sales-quotation.mjs
//
// Verificación en vivo de los supuestos del spec 2026-09-14-s4-create-quotation-design.md.
// No escribe nada en SAP salvo en el paso 3, que está apagado por defecto: correrlo con
// CREATE=1 solo cuando se quiera intentar el POST de prueba.
//
//   node scripts/verify-s4-sales-quotation.mjs
//   CREATE=1 SOLD_TO=100053 MATERIAL=1001 node scripts/verify-s4-sales-quotation.mjs
import { MongoClient } from 'mongodb';
import axios from 'axios';
import https from 'https';

const MONGO_URI = process.env.LOCAL_MONGO_URI || 'mongodb://localhost:27017';
const TENANT_DB = process.env.TENANT_DB || 'sap_integration_multiquimica';
const agent = new https.Agent({ rejectUnauthorized: false });

async function loadCredentials() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const credentials = await client.db(TENANT_DB).collection('SapCredentials').findOne({});
  await client.close();

  if (!credentials?.serviceLayerBaseUrl) {
    throw new Error(`Sin SapCredentials en ${TENANT_DB}`);
  }

  return {
    base: String(credentials.serviceLayerBaseUrl).replace(/\/+$/, ''),
    auth: {
      username: credentials.serviceLayerUsername,
      password: credentials.serviceLayerPassword,
    },
  };
}

async function get({ base, auth }, path, params = {}) {
  try {
    const response = await axios.get(`${base}${path}`, {
      auth, httpsAgent: agent, timeout: 40000, params: { $format: 'json', ...params },
    });
    return { status: response.status, data: response.data, headers: response.headers };
  } catch (error) {
    return { status: error?.response?.status ?? 'ERR', data: error?.response?.data ?? error.message };
  }
}

// El gateway exige token CSRF + su cookie para cualquier escritura. Se piden contra el
// documento de servicio, igual que hace S4GatewayTransport.
async function fetchCsrf({ base, auth }, servicePath) {
  const response = await axios.get(`${base}${servicePath}/`, {
    auth, httpsAgent: agent, timeout: 40000, headers: { 'x-csrf-token': 'Fetch' },
  });
  return {
    token: response.headers['x-csrf-token'],
    cookie: (response.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; '),
  };
}

const QUOTATION_SERVICE = '/sap/opu/odata/sap/API_SALES_QUOTATION_SRV';

async function main() {
  const creds = await loadCredentials();
  console.log('Base:', creds.base, '\n');

  // 1. ¿El servicio de ofertas está activado?
  const metadata = await get(creds, `${QUOTATION_SERVICE}/$metadata`);
  console.log('1) API_SALES_QUOTATION_SRV $metadata =>', metadata.status);

  if (metadata.status === 403) {
    // Este sistema registra las activaciones con ID prefijado Z; el Title trae el nombre real.
    const catalog = await get(
      creds,
      '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection',
      { $select: 'ID,Title', $top: 2000 }
    );
    const rows = catalog.data?.d?.results ?? [];
    const matches = rows.filter((row) => /QUOTATION|SALES_ORDER/i.test(`${row.ID} ${row.Title}`));
    console.log('   Candidatos en el catálogo:', JSON.stringify(matches, null, 1));
  }

  // 2. Nombres reales de campo, de una oferta existente con sus posiciones e interlocutores.
  const sample = await get(creds, `${QUOTATION_SERVICE}/A_SalesQuotation`, {
    $top: 1, $expand: 'to_Item,to_Partner',
  });
  console.log('2) Oferta de muestra =>', sample.status);
  const first = sample.data?.d?.results?.[0];
  if (first) {
    console.log('   Campos de cabecera:', Object.keys(first).sort().join(', '));
    console.log('   Campos de posición:', Object.keys(first.to_Item?.results?.[0] ?? {}).sort().join(', '));
    console.log('   Interlocutores:', JSON.stringify(first.to_Partner?.results ?? [], null, 1));
  }

  // 3. ¿El deep create con to_Item pasa? Apagado salvo CREATE=1.
  if (process.env.CREATE === '1') {
    const { token, cookie } = await fetchCsrf(creds, QUOTATION_SERVICE);
    const body = {
      SalesQuotationType: process.env.QUOTATION_TYPE,
      SalesOrganization: process.env.SALES_ORG,
      DistributionChannel: process.env.DISTRIBUTION_CHANNEL,
      OrganizationDivision: process.env.DIVISION,
      SoldToParty: process.env.SOLD_TO,
      to_Item: [{
        SalesQuotationItem: '000010',
        Material: process.env.MATERIAL,
        RequestedQuantity: '1',
      }],
    };
    console.log('3) POST de prueba:', JSON.stringify(body));
    try {
      const created = await axios.post(`${creds.base}${QUOTATION_SERVICE}/A_SalesQuotation`, body, {
        auth: creds.auth, httpsAgent: agent, timeout: 60000,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token, Cookie: cookie },
      });
      console.log('   OK =>', created.status, JSON.stringify(created.data?.d ?? created.data).slice(0, 500));
    } catch (error) {
      console.log('   FALLÓ =>', error?.response?.status, JSON.stringify(error?.response?.data ?? error.message).slice(0, 1500));
    }
  } else {
    console.log('3) POST de prueba omitido (correr con CREATE=1 para intentarlo)');
  }

  // 4. ¿Se puede crear un BusinessPartner con to_Customer? Solo se lee el $metadata para ver
  //    si la navegación to_Customer es creatable; el POST real se intenta a mano después.
  const bpMetadata = await get(creds, '/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata');
  console.log('4) API_BUSINESS_PARTNER $metadata =>', bpMetadata.status);

  // 5. Muestra de cliente con su área de ventas, para leer los valores reales de
  //    SalesOrganization / DistributionChannel / Division / PriceListType del sistema.
  const customer = await get(creds, '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_CustomerSalesArea', { $top: 5 });
  console.log('5) Áreas de venta de muestra =>', customer.status);
  console.log('  ', JSON.stringify(customer.data?.d?.results ?? [], null, 1).slice(0, 1200));
}

main().catch((error) => {
  console.error('FALLÓ:', error.message);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Correrlo**

Run: `node scripts/verify-s4-sales-quotation.mjs`

Esperado si hay red: cinco bloques numerados con status HTTP. Esperado si no hay red:
`FALLÓ: connect ETIMEDOUT 172.23.2.28:44300`.

- [ ] **Step 3: Anotar el resultado**

Escribir en el chat, textual, el status de cada uno de los 5 puntos y —si el punto 2 devolvió
datos— la lista de campos de cabecera y posición. Si algún nombre de campo del spec no existe
en `$metadata`, decirlo ahí: eso corrige constantes en las tareas 3 y 4, nada más.

- [ ] **Step 4: Dejar el cambio en el working tree y reportar**

No commitear. Reportar: archivo creado y resultado de la verificación.

---

## Task 1: Expansión de claves punteadas a OData

`mapHubspotToSapFields` escribe `mapped[sourceField] = value` con el `sourceField` literal
([order-builder.service.js:44](../../../src/domain/orders/order-builder.service.js)), así que
un mapeo `to_Customer.BPTaxLongNumber → cedula` produce la clave **plana con punto**
`'to_Customer.BPTaxLongNumber'`. El gateway rechaza eso: OData espera objetos anidados.

**Files:**
- Create: `src/domain/sap/s4-odata-payload.service.js`
- Test: `tests/unit/domain/s4ODataPayload.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `S4_NAVIGATION_CARDINALITY: Readonly<Record<string, 'collection' | 'single'>>`
  - `expandS4ODataKeys(flatFields: object, options?: { logger?: object }) -> object`

- [ ] **Step 1: Escribir el test que falla**

```js
// tests/unit/domain/s4ODataPayload.test.js
import { jest } from '@jest/globals';
import {
  S4_NAVIGATION_CARDINALITY,
  expandS4ODataKeys,
} from '../../../src/domain/sap/s4-odata-payload.service.js';

describe('expandS4ODataKeys', () => {
  it('deja intactas las claves sin punto', () => {
    expect(expandS4ODataKeys({ SoldToParty: '100053', OrganizationBPName1: 'ACME' })).toEqual({
      SoldToParty: '100053',
      OrganizationBPName1: 'ACME',
    });
  });

  it('anida una navegación 1:1 como objeto', () => {
    expect(expandS4ODataKeys({ 'to_Customer.BPTaxLongNumber': '3101' })).toEqual({
      to_Customer: { BPTaxLongNumber: '3101' },
    });
  });

  it('anida una navegación de colección como array de un elemento', () => {
    expect(expandS4ODataKeys({ 'to_BusinessPartnerAddress.CityName': 'San José' })).toEqual({
      to_BusinessPartnerAddress: [{ CityName: 'San José' }],
    });
  });

  // Dos mapeos que apuntan a la misma dirección tienen que caer en la MISMA fila, no en dos.
  // Sin esto, el gateway crearía dos direcciones, cada una a medio llenar.
  it('fusiona claves hermanas en el mismo elemento de la colección', () => {
    expect(expandS4ODataKeys({
      'to_BusinessPartnerAddress.CityName': 'San José',
      'to_BusinessPartnerAddress.Country': 'CR',
    })).toEqual({
      to_BusinessPartnerAddress: [{ CityName: 'San José', Country: 'CR' }],
    });
  });

  it('anida colecciones dentro de colecciones', () => {
    expect(expandS4ODataKeys({
      'to_BusinessPartnerAddress.CityName': 'San José',
      'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress': 'a@b.com',
      'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber': '22223333',
    })).toEqual({
      to_BusinessPartnerAddress: [{
        CityName: 'San José',
        to_EmailAddress: [{ EmailAddress: 'a@b.com' }],
        to_PhoneNumber: [{ PhoneNumber: '22223333' }],
      }],
    });
  });

  it('anida una colección dentro de una navegación 1:1', () => {
    expect(expandS4ODataKeys({
      'to_Customer.to_CustomerSalesArea.PriceListType': 'ZC',
      'to_Customer.CustomerAccountGroup': 'ZC01',
    })).toEqual({
      to_Customer: {
        CustomerAccountGroup: 'ZC01',
        to_CustomerSalesArea: [{ PriceListType: 'ZC' }],
      },
    });
  });

  // Adivinar la cardinalidad de una navegación desconocida hace que el gateway rechace el
  // POST ENTERO, y el síntoma no apunta al mapeo. Descartarla con warn deja el resto viable.
  it('descarta con warn una navegación que no está en la tabla de cardinalidad', () => {
    const logger = { warn: jest.fn() };

    expect(expandS4ODataKeys({ 'to_Inventado.Campo': 'x', SoldToParty: '1' }, { logger })).toEqual({
      SoldToParty: '1',
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      navigation: 'to_Inventado',
      field: 'to_Inventado.Campo',
    }));
  });

  it('tolera entrada nula y no revienta sin logger', () => {
    expect(expandS4ODataKeys(null)).toEqual({});
    expect(expandS4ODataKeys({ 'to_Inventado.Campo': 'x' })).toEqual({});
  });

  it('declara la cardinalidad de las diez navegaciones del spec', () => {
    expect(S4_NAVIGATION_CARDINALITY).toMatchObject({
      to_BusinessPartnerAddress: 'collection',
      'to_BusinessPartnerAddress.to_EmailAddress': 'collection',
      'to_BusinessPartnerAddress.to_PhoneNumber': 'collection',
      to_BusinessPartnerRole: 'collection',
      to_Customer: 'single',
      'to_Customer.to_CustomerCompany': 'collection',
      'to_Customer.to_CustomerSalesArea': 'collection',
      to_Item: 'collection',
      to_Partner: 'collection',
      to_PricingElement: 'collection',
    });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/domain/s4ODataPayload.test.js`

Esperado: FAIL, `Cannot find module '.../s4-odata-payload.service.js'`.

- [ ] **Step 3: Implementar**

```js
// src/domain/sap/s4-odata-payload.service.js

// Cardinalidad de cada navegación de OData que este proyecto sabe escribir. Es una tabla
// EXPLÍCITA a propósito: el nombre no dice si la navegación es 1:1 o colección, y mandarla
// con la forma equivocada hace que el gateway rechace el POST completo, con un mensaje que
// no menciona el mapeo que lo causó. Una navegación que no esté acá se descarta.
export const S4_NAVIGATION_CARDINALITY = Object.freeze({
  to_BusinessPartnerAddress: 'collection',
  'to_BusinessPartnerAddress.to_EmailAddress': 'collection',
  'to_BusinessPartnerAddress.to_PhoneNumber': 'collection',
  to_BusinessPartnerRole: 'collection',
  to_Customer: 'single',
  'to_Customer.to_CustomerCompany': 'collection',
  'to_Customer.to_CustomerSalesArea': 'collection',
  to_Item: 'collection',
  to_Partner: 'collection',
  to_PricingElement: 'collection',
});

// Devuelve el contenedor donde hay que escribir la hoja, creándolo si hace falta. En una
// colección siempre se usa el PRIMER elemento: dos mapeos hacia la misma dirección son dos
// campos de la misma fila, no dos filas a medio llenar.
function resolveContainer(root, navigationSegments) {
  let container = root;
  let path = '';

  for (const segment of navigationSegments) {
    path = path ? `${path}.${segment}` : segment;
    const cardinality = S4_NAVIGATION_CARDINALITY[path];

    if (!cardinality) {
      return { container: null, navigation: path };
    }

    if (cardinality === 'collection') {
      if (!Array.isArray(container[segment])) {
        container[segment] = [{}];
      }
      container = container[segment][0];
    } else {
      if (!container[segment] || typeof container[segment] !== 'object') {
        container[segment] = {};
      }
      container = container[segment];
    }
  }

  return { container, navigation: null };
}

// `{'to_Customer.BPTaxLongNumber': '3101'}` -> `{to_Customer: {BPTaxLongNumber: '3101'}}`.
// Las claves sin punto se copian tal cual.
export function expandS4ODataKeys(flatFields, { logger = null } = {}) {
  const expanded = {};

  for (const [field, value] of Object.entries(flatFields || {})) {
    const segments = field.split('.');

    if (segments.length === 1) {
      expanded[field] = value;
      continue;
    }

    const leaf = segments[segments.length - 1];
    const { container, navigation } = resolveContainer(expanded, segments.slice(0, -1));

    if (!container) {
      logger?.warn?.({
        msg: 'Campo descartado: navegación de OData desconocida, no se adivina su cardinalidad',
        field,
        navigation,
      });
      continue;
    }

    container[leaf] = value;
  }

  return expanded;
}

export default { S4_NAVIGATION_CARDINALITY, expandS4ODataKeys };
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/domain/s4ODataPayload.test.js`

Esperado: PASS, 9 tests.

- [ ] **Step 5: Dejar el cambio en el working tree y reportar**

No commitear. Reportar archivos creados y el conteo de tests.

---

## Task 2: Repositorio de configuración de S/4

**Files:**
- Create: `src/infrastructure/config/S4SalesDocumentConfigRepository.js`
- Test: `tests/unit/infrastructure/s4SalesDocumentConfigRepository.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `S4_SALES_DOCUMENT_CONFIG_KEY = 's4SalesDocument'`
  - `S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY = 's4BusinessPartnerCreation'`
  - `class S4SalesDocumentConfigRepository` con:
    - `getSalesDocumentConfig({ tenantModels }) -> { quotationType, salesOrganization, distributionChannel, division, salesPersonPartnerFunction, priceConditionType }` (todos `string | null`)
    - `getBusinessPartnerCreationConfig({ tenantModels }) -> { findFallbackField: string|null, defaults: { BusinessPartner: object, BusinessPartnerRole: string[], Customer: object, CustomerCompany: object, CustomerSalesArea: object } }`

- [ ] **Step 1: Escribir el test que falla**

```js
// tests/unit/infrastructure/s4SalesDocumentConfigRepository.test.js
import {
  S4SalesDocumentConfigRepository,
  S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY,
  S4_SALES_DOCUMENT_CONFIG_KEY,
} from '../../../src/infrastructure/config/S4SalesDocumentConfigRepository.js';

function buildTenantModels(documentsByKey) {
  return {
    Configuration: {
      findOne: ({ key }) => ({ lean: async () => (documentsByKey[key] ?? null) }),
    },
  };
}

describe('S4SalesDocumentConfigRepository', () => {
  const repository = new S4SalesDocumentConfigRepository();

  it('lee la config de documento de venta', async () => {
    const tenantModels = buildTenantModels({
      [S4_SALES_DOCUMENT_CONFIG_KEY]: {
        value: {
          quotationType: 'ZPQD',
          salesOrganization: 'MQGT',
          distributionChannel: '01',
          division: '00',
          salesPersonPartnerFunction: 'VE',
          priceConditionType: null,
        },
      },
    });

    await expect(repository.getSalesDocumentConfig({ tenantModels })).resolves.toEqual({
      quotationType: 'ZPQD',
      salesOrganization: 'MQGT',
      distributionChannel: '01',
      division: '00',
      salesPersonPartnerFunction: 'VE',
      priceConditionType: null,
    });
  });

  // Un tenant sin la llave tiene que recibir todo en null, no undefined ni {}: el builder
  // distingue "no configurado" de "configurado vacío" para decidir si tira o si omite.
  it('devuelve todo en null cuando la llave no existe', async () => {
    await expect(
      repository.getSalesDocumentConfig({ tenantModels: buildTenantModels({}) })
    ).resolves.toEqual({
      quotationType: null,
      salesOrganization: null,
      distributionChannel: null,
      division: null,
      salesPersonPartnerFunction: null,
      priceConditionType: null,
    });
  });

  it('normaliza cadenas vacías y valores no string a null', async () => {
    const tenantModels = buildTenantModels({
      [S4_SALES_DOCUMENT_CONFIG_KEY]: {
        value: { quotationType: '  ', salesOrganization: 42, division: ' 00 ' },
      },
    });

    const config = await repository.getSalesDocumentConfig({ tenantModels });
    expect(config.quotationType).toBeNull();
    expect(config.salesOrganization).toBe('42');
    expect(config.division).toBe('00');
  });

  it('lee la config de creación de cliente con sus defaults por sub-entidad', async () => {
    const tenantModels = buildTenantModels({
      [S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY]: {
        value: {
          findFallbackField: 'to_Customer.BPTaxLongNumber',
          defaults: {
            BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
            BusinessPartnerRole: ['FLCU00', 'FLCU01'],
            Customer: { CustomerAccountGroup: 'ZC01' },
            CustomerCompany: { CompanyCode: '1000', ReconciliationAccount: '0012100000' },
            CustomerSalesArea: { Currency: 'GTQ', PriceListType: 'ZC' },
          },
        },
      },
    });

    await expect(repository.getBusinessPartnerCreationConfig({ tenantModels })).resolves.toEqual({
      findFallbackField: 'to_Customer.BPTaxLongNumber',
      defaults: {
        BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
        BusinessPartnerRole: ['FLCU00', 'FLCU01'],
        Customer: { CustomerAccountGroup: 'ZC01' },
        CustomerCompany: { CompanyCode: '1000', ReconciliationAccount: '0012100000' },
        CustomerSalesArea: { Currency: 'GTQ', PriceListType: 'ZC' },
      },
    });
  });

  it('devuelve defaults vacíos cuando la llave de creación no existe', async () => {
    await expect(
      repository.getBusinessPartnerCreationConfig({ tenantModels: buildTenantModels({}) })
    ).resolves.toEqual({
      findFallbackField: null,
      defaults: {
        BusinessPartner: {},
        BusinessPartnerRole: [],
        Customer: {},
        CustomerCompany: {},
        CustomerSalesArea: {},
      },
    });
  });

  // Misma conducta que BusinessPartnerCreationConfigRepository: una config ilegible significa
  // "usá los defaults", nunca tumbar el webhook.
  it('no lanza cuando la lectura revienta', async () => {
    const tenantModels = {
      Configuration: { findOne: () => { throw new Error('mongo caído'); } },
    };

    const config = await repository.getSalesDocumentConfig({ tenantModels });
    expect(config.quotationType).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/infrastructure/s4SalesDocumentConfigRepository.test.js`

Esperado: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementar**

```js
// src/infrastructure/config/S4SalesDocumentConfigRepository.js
import { toNonEmptyString } from '#shared/utils/string.utils.js';

export const S4_SALES_DOCUMENT_CONFIG_KEY = 's4SalesDocument';
export const S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY = 's4BusinessPartnerCreation';

// findOne directo, sin el upsert-on-missing de tenantConfiguration.service.getValue: un
// tenant B1 que nunca va a usar estas llaves no tiene por qué recibir documentos vacíos.
async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function toStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => toNonEmptyString(entry)).filter(Boolean)
    : [];
}

export function buildS4SalesDocumentDefaults() {
  return {
    quotationType: null,
    salesOrganization: null,
    distributionChannel: null,
    division: null,
    salesPersonPartnerFunction: null,
    priceConditionType: null,
  };
}

export function buildS4BusinessPartnerCreationDefaults() {
  return {
    findFallbackField: null,
    defaults: {
      BusinessPartner: {},
      BusinessPartnerRole: [],
      Customer: {},
      CustomerCompany: {},
      CustomerSalesArea: {},
    },
  };
}

export class S4SalesDocumentConfigRepository {
  async getSalesDocumentConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, S4_SALES_DOCUMENT_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildS4SalesDocumentDefaults();
      }

      return {
        quotationType: toNonEmptyString(raw.quotationType),
        salesOrganization: toNonEmptyString(raw.salesOrganization),
        distributionChannel: toNonEmptyString(raw.distributionChannel),
        division: toNonEmptyString(raw.division),
        salesPersonPartnerFunction: toNonEmptyString(raw.salesPersonPartnerFunction),
        priceConditionType: toNonEmptyString(raw.priceConditionType),
      };
    } catch (error) {
      console.error('s4SalesDocument config read error:', error);
      return buildS4SalesDocumentDefaults();
    }
  }

  async getBusinessPartnerCreationConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildS4BusinessPartnerCreationDefaults();
      }

      const rawDefaults = toPlainObject(raw.defaults);

      return {
        findFallbackField: toNonEmptyString(raw.findFallbackField),
        defaults: {
          BusinessPartner: toPlainObject(rawDefaults.BusinessPartner),
          BusinessPartnerRole: toStringList(rawDefaults.BusinessPartnerRole),
          Customer: toPlainObject(rawDefaults.Customer),
          CustomerCompany: toPlainObject(rawDefaults.CustomerCompany),
          CustomerSalesArea: toPlainObject(rawDefaults.CustomerSalesArea),
        },
      };
    } catch (error) {
      console.error('s4BusinessPartnerCreation config read error:', error);
      return buildS4BusinessPartnerCreationDefaults();
    }
  }
}

export default S4SalesDocumentConfigRepository;
```

**Nota para el implementador:** `toNonEmptyString` está en `#shared/utils/string.utils.js` y
devuelve `null` para vacíos. Confirmar que convierte números a string (el test lo exige con
`salesOrganization: 42` → `'42'`); si no lo hace, envolver con `String(value)` antes.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/infrastructure/s4SalesDocumentConfigRepository.test.js`

Esperado: PASS, 6 tests.

- [ ] **Step 5: Dejar el cambio en el working tree y reportar**

---

## Task 3: Builder del payload de la oferta

**Files:**
- Create: `src/domain/orders/s4-sales-document-builder.service.js`
- Test: `tests/unit/domain/s4SalesDocumentBuilder.test.js`

**Interfaces:**
- Consumes: `expandS4ODataKeys` (Task 1); la forma de `salesDocumentConfig` (Task 2).
- Produces:
  - `S4_RESERVED_HEADER_FIELDS: Set<string>`
  - `S4_RESERVED_LINE_FIELDS: Set<string>`
  - `resolveS4Plant({ lineItem, warehouseFields, logger }) -> string | null`
  - `buildS4QuotationPayload({ soldToParty, lineItems, productMappings, lineMappings, mappedDealFields, salesDocumentConfig, warehouseFields, salesPersonId, logger }) -> object`

- [ ] **Step 1: Escribir el test que falla**

```js
// tests/unit/domain/s4SalesDocumentBuilder.test.js
import { jest } from '@jest/globals';
import {
  S4_RESERVED_HEADER_FIELDS,
  buildS4QuotationPayload,
  resolveS4Plant,
} from '../../../src/domain/orders/s4-sales-document-builder.service.js';

const PRODUCT_MAPPINGS = [{ sourceField: 'ItemCode', targetField: 'hs_sku', isActive: true }];

const CONFIG = {
  quotationType: 'ZPQD',
  salesOrganization: 'MQGT',
  distributionChannel: '01',
  division: '00',
  salesPersonPartnerFunction: 'VE',
  priceConditionType: null,
};

const WAREHOUSE_FIELDS = [
  { label: 'MQGT 0008', value: 'mqgt_0008_stock', valueSAP: 'MQGT/0008' },
  { label: 'HFDO 0401', value: 'hfdo_0401_stock', valueSAP: 'HFDO/0401' },
];

function buildArgs(overrides = {}) {
  return {
    soldToParty: '100053',
    lineItems: [{ hs_sku: '1001', quantity: 2 }],
    productMappings: PRODUCT_MAPPINGS,
    lineMappings: [],
    mappedDealFields: {},
    salesDocumentConfig: CONFIG,
    warehouseFields: [],
    salesPersonId: null,
    logger: null,
    ...overrides,
  };
}

describe('buildS4QuotationPayload', () => {
  it('arma la cabecera y una posición con numeración de S/4', () => {
    expect(buildS4QuotationPayload(buildArgs())).toEqual({
      SalesQuotationType: 'ZPQD',
      SalesOrganization: 'MQGT',
      DistributionChannel: '01',
      OrganizationDivision: '00',
      SoldToParty: '100053',
      to_Item: [{ SalesQuotationItem: '000010', Material: '1001', RequestedQuantity: '2' }],
    });
  });

  it('numera las posiciones de diez en diez', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: 'A', quantity: 1 }, { hs_sku: 'B', quantity: 1 }, { hs_sku: 'C', quantity: 1 }],
    }));

    expect(payload.to_Item.map((item) => item.SalesQuotationItem)).toEqual(['000010', '000020', '000030']);
  });

  // El mapeo del negocio le gana al default: es lo que deja al asesor fijar el área por negocio.
  it('el mapeo del deal gana sobre el default de la config', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      mappedDealFields: { SalesOrganization: 'DPDO', DistributionChannel: '02' },
    }));

    expect(payload.SalesOrganization).toBe('DPDO');
    expect(payload.DistributionChannel).toBe('02');
    expect(payload.OrganizationDivision).toBe('00');
  });

  it('derrama los campos mapeados del deal que no son reservados, expandidos', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      mappedDealFields: {
        PurchaseOrderByCustomer: 'OC-1234',
        YY1_Observacion_SDH: 'texto libre',
      },
    }));

    expect(payload.PurchaseOrderByCustomer).toBe('OC-1234');
    expect(payload.YY1_Observacion_SDH).toBe('texto libre');
  });

  // SoldToParty y las navegaciones las posee el builder: un mapeo no puede pisarlas.
  it('un mapeo no puede pisar los campos reservados', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      mappedDealFields: { SoldToParty: 'PISADO', to_Item: 'PISADO' },
    }));

    expect(payload.SoldToParty).toBe('100053');
    expect(payload.to_Item).toEqual([
      { SalesQuotationItem: '000010', Material: '1001', RequestedQuantity: '2' },
    ]);
  });

  it('declara SoldToParty y las navegaciones como reservados de cabecera', () => {
    expect([...S4_RESERVED_HEADER_FIELDS].sort()).toEqual(
      ['SalesQuotation', 'SoldToParty', 'to_Item', 'to_Partner', 'to_PricingElement'].sort()
    );
  });

  it('derrama los campos mapeados de línea que no son reservados', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, unidad: 'KG' }],
      lineMappings: [{ sourceField: 'RequestedQuantityUnit', targetField: 'unidad', isActive: true }],
    }));

    expect(payload.to_Item[0].RequestedQuantityUnit).toBe('KG');
  });

  it('resuelve Plant desde la propiedad warehouses y fieldsWareHouseHS', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, warehouses: 'mqgt_0008_stock' }],
      warehouseFields: WAREHOUSE_FIELDS,
    }));

    expect(payload.to_Item[0].Plant).toBe('MQGT');
  });

  it('omite Plant con warn cuando warehouses no coincide con ninguna entrada', () => {
    const logger = { warn: jest.fn() };
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, warehouses: 'inexistente' }],
      warehouseFields: WAREHOUSE_FIELDS,
      logger,
    }));

    expect(payload.to_Item[0]).not.toHaveProperty('Plant');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('agrega to_Partner cuando hay función de interlocutor y vendedor', () => {
    const payload = buildS4QuotationPayload(buildArgs({ salesPersonId: '67' }));

    expect(payload.to_Partner).toEqual([{ PartnerFunction: 'VE', Personnel: '67' }]);
  });

  // Igual que DocumentsOwner en B1: la clave NO viaja en null, se omite entera.
  it('omite to_Partner cuando no hay vendedor resuelto', () => {
    expect(buildS4QuotationPayload(buildArgs({ salesPersonId: null })))
      .not.toHaveProperty('to_Partner');
  });

  it('omite to_Partner cuando la función de interlocutor no está configurada', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      salesDocumentConfig: { ...CONFIG, salesPersonPartnerFunction: null },
      salesPersonId: '67',
    }));

    expect(payload).not.toHaveProperty('to_Partner');
  });

  it('no manda precio por defecto', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, hs_effective_unit_price: 99 }],
    }));

    expect(payload.to_Item[0]).not.toHaveProperty('to_PricingElement');
  });

  it('manda to_PricingElement cuando la config declara un tipo de condición', () => {
    const payload = buildS4QuotationPayload(buildArgs({
      lineItems: [{ hs_sku: '1001', quantity: 1, hs_effective_unit_price: 99 }],
      salesDocumentConfig: { ...CONFIG, priceConditionType: 'ZPR0' },
      mappedDealFields: { TransactionCurrency: 'GTQ' },
    }));

    expect(payload.to_Item[0].to_PricingElement).toEqual([
      { ConditionType: 'ZPR0', ConditionRateValue: '99', ConditionCurrency: 'GTQ' },
    ]);
  });

  describe('validaciones', () => {
    it('tira permanente sin line items', () => {
      expect(() => buildS4QuotationPayload(buildArgs({ lineItems: [] })))
        .toThrow(/line_item/i);
    });

    it('tira permanente cuando falta el Material de una línea', () => {
      expect(() => buildS4QuotationPayload(buildArgs({ lineItems: [{ quantity: 1 }] })))
        .toThrow(/Material/i);
    });

    it('tira permanente con cantidad cero o negativa', () => {
      expect(() => buildS4QuotationPayload(buildArgs({ lineItems: [{ hs_sku: '1001', quantity: 0 }] })))
        .toThrow(/cantidad/i);
    });

    it('tira permanente nombrando el campo de cabecera que falta', () => {
      expect(() => buildS4QuotationPayload(buildArgs({
        salesDocumentConfig: { ...CONFIG, salesOrganization: null },
      }))).toThrow(/SalesOrganization/);
    });
  });
});

describe('resolveS4Plant', () => {
  it('traduce el value de HubSpot al centro del valueSAP', () => {
    expect(resolveS4Plant({
      lineItem: { warehouses: 'hfdo_0401_stock' },
      warehouseFields: WAREHOUSE_FIELDS,
    })).toBe('HFDO');
  });

  it('devuelve null sin propiedad warehouses', () => {
    expect(resolveS4Plant({ lineItem: {}, warehouseFields: WAREHOUSE_FIELDS })).toBeNull();
  });

  it('devuelve null cuando no hay entradas configuradas', () => {
    expect(resolveS4Plant({ lineItem: { warehouses: 'x' }, warehouseFields: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/domain/s4SalesDocumentBuilder.test.js`

Esperado: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementar**

```js
// src/domain/orders/s4-sales-document-builder.service.js
import { mapHubspotToSapFields } from './order-builder.service.js';
import { expandS4ODataKeys } from '#domain/sap/s4-odata-payload.service.js';
import { parseS4WarehouseCode } from '#domain/warehouses/strategies/s4-plant-storage-location.strategy.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// Lista propia de S/4: NO se reusa RESERVED_HEADER_FIELDS de order-builder.service.js, que
// nombra campos de B1 (CardCode, DocumentLines, PaymentGroupCode) y no significa nada acá.
export const S4_RESERVED_HEADER_FIELDS = new Set([
  'SoldToParty',
  'SalesQuotation',
  'to_Item',
  'to_Partner',
  'to_PricingElement',
]);

export const S4_RESERVED_LINE_FIELDS = new Set([
  'SalesQuotationItem',
  'Material',
  'RequestedQuantity',
  'to_PricingElement',
]);

function pickUnreserved(mappedFields, reserved) {
  const fields = {};

  for (const [field, value] of Object.entries(mappedFields || {})) {
    // Solo el primer segmento se compara: un mapeo `to_Item.Foo` tiene que quedar fuera igual
    // que `to_Item` pelado, o se cuela por debajo de la reserva.
    if (reserved.has(field.split('.')[0])) {
      continue;
    }
    fields[field] = value;
  }

  return fields;
}

// S/4 exige estos cuatro en toda oferta. Se resuelven mapeo -> default -> error, y el error
// NOMBRA el campo: sin eso el rechazo del gateway llega como un texto genérico que no dice
// cuál de los cuatro faltaba.
function resolveRequiredHeaderField(mappedDealFields, configValue, sapField) {
  const value = toNonEmptyString(mappedDealFields?.[sapField]) || toNonEmptyString(configValue);

  if (!value) {
    throw new PermanentWebhookError(
      `${sapField} es requerido para crear la oferta en S/4: no vino en el mapeo deal/orders-quotations ni en la configuración s4SalesDocument`
    );
  }

  return value;
}

// La propiedad `warehouses` del line item trae el VALUE de HubSpot (p.ej. 'mqgt_0008_stock'),
// no el código de SAP. fieldsWareHouseHS es la tabla que traduce value -> valueSAP, y de ahí
// parseS4WarehouseCode saca el centro.
export function resolveS4Plant({ lineItem, warehouseFields = [], logger = null }) {
  const warehouseValue = toNonEmptyString(lineItem?.warehouses);

  if (!warehouseValue) {
    return null;
  }

  const entry = (Array.isArray(warehouseFields) ? warehouseFields : []).find(
    (candidate) => toNonEmptyString(candidate?.value) === warehouseValue
  );

  const parsed = entry ? parseS4WarehouseCode(entry.valueSAP) : null;

  if (!parsed?.plant) {
    logger?.warn?.({
      msg: 'Posición sin Plant: la bodega de HubSpot no está en fieldsWareHouseHS o su valueSAP es inválido',
      warehouseValue,
      valueSAP: entry?.valueSAP ?? null,
    });
    return null;
  }

  return parsed.plant;
}

function buildItems({
  lineItems,
  productMappings,
  lineMappings,
  warehouseFields,
  priceConditionType,
  transactionCurrency,
  logger,
}) {
  const items = [];

  for (const [index, lineItem] of (Array.isArray(lineItems) ? lineItems : []).entries()) {
    const mappedProduct = mapHubspotToSapFields(lineItem, productMappings, { logger });
    const material = toNonEmptyString(mappedProduct?.ItemCode || lineItem?.hs_sku);
    const quantity = normalizeNumber(mappedProduct?.Quantity ?? lineItem?.quantity, 1);

    if (!material) {
      throw new PermanentWebhookError('Material/hs_sku es requerido en el mapeo de line_items');
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PermanentWebhookError(`Cantidad inválida para el material ${material}`);
    }

    const mappedLine = pickUnreserved(
      mapHubspotToSapFields(lineItem, lineMappings, { logger }),
      S4_RESERVED_LINE_FIELDS
    );

    const item = {
      ...expandS4ODataKeys(mappedLine, { logger }),
      SalesQuotationItem: String((index + 1) * 10).padStart(6, '0'),
      Material: material,
      // Gateway OData v2 quiere los Edm.Decimal como string; un number se serializa sin
      // decimales y SAP lo rechaza o lo trunca.
      RequestedQuantity: String(quantity),
    };

    const plant = resolveS4Plant({ lineItem, warehouseFields, logger });
    if (plant) {
      item.Plant = plant;
    }

    if (priceConditionType) {
      const unitPrice = normalizeNumber(lineItem?.hs_effective_unit_price ?? lineItem?.price, null);

      if (Number.isFinite(unitPrice)) {
        item.to_PricingElement = [{
          ConditionType: priceConditionType,
          ConditionRateValue: String(unitPrice),
          ...(transactionCurrency ? { ConditionCurrency: transactionCurrency } : {}),
        }];
      }
    }

    items.push(item);
  }

  if (!items.length) {
    throw new PermanentWebhookError('Se requiere al menos un line_item para crear la oferta en S/4');
  }

  return items;
}

export function buildS4QuotationPayload({
  soldToParty,
  lineItems,
  productMappings,
  lineMappings = [],
  mappedDealFields = {},
  salesDocumentConfig,
  warehouseFields = [],
  salesPersonId = null,
  logger = null,
}) {
  const resolvedSoldToParty = toNonEmptyString(soldToParty);

  if (!resolvedSoldToParty) {
    throw new PermanentWebhookError('SoldToParty es requerido para crear la oferta en S/4');
  }

  const transactionCurrency = toNonEmptyString(mappedDealFields?.TransactionCurrency);

  const to_Item = buildItems({
    lineItems,
    productMappings,
    lineMappings,
    warehouseFields,
    priceConditionType: salesDocumentConfig?.priceConditionType ?? null,
    transactionCurrency,
    logger,
  });

  const payload = {
    ...expandS4ODataKeys(pickUnreserved(mappedDealFields, S4_RESERVED_HEADER_FIELDS), { logger }),
    SalesQuotationType: resolveRequiredHeaderField(mappedDealFields, salesDocumentConfig?.quotationType, 'SalesQuotationType'),
    SalesOrganization: resolveRequiredHeaderField(mappedDealFields, salesDocumentConfig?.salesOrganization, 'SalesOrganization'),
    DistributionChannel: resolveRequiredHeaderField(mappedDealFields, salesDocumentConfig?.distributionChannel, 'DistributionChannel'),
    OrganizationDivision: resolveRequiredHeaderField(mappedDealFields, salesDocumentConfig?.division, 'OrganizationDivision'),
    SoldToParty: resolvedSoldToParty,
    to_Item,
  };

  const partnerFunction = toNonEmptyString(salesDocumentConfig?.salesPersonPartnerFunction);
  const personnel = toNonEmptyString(salesPersonId);

  // Mismo criterio que DocumentsOwner en B1: si no se resuelve, la clave no viaja. Mandarla
  // en null deja el documento sin asignar igual, pero además ensucia el payload.
  if (partnerFunction && personnel) {
    payload.to_Partner = [{ PartnerFunction: partnerFunction, Personnel: personnel }];
  }

  return payload;
}

export default { buildS4QuotationPayload, resolveS4Plant, S4_RESERVED_HEADER_FIELDS, S4_RESERVED_LINE_FIELDS };
```

**Nota para el implementador:** los cuatro campos de cabecera obligatorios se escriben
**después** del derrame, así que ganan siempre; los reservados además se filtran antes. Son
dos defensas para lo mismo, y es a propósito: si alguien agrega un campo obligatorio y olvida
sumarlo a `S4_RESERVED_HEADER_FIELDS`, el orden de escritura lo sigue protegiendo.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/domain/s4SalesDocumentBuilder.test.js`

Esperado: PASS, 19 tests.

- [ ] **Step 5: Verificar que no se rompió el builder de B1**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/domain/quotationBuilder.test.js`

Esperado: PASS, igual que antes del cambio. `s4-sales-document-builder.service.js` importa de
`order-builder.service.js` pero no lo modifica.

- [ ] **Step 6: Dejar el cambio en el working tree y reportar**

---

## Task 4: Payload de creación del cliente en S/4

**Files:**
- Create: `src/domain/business-partners/s4-business-partner-payload.service.js`
- Test: `tests/unit/domain/s4BusinessPartnerPayload.test.js`

**Interfaces:**
- Consumes: `expandS4ODataKeys` (Task 1); la forma de `creationConfig` (Task 2).
- Produces: `buildS4BusinessPartnerCreatePayload({ mappedCompany, creationConfig, salesArea, logger }) -> object`
  - `salesArea`: `{ salesOrganization: string, distributionChannel: string, division: string }`

- [ ] **Step 1: Escribir el test que falla**

```js
// tests/unit/domain/s4BusinessPartnerPayload.test.js
import { buildS4BusinessPartnerCreatePayload } from '../../../src/domain/business-partners/s4-business-partner-payload.service.js';

const CREATION_CONFIG = {
  findFallbackField: 'to_Customer.BPTaxLongNumber',
  defaults: {
    BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
    BusinessPartnerRole: ['FLCU00', 'FLCU01'],
    Customer: { CustomerAccountGroup: 'ZC01' },
    CustomerCompany: { CompanyCode: '1000', ReconciliationAccount: '0012100000' },
    CustomerSalesArea: { Currency: 'GTQ', PriceListType: 'ZC' },
  },
};

const SALES_AREA = { salesOrganization: 'MQGT', distributionChannel: '01', division: '00' };

describe('buildS4BusinessPartnerCreatePayload', () => {
  it('arma el deep create con roles, dirección, cliente, sociedad y área de ventas', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: {
        BusinessPartnerFullName: 'ACME S.A.',
        'to_BusinessPartnerAddress.CityName': 'Ciudad de Guatemala',
        'to_BusinessPartnerAddress.Country': 'GT',
        'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress': 'compras@acme.com',
        'to_Customer.BPTaxLongNumber': '1234567-8',
      },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload).toEqual({
      BusinessPartnerCategory: '2',
      BusinessPartnerGrouping: 'ZC01',
      OrganizationBPName1: 'ACME S.A.',
      to_BusinessPartnerRole: [
        { BusinessPartnerRole: 'FLCU00' },
        { BusinessPartnerRole: 'FLCU01' },
      ],
      to_BusinessPartnerAddress: [{
        CityName: 'Ciudad de Guatemala',
        Country: 'GT',
        to_EmailAddress: [{ EmailAddress: 'compras@acme.com' }],
      }],
      to_Customer: {
        CustomerAccountGroup: 'ZC01',
        BPTaxLongNumber: '1234567-8',
        to_CustomerCompany: [{ CompanyCode: '1000', ReconciliationAccount: '0012100000' }],
        to_CustomerSalesArea: [{
          Currency: 'GTQ',
          PriceListType: 'ZC',
          SalesOrganization: 'MQGT',
          DistributionChannel: '01',
          Division: '00',
        }],
      },
    });
  });

  // BusinessPartnerFullName es CALCULADO y de solo lectura en A_BusinessPartner. El campo
  // escribible es OrganizationBPName1. El mapeo del tenant dice BusinessPartnerFullName porque
  // ese es el nombre que sirve para LEER, así que acá se traduce.
  it('traduce BusinessPartnerFullName a OrganizationBPName1', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME S.A.' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload.OrganizationBPName1).toBe('ACME S.A.');
    expect(payload).not.toHaveProperty('BusinessPartnerFullName');
  });

  it('respeta OrganizationBPName1 cuando el mapeo ya lo trae', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { OrganizationBPName1: 'Explícito', BusinessPartnerFullName: 'Calculado' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload.OrganizationBPName1).toBe('Explícito');
  });

  // Mismo orden de precedencia que B1: el default configurado gana, el mapeo llena el resto.
  it('el default de la config gana sobre el valor mapeado', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME', BusinessPartnerGrouping: 'ZZ99' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    });

    expect(payload.BusinessPartnerGrouping).toBe('ZC01');
  });

  it('el área de ventas del documento gana sobre el default de la config', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: {
        ...CREATION_CONFIG,
        defaults: {
          ...CREATION_CONFIG.defaults,
          CustomerSalesArea: { ...CREATION_CONFIG.defaults.CustomerSalesArea, SalesOrganization: 'VIEJA' },
        },
      },
      salesArea: SALES_AREA,
    });

    expect(payload.to_Customer.to_CustomerSalesArea[0].SalesOrganization).toBe('MQGT');
  });

  it('omite to_BusinessPartnerRole cuando la config no declara roles', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: { ...CREATION_CONFIG, defaults: { ...CREATION_CONFIG.defaults, BusinessPartnerRole: [] } },
      salesArea: SALES_AREA,
    });

    expect(payload).not.toHaveProperty('to_BusinessPartnerRole');
  });

  it('omite to_CustomerCompany cuando la config no trae sociedad', () => {
    const payload = buildS4BusinessPartnerCreatePayload({
      mappedCompany: { BusinessPartnerFullName: 'ACME' },
      creationConfig: { ...CREATION_CONFIG, defaults: { ...CREATION_CONFIG.defaults, CustomerCompany: {} } },
      salesArea: SALES_AREA,
    });

    expect(payload.to_Customer).not.toHaveProperty('to_CustomerCompany');
  });

  it('tira permanente cuando no hay nombre para el cliente', () => {
    expect(() => buildS4BusinessPartnerCreatePayload({
      mappedCompany: { 'to_Customer.BPTaxLongNumber': '1234567-8' },
      creationConfig: CREATION_CONFIG,
      salesArea: SALES_AREA,
    })).toThrow(/nombre/i);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/domain/s4BusinessPartnerPayload.test.js`

Esperado: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementar**

```js
// src/domain/business-partners/s4-business-partner-payload.service.js
import { expandS4ODataKeys } from '#domain/sap/s4-odata-payload.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';

// BusinessPartnerFullName es un campo CALCULADO de A_BusinessPartner: se puede leer pero no
// escribir. El tenant lo tiene mapeado porque es el que sirve para el sync SAP -> HubSpot;
// para crear hay que mandarlo en OrganizationBPName1.
const READ_ONLY_NAME_FIELD = 'BusinessPartnerFullName';
const WRITABLE_NAME_FIELD = 'OrganizationBPName1';

function hasEntries(value) {
  return Boolean(value) && Object.keys(value).length > 0;
}

export function buildS4BusinessPartnerCreatePayload({
  mappedCompany,
  creationConfig,
  salesArea,
  logger = null,
}) {
  const defaults = creationConfig?.defaults ?? {};
  const expanded = expandS4ODataKeys(mappedCompany || {}, { logger });

  const { [READ_ONLY_NAME_FIELD]: readOnlyName, to_Customer: mappedCustomer, ...rest } = expanded;
  const name = toNonEmptyString(rest[WRITABLE_NAME_FIELD]) || toNonEmptyString(readOnlyName);

  if (!name) {
    throw new PermanentWebhookError(
      'El nombre de la empresa es requerido para crear el cliente en S/4: el mapeo company/businessPartner no produjo BusinessPartnerFullName ni OrganizationBPName1'
    );
  }

  // Precedencia: el mapeo llena, el default configurado pisa. Mismo orden que B1, donde el
  // default del tenant es la política y el dato de HubSpot es solo el relleno.
  const payload = {
    ...rest,
    ...defaults.BusinessPartner,
    [WRITABLE_NAME_FIELD]: name,
  };

  const roles = Array.isArray(defaults.BusinessPartnerRole) ? defaults.BusinessPartnerRole : [];
  if (roles.length > 0) {
    payload.to_BusinessPartnerRole = roles.map((role) => ({ BusinessPartnerRole: role }));
  }

  const customer = {
    ...(mappedCustomer && typeof mappedCustomer === 'object' ? mappedCustomer : {}),
    ...defaults.Customer,
  };

  if (hasEntries(defaults.CustomerCompany)) {
    customer.to_CustomerCompany = [{ ...defaults.CustomerCompany }];
  }

  // El área de ventas del DOCUMENTO gana sobre la de la config: el cliente tiene que quedar
  // registrado en el área donde se le va a crear la oferta, o SAP rechaza el documento con
  // "cliente no existe en el área de ventas".
  customer.to_CustomerSalesArea = [{
    ...defaults.CustomerSalesArea,
    SalesOrganization: salesArea?.salesOrganization,
    DistributionChannel: salesArea?.distributionChannel,
    Division: salesArea?.division,
  }];

  payload.to_Customer = customer;

  return payload;
}

export default { buildS4BusinessPartnerCreatePayload };
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/domain/s4BusinessPartnerPayload.test.js`

Esperado: PASS, 8 tests.

- [ ] **Step 5: Dejar el cambio en el working tree y reportar**

---

## Task 5: Puertos, adapters de envío y grabación de auditoría

**Files:**
- Create: `src/application/ports/sap/sap-sales-document.port.js`
- Create: `src/application/ports/sap/sales-document-builder.port.js`
- Create: `src/application/ports/sap/sap-document-business-partner.port.js`
- Create: `src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js`
- Create: `src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js`
- Create: `src/infrastructure/sap/salesDocuments/recordedS4Transport.js`
- Test: `tests/unit/infrastructure/s4SalesDocumentAdapter.test.js`

**Interfaces:**
- Consumes: `SapWebhookQuotationAdapter` existente; `SapTransportPort`.
- Produces:
  - `SapSalesDocumentPort` (método `createQuotation`)
  - `SalesDocumentBuilderPort` (método `buildQuotationPayload`)
  - `SapDocumentBusinessPartnerPort` (método `findOrCreateForDocument`)
  - `class B1SalesDocumentAdapter { constructor({ quotationAdapter }); createQuotation({ sapConfig, quotationPayload }) }`
  - `class S4SalesDocumentAdapter { constructor({ transport }); createQuotation({ quotationPayload }) }`
  - `normalizeS4QuotationResponse(raw) -> { DocEntry, DocNum, DocumentLines, raw }`
  - `wrapS4TransportWithRecorder(transport, sapCallRecorder) -> transport`

- [ ] **Step 1: Escribir el test que falla**

```js
// tests/unit/infrastructure/s4SalesDocumentAdapter.test.js
import { jest } from '@jest/globals';
import {
  S4SalesDocumentAdapter,
  normalizeS4QuotationResponse,
} from '../../../src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js';
import { B1SalesDocumentAdapter } from '../../../src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js';
import { wrapS4TransportWithRecorder } from '../../../src/infrastructure/sap/salesDocuments/recordedS4Transport.js';
import { createSapCallRecorder } from '../../../src/infrastructure/sap/sapCallRecorder.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { SapSalesDocumentPort } from '../../../src/application/ports/sap/sap-sales-document.port.js';

describe('S4SalesDocumentAdapter', () => {
  it('cumple SapSalesDocumentPort', () => {
    expect(() => assertPort(new S4SalesDocumentAdapter({ transport: { request: () => {} } }), SapSalesDocumentPort))
      .not.toThrow();
  });

  it('postea la oferta en la ruta de API_SALES_QUOTATION_SRV', async () => {
    const request = jest.fn().mockResolvedValue({ SalesQuotation: '20000123', to_Item: [] });
    const adapter = new S4SalesDocumentAdapter({ transport: { request } });

    await adapter.createQuotation({ quotationPayload: { SoldToParty: '100053' } });

    expect(request).toHaveBeenCalledWith({
      method: 'post',
      path: '/API_SALES_QUOTATION_SRV/A_SalesQuotation',
      body: { SoldToParty: '100053' },
    });
  });

  // El caso de uso, buildSapDocumentLinkLines y updateAfterSap leen DocEntry/DocNum/LineNum
  // literalmente. Normalizar acá es lo que evita tocarlos.
  it('normaliza la respuesta a la forma de B1', async () => {
    const transport = {
      request: async () => ({
        SalesQuotation: '20000123',
        to_Item: [{ SalesQuotationItem: '000010' }, { SalesQuotationItem: '000020' }],
      }),
    };

    const result = await new S4SalesDocumentAdapter({ transport })
      .createQuotation({ quotationPayload: {} });

    expect(result).toEqual({
      DocEntry: 20000123,
      DocNum: 20000123,
      DocumentLines: [{ LineNum: 10 }, { LineNum: 20 }],
      raw: {
        SalesQuotation: '20000123',
        to_Item: [{ SalesQuotationItem: '000010' }, { SalesQuotationItem: '000020' }],
      },
    });
  });
});

describe('normalizeS4QuotationResponse', () => {
  it('lee to_Item envuelto en results, como lo devuelve OData v2 sin normalizar', () => {
    const result = normalizeS4QuotationResponse({
      SalesQuotation: '20000999',
      to_Item: { results: [{ SalesQuotationItem: '000010' }] },
    });

    expect(result.DocEntry).toBe(20000999);
    expect(result.DocumentLines).toEqual([{ LineNum: 10 }]);
  });

  it('devuelve DocumentLines vacío cuando la respuesta no trae posiciones', () => {
    expect(normalizeS4QuotationResponse({ SalesQuotation: '1' }).DocumentLines).toEqual([]);
  });

  it('deja DocEntry en null cuando el número no es numérico', () => {
    const result = normalizeS4QuotationResponse({ SalesQuotation: '' });
    expect(result.DocEntry).toBeNull();
    expect(result.DocNum).toBeNull();
  });
});

describe('B1SalesDocumentAdapter', () => {
  it('delega en el adapter de Quotations de hoy, sin tocar la respuesta', async () => {
    const createQuotation = jest.fn().mockResolvedValue({ DocEntry: 55, DocNum: 900 });
    const adapter = new B1SalesDocumentAdapter({ quotationAdapter: { createQuotation } });

    const result = await adapter.createQuotation({
      sapConfig: { serviceLayerBaseUrl: 'https://b1' },
      quotationPayload: { CardCode: 'CL001' },
    });

    expect(createQuotation).toHaveBeenCalledWith({
      sapConfig: { serviceLayerBaseUrl: 'https://b1' },
      quotationPayload: { CardCode: 'CL001' },
    });
    expect(result).toEqual({ DocEntry: 55, DocNum: 900 });
  });
});

describe('wrapS4TransportWithRecorder', () => {
  // sapCallRecorder.wrap intercepta request(sapConfig, options), que es la firma de B1.
  // El transporte de S/4 recibe UN objeto, así que necesita su propio envoltorio.
  it('graba método, path, query y body de cada llamada', async () => {
    const recorder = createSapCallRecorder();
    const transport = { request: jest.fn().mockResolvedValue({ ok: true }) };
    const recorded = wrapS4TransportWithRecorder(transport, recorder);

    await recorded.request({ method: 'post', path: '/X', query: { $top: 1 }, body: { a: 1 } });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      method: 'POST',
      path: '/X',
      params: { $top: 1 },
      request: { a: 1 },
      ok: true,
    });
  });

  it('graba la llamada que falla y vuelve a lanzar', async () => {
    const recorder = createSapCallRecorder();
    const transport = { request: jest.fn().mockRejectedValue(new Error('gateway 400')) };
    const recorded = wrapS4TransportWithRecorder(transport, recorder);

    await expect(recorded.request({ method: 'post', path: '/X' })).rejects.toThrow('gateway 400');
    expect(recorder.calls[0]).toMatchObject({ ok: false, path: '/X' });
  });

  it('devuelve el transporte tal cual cuando no hay grabador', () => {
    const transport = { request: () => {} };
    expect(wrapS4TransportWithRecorder(transport, null)).toBe(transport);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/infrastructure/s4SalesDocumentAdapter.test.js`

Esperado: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementar los tres puertos**

```js
// src/application/ports/sap/sap-sales-document.port.js
import { createPort } from '../port-validator.js';

// Envío de documentos de venta. Toda implementación devuelve la MISMA forma, la de B1
// (`{ DocEntry, DocNum, DocumentLines: [{LineNum}], raw }`), para que el caso de uso, el
// repositorio de SapDocumentLink y el write-back a HubSpot no sepan de qué SAP se trata.
export const SapSalesDocumentPort = createPort({
  name: 'SapSalesDocumentPort',
  methods: [
    // createQuotation({ sapConfig, quotationPayload }) -> { DocEntry, DocNum, DocumentLines, raw }
    'createQuotation',
  ],
});

export default SapSalesDocumentPort;
```

```js
// src/application/ports/sap/sales-document-builder.port.js
import { createPort } from '../port-validator.js';

// Construcción del payload del documento. Cada flavor habla su propio modelo de entidades
// (B1 `CardCode`/`DocumentLines` vs S/4 `SoldToParty`/`to_Item`).
export const SalesDocumentBuilderPort = createPort({
  name: 'SalesDocumentBuilderPort',
  methods: [
    // buildQuotationPayload(args) -> payload listo para el adapter del mismo flavor
    'buildQuotationPayload',
  ],
});

export default SalesDocumentBuilderPort;
```

```js
// src/application/ports/sap/sap-document-business-partner.port.js
import { createPort } from '../port-validator.js';

// Resolución (y creación) del cliente del documento. La implementación de B1 delega en
// resolveBusinessPartnerForDocument tal como está hoy; la de S/4 habla A_BusinessPartner.
export const SapDocumentBusinessPartnerPort = createPort({
  name: 'SapDocumentBusinessPartnerPort',
  methods: [
    // findOrCreateForDocument(args) -> { cardCode, businessPartnerResult, contactEmployeeResult,
    //   contactEmployeeFailures, hubspotToken, dealContactIsContactEmployee }
    'findOrCreateForDocument',
  ],
});

export default SapDocumentBusinessPartnerPort;
```

- [ ] **Step 4: Implementar los adapters y el grabador**

```js
// src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js

// Envoltorio fino sobre el adapter de Quotations que ya corre en producción. No cambia su
// respuesta: el caso de uso ya la sabe leer, y este puerto define esa forma como el contrato.
export class B1SalesDocumentAdapter {
  constructor({ quotationAdapter }) {
    if (!quotationAdapter) {
      throw new Error('quotationAdapter is required for B1SalesDocumentAdapter');
    }
    this.quotationAdapter = quotationAdapter;
  }

  async createQuotation({ sapConfig, quotationPayload }) {
    return this.quotationAdapter.createQuotation({ sapConfig, quotationPayload });
  }
}

export default B1SalesDocumentAdapter;
```

```js
// src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

const SALES_QUOTATION_PATH = '/API_SALES_QUOTATION_SRV/A_SalesQuotation';

// OData v2 devuelve las colecciones como `{ results: [...] }`. S4GatewayTransport ya
// desenvuelve lo que puede (odataV2Normalizer), pero una navegación anidada en la respuesta
// de un POST puede llegar cruda, así que se contemplan las dos formas.
function readCollection(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return Array.isArray(value?.results) ? value.results : [];
}

// S/4 tiene UN solo número de documento, así que DocEntry y DocNum son el mismo valor. Las
// posiciones son '000010', '000020': se guardan como 10, 20, que es lo que el modelo de
// SapDocumentLink acepta en sapLineNum (Number).
export function normalizeS4QuotationResponse(raw) {
  // OJO con normalizeNumber a secas: `Number('')` y `Number(null)` valen 0, que ES finito, así
  // que una respuesta sin número de oferta se guardaría como DocEntry 0 en vez de null y el
  // SapDocumentLink quedaría apuntando a un documento inexistente. Por eso se descarta el
  // vacío ANTES de parsear.
  const rawNumber = toNonEmptyString(raw?.SalesQuotation);
  const salesQuotation = rawNumber === null ? null : normalizeNumber(rawNumber, null);
  const documentNumber = Number.isFinite(salesQuotation) ? salesQuotation : null;

  return {
    DocEntry: documentNumber,
    DocNum: documentNumber,
    DocumentLines: readCollection(raw?.to_Item).map((item) => ({
      LineNum: normalizeNumber(item?.SalesQuotationItem, null),
    })),
    raw,
  };
}

export class S4SalesDocumentAdapter {
  constructor({ transport }) {
    if (!transport) {
      throw new Error('transport is required for S4SalesDocumentAdapter');
    }
    this.transport = transport;
  }

  // `sapConfig` se acepta y se ignora: el transporte ya se construyó con él en la factory.
  // Está en la firma porque el puerto es uno solo para los dos flavors.
  async createQuotation({ quotationPayload }) {
    const created = await this.transport.request({
      method: 'post',
      path: SALES_QUOTATION_PATH,
      body: quotationPayload,
    });

    return normalizeS4QuotationResponse(created);
  }
}

export default S4SalesDocumentAdapter;
```

```js
// src/infrastructure/sap/salesDocuments/recordedS4Transport.js

// sapCallRecorder.wrap intercepta `request(sapConfig, options)`, que es la firma del
// transporte de B1. El de S/4 recibe UN objeto (`{method, path, query, headers, body}`), así
// que necesita su propio envoltorio o el tráfico de S/4 no queda en el audit trail.
// Mismo truco de Object.create: preserva el prototipo y los `this.request` internos.
export function wrapS4TransportWithRecorder(transport, sapCallRecorder) {
  if (!transport?.request || typeof sapCallRecorder?.record !== 'function') {
    return transport;
  }

  return Object.create(transport, {
    request: {
      value: function requestWithAudit(options = {}) {
        return sapCallRecorder.record(
          {
            method: options.method,
            path: options.path,
            params: options.query ?? null,
            data: options.body ?? null,
          },
          () => transport.request(options)
        );
      },
    },
  });
}

export default wrapS4TransportWithRecorder;
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/infrastructure/s4SalesDocumentAdapter.test.js`

Esperado: PASS, 10 tests.

- [ ] **Step 6: Dejar el cambio en el working tree y reportar**

---

## Task 6: Resolvers de cliente y factory de strategy

**Files:**
- Create: `src/application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js`
- Create: `src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js`
- Create: `src/infrastructure/sap/salesDocuments/salesDocumentStrategyFactory.js`
- Test: `tests/unit/application/s4DocumentBusinessPartnerResolver.test.js`
- Test: `tests/unit/infrastructure/salesDocumentStrategyFactory.test.js`

**Interfaces:**
- Consumes: `buildS4BusinessPartnerCreatePayload` (Task 4); `buildS4QuotationPayload` (Task 3); los adapters y el envoltorio de grabación (Task 5); `S4SalesDocumentConfigRepository` (Task 2).
- Produces:
  - `class B1DocumentBusinessPartnerResolver { findOrCreateForDocument(args) }`
  - `class S4DocumentBusinessPartnerResolver { findOrCreateForDocument(args) }`
  - `createSalesDocumentStrategy({ sapFlavor, sapConfig, sapCallRecorder, deps }) -> { documentBusinessPartnerResolver, salesDocumentBuilder, salesDocumentAdapter }`

- [ ] **Step 1: Escribir el test del resolver de S/4**

```js
// tests/unit/application/s4DocumentBusinessPartnerResolver.test.js
import { jest } from '@jest/globals';
import { S4DocumentBusinessPartnerResolver } from '../../../src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js';

const COMPANY_MAPPINGS = [
  { sourceField: 'BusinessPartner', targetField: 'idsap', isActive: true },
  { sourceField: 'BusinessPartnerFullName', targetField: 'name', isActive: true },
  { sourceField: 'to_Customer.BPTaxLongNumber', targetField: 'cedula', isActive: true },
];

const CREATION_CONFIG = {
  findFallbackField: 'to_Customer.BPTaxLongNumber',
  defaults: {
    BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
    BusinessPartnerRole: ['FLCU00'],
    Customer: { CustomerAccountGroup: 'ZC01' },
    CustomerCompany: { CompanyCode: '1000' },
    CustomerSalesArea: { Currency: 'GTQ' },
  },
};

function buildArgs(overrides = {}) {
  return {
    company: { idsap: '', name: 'ACME S.A.', cedula: '1234567-8' },
    contact: null,
    companyExists: true,
    contactExists: false,
    payload: { deal: { hs_object_id: '77' } },
    context: {
      mappings: { companyMappings: COMPANY_MAPPINGS },
      tenantModels: {},
      hubspotCredentials: { _id: 'cred-1' },
    },
    auditTrail: { payload_SAP: {}, response_SAP: {} },
    salesArea: { salesOrganization: 'MQGT', distributionChannel: '01', division: '00' },
    ...overrides,
  };
}

function buildResolver({ transport, defaultFindSAP = 'BusinessPartner' }) {
  return new S4DocumentBusinessPartnerResolver({
    transport,
    runtimeRepository: {
      resolveDefaultFindSAP: async () => defaultFindSAP,
    },
    salesDocumentConfigRepository: {
      getBusinessPartnerCreationConfig: async () => CREATION_CONFIG,
    },
    hubspotWebhookAdapter: {
      getAccessToken: async () => 'token-1',
      updateBusinessPartnerIds: async () => ({ company: { ok: true } }),
    },
    webhookReferenceRepository: { persistReferences: jest.fn() },
    logger: { warn: jest.fn(), info: jest.fn() },
  });
}

describe('S4DocumentBusinessPartnerResolver', () => {
  it('encuentra el cliente por clave cuando defaultFindSAP es BusinessPartner', async () => {
    const request = jest.fn().mockResolvedValue({ BusinessPartner: '100053' });
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '100053', name: 'ACME S.A.' },
    }));

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get',
      path: "/API_BUSINESS_PARTNER/A_BusinessPartner('100053')",
    }));
    expect(result.cardCode).toBe('100053');
    expect(result.businessPartnerResult.created).toBe(false);
    expect(result.businessPartnerResult.matchedBy).toBe('BusinessPartner');
  });

  // El resolver NO crea contactos en S/4 (D6 del spec): un contacto es otro BusinessPartner
  // con relación BUR001, un segundo deep create que esta entrega no hace.
  it('nunca devuelve ContactEmployees', async () => {
    const resolver = buildResolver({ transport: { request: async () => ({ BusinessPartner: '100053' }) } });

    const result = await resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '100053', name: 'ACME' },
      contact: { email: 'a@b.com' },
      contactExists: true,
    }));

    expect(result.contactEmployeeResult).toEqual({
      created: false, internalCode: null, internalCodes: [], requestPayload: null,
      responsePayload: null, updateResults: [],
    });
    expect(result.contactEmployeeFailures).toEqual([]);
    expect(result.dealContactIsContactEmployee).toBe(false);
  });

  it('cae al campo de fallback cuando el primario no trae valor', async () => {
    const request = jest.fn().mockResolvedValue({ value: [{ BusinessPartner: '100099' }] });
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs());

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: expect.objectContaining({
        $filter: "to_Customer/BPTaxLongNumber eq '1234567-8'",
        $top: 1,
      }),
    }));
    expect(result.cardCode).toBe('100099');
    expect(result.businessPartnerResult.matchedBy).toBe('to_Customer.BPTaxLongNumber');
  });

  it('crea el cliente cuando ninguna búsqueda lo encuentra', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce({ BusinessPartner: '100100' });
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs());

    const createCall = request.mock.calls[1][0];
    expect(createCall.method).toBe('post');
    expect(createCall.path).toBe('/API_BUSINESS_PARTNER/A_BusinessPartner');
    expect(createCall.body).toMatchObject({
      OrganizationBPName1: 'ACME S.A.',
      BusinessPartnerGrouping: 'ZC01',
      to_Customer: {
        to_CustomerSalesArea: [expect.objectContaining({ SalesOrganization: 'MQGT' })],
      },
    });
    expect(result.cardCode).toBe('100100');
    expect(result.businessPartnerResult.created).toBe(true);
  });

  it('escribe el id del cliente de vuelta en HubSpot cuando lo creó', async () => {
    const updateBusinessPartnerIds = jest.fn().mockResolvedValue({ company: { ok: true } });
    const resolver = new S4DocumentBusinessPartnerResolver({
      transport: {
        request: jest.fn()
          .mockResolvedValueOnce({ value: [] })
          .mockResolvedValueOnce({ BusinessPartner: '100100' }),
      },
      runtimeRepository: { resolveDefaultFindSAP: async () => 'BusinessPartner' },
      salesDocumentConfigRepository: { getBusinessPartnerCreationConfig: async () => CREATION_CONFIG },
      hubspotWebhookAdapter: { getAccessToken: async () => 'token-1', updateBusinessPartnerIds },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      logger: { warn: jest.fn() },
    });

    const result = await resolver.findOrCreateForDocument(buildArgs());

    expect(updateBusinessPartnerIds).toHaveBeenCalledWith(expect.objectContaining({
      cardCode: '100100',
      syncCompany: true,
      syncContact: false,
    }));
    expect(result.hubspotToken).toBe('token-1');
  });

  it('deja el payload y la respuesta de la creación en el audit trail', async () => {
    const resolver = buildResolver({
      transport: {
        request: jest.fn()
          .mockResolvedValueOnce({ value: [] })
          .mockResolvedValueOnce({ BusinessPartner: '100100' }),
      },
    });
    const args = buildArgs();

    await resolver.findOrCreateForDocument(args);

    expect(args.auditTrail.payload_SAP.businessPartner).toMatchObject({ OrganizationBPName1: 'ACME S.A.' });
    expect(args.auditTrail.response_SAP.businessPartner).toEqual({ BusinessPartner: '100100' });
  });

  it('propaga el error permanente cuando no hay nombre para crear', async () => {
    const resolver = buildResolver({ transport: { request: async () => ({ value: [] }) } });

    await expect(resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '', cedula: '1234567-8' },
    }))).rejects.toThrow(/nombre/i);
  });
});
```

**Nota para el implementador:** en un `$filter` de OData la navegación se escribe con **barra**
(`to_Customer/BPTaxLongNumber`), no con punto. El punto es solo la convención del `sourceField`
del FieldMapping. La conversión es un `split('.').join('/')`.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/application/s4DocumentBusinessPartnerResolver.test.js`

Esperado: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementar el resolver de B1 (delegación pura)**

```js
// src/application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js
import { resolveBusinessPartnerForDocument } from '../webhookQuotationSupport.js';

// Delegación PURA: el cuerpo de resolveBusinessPartnerForDocument no se toca. Esta clase solo
// existe para que el camino de B1 entre por el mismo puerto que el de S/4, y así el caso de
// uso no tenga un `if (flavor)` adentro.
export class B1DocumentBusinessPartnerResolver {
  constructor({
    hubspotWebhookAdapter,
    runtimeRepository,
    webhookReferenceRepository,
    businessPartnerPayloadStrategyFactory,
    logger,
  }) {
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.runtimeRepository = runtimeRepository;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.businessPartnerPayloadStrategyFactory = businessPartnerPayloadStrategyFactory;
    this.logger = logger;
  }

  // `sapOrderAdapter` llega por argumento, no por constructor: el caso de uso lo envuelve con
  // el grabador de auditoría por evento, así que la instancia cambia en cada ejecución.
  async findOrCreateForDocument({
    sapOrderAdapter,
    WebhookEvent,
    eventId,
    payload,
    company,
    contact,
    companyExists,
    contactExists,
    contactEmployees,
    bpAddress,
    context,
    auditTrail,
  }) {
    return resolveBusinessPartnerForDocument({
      sapOrderAdapter,
      hubspotWebhookAdapter: this.hubspotWebhookAdapter,
      runtimeRepository: this.runtimeRepository,
      webhookReferenceRepository: this.webhookReferenceRepository,
      businessPartnerPayloadStrategyFactory: this.businessPartnerPayloadStrategyFactory,
      logger: this.logger,
      WebhookEvent,
      eventId,
      payload,
      company,
      contact,
      companyExists,
      contactExists,
      contactEmployees,
      bpAddress,
      context,
      auditTrail,
    });
  }
}

export default B1DocumentBusinessPartnerResolver;
```

- [ ] **Step 4: Implementar el resolver de S/4**

```js
// src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js
import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import { buildS4BusinessPartnerCreatePayload } from '#domain/business-partners/s4-business-partner-payload.service.js';
import { resolveBusinessPartnerSyncPlan } from '#application/use-cases/webhookQuotationSupport.js';
import { escapeODataString, toNonEmptyString } from '#shared/utils/string.utils.js';

const BUSINESS_PARTNER_PATH = '/API_BUSINESS_PARTNER/A_BusinessPartner';
const BUSINESS_PARTNER_KEY_FIELD = 'BusinessPartner';

// S/4 no tiene ContactEmployees: un contacto es otro BusinessPartner con relación BUR001.
// Esta entrega no los crea (D6 del spec), así que el resultado es siempre este objeto vacío,
// con la MISMA forma que devuelve el camino de B1 para que el caso de uso no distinga.
const EMPTY_CONTACT_EMPLOYEE_RESULT = Object.freeze({
  created: false,
  internalCode: null,
  internalCodes: [],
  requestPayload: null,
  responsePayload: null,
  updateResults: [],
});

// El sourceField del FieldMapping usa punto ('to_Customer.BPTaxLongNumber'); un $filter de
// OData usa barra. Sin esta conversión el gateway devuelve 400 por sintaxis.
function toODataPath(field) {
  return String(field).split('.').join('/');
}

export class S4DocumentBusinessPartnerResolver {
  constructor({
    transport,
    runtimeRepository,
    salesDocumentConfigRepository,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    logger = { warn: () => {} },
  }) {
    if (!transport) {
      throw new Error('transport is required for S4DocumentBusinessPartnerResolver');
    }
    this.transport = transport;
    this.runtimeRepository = runtimeRepository;
    this.salesDocumentConfigRepository = salesDocumentConfigRepository;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.logger = logger;
  }

  async findByKey(businessPartner) {
    try {
      return await this.transport.request({
        method: 'get',
        path: `${BUSINESS_PARTNER_PATH}('${encodeURIComponent(businessPartner)}')`,
        query: { $select: 'BusinessPartner' },
      });
    } catch (error) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async findByField(field, value) {
    const response = await this.transport.request({
      method: 'get',
      path: BUSINESS_PARTNER_PATH,
      query: {
        $top: 1,
        $select: 'BusinessPartner',
        $filter: `${toODataPath(field)} eq '${escapeODataString(value)}'`,
      },
    });

    const rows = Array.isArray(response?.value) ? response.value : [];
    return rows[0] ?? null;
  }

  async findOrCreateForDocument({
    payload,
    company,
    contact,
    companyExists,
    context,
    auditTrail,
    salesArea,
  }) {
    const { mappings, tenantModels, hubspotCredentials } = context;
    const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings, {
      logger: this.logger,
    });

    const [defaultFindSAP, creationConfig] = await Promise.all([
      this.runtimeRepository.resolveDefaultFindSAP(tenantModels),
      this.salesDocumentConfigRepository.getBusinessPartnerCreationConfig({ tenantModels }),
    ]);

    const businessPartnerResult = await this.resolveBusinessPartner({
      mappedCompany,
      defaultFindSAP,
      creationConfig,
      salesArea,
    });

    auditTrail.payload_SAP.businessPartner = businessPartnerResult.requestPayload;
    auditTrail.response_SAP.businessPartner = businessPartnerResult.responsePayload;

    const cardCode = businessPartnerResult.cardCode;
    const syncPlan = resolveBusinessPartnerSyncPlan({
      businessPartnerResult,
      company,
      contact,
      companyExists,
      // Sin ContactEmployees no hay nada que escribirle al contacto, así que nunca se
      // sincroniza su idsap por esta vía.
      contactExists: false,
    });

    let hubspotToken = null;

    if (syncPlan.shouldSyncBusinessPartnerIds) {
      hubspotToken = await this.hubspotWebhookAdapter.getAccessToken({
        tenantModels,
        hubspotCredentials,
      });
      auditTrail.response_hubspot = await this.hubspotWebhookAdapter.updateBusinessPartnerIds({
        token: hubspotToken,
        payload,
        cardCode,
        syncCompany: syncPlan.shouldSyncCompanySapId,
        syncContact: false,
      });
    }

    return {
      cardCode,
      businessPartnerResult,
      contactEmployeeResult: { ...EMPTY_CONTACT_EMPLOYEE_RESULT },
      contactEmployeeFailures: [],
      hubspotToken,
      dealContactIsContactEmployee: false,
    };
  }

  async resolveBusinessPartner({ mappedCompany, defaultFindSAP, creationConfig, salesArea }) {
    const primaryField = toNonEmptyString(defaultFindSAP) || BUSINESS_PARTNER_KEY_FIELD;
    const primaryValue = toNonEmptyString(mappedCompany?.[primaryField]);

    if (primaryValue) {
      // La clave primaria se lee por key, que es una sola llamada y distingue 404 de "no hay
      // filas"; cualquier otro campo necesita $filter.
      const found = primaryField === BUSINESS_PARTNER_KEY_FIELD
        ? await this.findByKey(primaryValue)
        : await this.findByField(primaryField, primaryValue);

      if (found?.BusinessPartner) {
        return {
          cardCode: toNonEmptyString(found.BusinessPartner),
          created: false,
          matchedBy: primaryField,
          businessPartner: found,
          requestPayload: null,
          responsePayload: { matchedBy: primaryField, businessPartner: found },
        };
      }
    }

    const fallbackField = toNonEmptyString(creationConfig?.findFallbackField);
    const fallbackValue = fallbackField ? toNonEmptyString(mappedCompany?.[fallbackField]) : null;

    if (fallbackValue) {
      const found = await this.findByField(fallbackField, fallbackValue);

      if (found?.BusinessPartner) {
        return {
          cardCode: toNonEmptyString(found.BusinessPartner),
          created: false,
          matchedBy: fallbackField,
          businessPartner: found,
          requestPayload: null,
          responsePayload: { matchedBy: fallbackField, businessPartner: found },
        };
      }
    }

    const createPayload = buildS4BusinessPartnerCreatePayload({
      mappedCompany,
      creationConfig,
      salesArea,
      logger: this.logger,
    });

    const created = await this.transport.request({
      method: 'post',
      path: BUSINESS_PARTNER_PATH,
      body: createPayload,
    });

    const cardCode = toNonEmptyString(created?.BusinessPartner);

    if (!cardCode) {
      throw new Error('La creación del BusinessPartner en S/4 no devolvió BusinessPartner');
    }

    return {
      cardCode,
      created: true,
      matchedBy: null,
      businessPartner: created,
      requestPayload: createPayload,
      responsePayload: created,
    };
  }
}

export default S4DocumentBusinessPartnerResolver;
```

**Nota para el implementador:** si `escapeODataString` no existe con ese nombre en
`#shared/utils/string.utils.js`, revisar cómo lo importa
[SapWebhookOrderAdapter.js:60](../../../src/infrastructure/sap/SapWebhookOrderAdapter.js) y usar
el mismo símbolo. Ya está en uso ahí para el mismo propósito.

- [ ] **Step 5: Escribir el test de la factory**

```js
// tests/unit/infrastructure/salesDocumentStrategyFactory.test.js
import { jest } from '@jest/globals';
import { createSalesDocumentStrategy } from '../../../src/infrastructure/sap/salesDocuments/salesDocumentStrategyFactory.js';
import { S4SalesDocumentAdapter } from '../../../src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js';
import { B1SalesDocumentAdapter } from '../../../src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js';
import { S4DocumentBusinessPartnerResolver } from '../../../src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js';
import { B1DocumentBusinessPartnerResolver } from '../../../src/application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js';

function buildDeps() {
  return {
    quotationAdapter: { createQuotation: jest.fn() },
    hubspotWebhookAdapter: { getAccessToken: jest.fn(), updateBusinessPartnerIds: jest.fn() },
    runtimeRepository: { resolveDefaultFindSAP: jest.fn() },
    webhookReferenceRepository: { persistReferences: jest.fn() },
    businessPartnerPayloadStrategyFactory: { getStrategy: jest.fn() },
    salesDocumentConfigRepository: { getBusinessPartnerCreationConfig: jest.fn() },
    logger: { warn: jest.fn() },
  };
}

const SAP_CONFIG = { serviceLayerBaseUrl: 'https://vhmldqs4ci.example:44300' };

describe('createSalesDocumentStrategy', () => {
  it('devuelve el trío de S/4 para el flavor S4', () => {
    const strategy = createSalesDocumentStrategy({
      sapFlavor: 'S4', sapConfig: SAP_CONFIG, sapCallRecorder: null, deps: buildDeps(),
    });

    expect(strategy.salesDocumentAdapter).toBeInstanceOf(S4SalesDocumentAdapter);
    expect(strategy.documentBusinessPartnerResolver).toBeInstanceOf(S4DocumentBusinessPartnerResolver);
    expect(typeof strategy.salesDocumentBuilder.buildQuotationPayload).toBe('function');
  });

  it('devuelve el trío de B1 para el flavor B1', () => {
    const strategy = createSalesDocumentStrategy({
      sapFlavor: 'B1', sapConfig: SAP_CONFIG, sapCallRecorder: null, deps: buildDeps(),
    });

    expect(strategy.salesDocumentAdapter).toBeInstanceOf(B1SalesDocumentAdapter);
    expect(strategy.documentBusinessPartnerResolver).toBeInstanceOf(B1DocumentBusinessPartnerResolver);
  });

  // Un tenant sin la llave sapFlavor (los cuatro de producción) tiene que seguir por B1.
  it('cae a B1 con flavor ausente o inválido', () => {
    for (const sapFlavor of [undefined, null, '', 'CUALQUIERA']) {
      const strategy = createSalesDocumentStrategy({
        sapFlavor, sapConfig: SAP_CONFIG, sapCallRecorder: null, deps: buildDeps(),
      });
      expect(strategy.salesDocumentAdapter).toBeInstanceOf(B1SalesDocumentAdapter);
    }
  });
});
```

- [ ] **Step 6: Implementar la factory**

```js
// src/infrastructure/sap/salesDocuments/salesDocumentStrategyFactory.js
import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
  normalizeSapFlavor,
} from '#domain/sap/sap-flavor.constants.js';
import { assertPort } from '#application/ports/port-validator.js';
import { SapSalesDocumentPort } from '#application/ports/sap/sap-sales-document.port.js';
import { SalesDocumentBuilderPort } from '#application/ports/sap/sales-document-builder.port.js';
import { SapDocumentBusinessPartnerPort } from '#application/ports/sap/sap-document-business-partner.port.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import { buildQuotationPayload } from '#domain/orders/order-builder.service.js';
import { buildS4QuotationPayload } from '#domain/orders/s4-sales-document-builder.service.js';
import { B1SalesDocumentAdapter } from './B1SalesDocumentAdapter.js';
import { S4SalesDocumentAdapter } from './S4SalesDocumentAdapter.js';
import { wrapS4TransportWithRecorder } from './recordedS4Transport.js';
import { S4DocumentBusinessPartnerResolver } from '../customers/S4DocumentBusinessPartnerResolver.js';
import { B1DocumentBusinessPartnerResolver } from '#application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js';

// Los builders son funciones puras; el puerto pide un objeto con el método, así que se
// envuelven acá en vez de convertirlos en clases y tocar el builder de B1 que ya corre.
function wrapBuilder(build) {
  return { buildQuotationPayload: build };
}

// Devuelve el TRÍO junto a propósito: resolver, builder y adapter tienen que hablar el mismo
// modelo de entidades. Si se pidieran por separado, nada impediría combinar el builder de B1
// con el adapter de S/4, y el error aparecería recién como un rechazo del gateway.
export function createSalesDocumentStrategy({ sapFlavor, sapConfig, sapCallRecorder, deps }) {
  const flavor = normalizeSapFlavor(sapFlavor) || DEFAULT_SAP_FLAVOR;

  if (flavor === SAP_FLAVORS.S4) {
    const transport = wrapS4TransportWithRecorder(
      createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config: sapConfig }),
      sapCallRecorder
    );

    return {
      documentBusinessPartnerResolver: assertPort(
        new S4DocumentBusinessPartnerResolver({
          transport,
          runtimeRepository: deps.runtimeRepository,
          salesDocumentConfigRepository: deps.salesDocumentConfigRepository,
          hubspotWebhookAdapter: deps.hubspotWebhookAdapter,
          webhookReferenceRepository: deps.webhookReferenceRepository,
          logger: deps.logger,
        }),
        SapDocumentBusinessPartnerPort
      ),
      salesDocumentBuilder: assertPort(wrapBuilder(buildS4QuotationPayload), SalesDocumentBuilderPort),
      salesDocumentAdapter: assertPort(new S4SalesDocumentAdapter({ transport }), SapSalesDocumentPort),
    };
  }

  return {
    documentBusinessPartnerResolver: assertPort(
      new B1DocumentBusinessPartnerResolver({
        hubspotWebhookAdapter: deps.hubspotWebhookAdapter,
        runtimeRepository: deps.runtimeRepository,
        webhookReferenceRepository: deps.webhookReferenceRepository,
        businessPartnerPayloadStrategyFactory: deps.businessPartnerPayloadStrategyFactory,
        logger: deps.logger,
      }),
      SapDocumentBusinessPartnerPort
    ),
    salesDocumentBuilder: assertPort(wrapBuilder(buildQuotationPayload), SalesDocumentBuilderPort),
    salesDocumentAdapter: assertPort(
      new B1SalesDocumentAdapter({ quotationAdapter: deps.quotationAdapter }),
      SapSalesDocumentPort
    ),
  };
}

export default createSalesDocumentStrategy;
```

- [ ] **Step 7: Correr los dos tests y verificar que pasan**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/application/s4DocumentBusinessPartnerResolver.test.js tests/unit/infrastructure/salesDocumentStrategyFactory.test.js`

Esperado: PASS, 10 tests entre las dos suites.

- [ ] **Step 8: Dejar el cambio en el working tree y reportar**

---

## Task 7: Cableado en el caso de uso y la composición

**Files:**
- Modify: `src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js` (método `resolveRuntimeContext`, desde la línea 28)
- Modify: `src/application/use-cases/ProcessHubspotCreateQuotation.js`
- Modify: `src/composition/webhook-processing.composition.js:73-88` (`buildProcessHubspotCreateQuotationUseCase`)
- Test: `tests/unit/application/processQuotationFlows.test.js` (existente — agregar casos)

**Interfaces:**
- Consumes: `createSalesDocumentStrategy` (Task 6); `S4SalesDocumentConfigRepository` (Task 2); `WarehouseStockConfigRepository` existente.
- Produces: nada nuevo hacia afuera. `ProcessHubspotCreateQuotation` gana el parámetro de constructor `salesDocumentStrategyFactory`, con default a `createSalesDocumentStrategy`.

- [ ] **Step 1: Exponer `sapFlavor` en el contexto de runtime**

En `resolveRuntimeContext`, agregar la resolución del flavor junto a las demás lecturas de
configuración y devolverlo en el objeto de contexto.

```js
// Arriba del archivo, junto a los demás imports de configuración:
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';
```

```js
// Dentro de resolveRuntimeContext, antes del return del contexto:
// Ausente o inválido => B1. Los cuatro tenants de producción no tienen esta llave y tienen
// que seguir yendo por el camino de siempre.
const sapFlavor = await resolveSapFlavor({ tenantModels });
```

y sumar `sapFlavor` al objeto que retorna la función.

**Nota para el implementador:** leer primero el `return` actual de `resolveRuntimeContext` y
agregar la clave sin reordenar las existentes. No cambiar ninguna otra.

- [ ] **Step 2: Escribir el test de integración del caso de uso**

Agregar al final de `tests/unit/application/processQuotationFlows.test.js`:

```js
describe('ProcessHubspotCreateQuotation con sapFlavor S4', () => {
  it('usa el trío de S/4 y persiste el número de oferta como DocEntry y DocNum', async () => {
    const createQuotation = jest.fn().mockResolvedValue({
      DocEntry: 20000123,
      DocNum: 20000123,
      DocumentLines: [{ LineNum: 10 }],
      raw: { SalesQuotation: '20000123' },
    });
    const buildQuotationPayload = jest.fn().mockReturnValue({ SoldToParty: '100053', to_Item: [] });
    const findOrCreateForDocument = jest.fn().mockResolvedValue({
      cardCode: '100053',
      businessPartnerResult: { created: false, matchedBy: 'BusinessPartner' },
      contactEmployeeResult: { created: false, internalCodes: [] },
      contactEmployeeFailures: [],
      hubspotToken: 'token-1',
      dealContactIsContactEmployee: false,
    });
    const create = jest.fn().mockResolvedValue({});

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepositoryStub({ sapFlavor: 'S4' }),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn().mockResolvedValue({}) },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create },
      salesDocumentStrategyFactory: () => ({
        documentBusinessPartnerResolver: { findOrCreateForDocument },
        salesDocumentBuilder: { buildQuotationPayload },
        salesDocumentAdapter: { createQuotation },
      }),
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
      buildWebhookSapAudit: jest.fn().mockReturnValue({}),
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    const result = await useCase.execute(buildQuotationEvent());

    expect(createQuotation).toHaveBeenCalled();
    expect(result.docEntry).toBe(20000123);
    expect(result.docNum).toBe(20000123);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      link: expect.objectContaining({
        sapObject: 'A_SalesQuotation',
        sapBaseType: null,
        sapDocEntry: 20000123,
      }),
    }));
  });

  it('un tenant sin sapFlavor sigue por el camino de B1', async () => {
    const createQuotation = jest.fn().mockResolvedValue({ DocEntry: 55, DocNum: 900, DocumentLines: [] });
    const strategyFactory = jest.fn().mockReturnValue({
      documentBusinessPartnerResolver: {
        findOrCreateForDocument: jest.fn().mockResolvedValue({
          cardCode: 'CL001',
          businessPartnerResult: { created: false, matchedBy: 'cardCode' },
          contactEmployeeResult: { created: false, internalCodes: [] },
          contactEmployeeFailures: [],
          hubspotToken: null,
          dealContactIsContactEmployee: false,
        }),
      },
      salesDocumentBuilder: { buildQuotationPayload: jest.fn().mockReturnValue({ CardCode: 'CL001' }) },
      salesDocumentAdapter: { createQuotation },
    });

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepositoryStub({ sapFlavor: undefined }),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn().mockResolvedValue({}) },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create: jest.fn() },
      salesDocumentStrategyFactory: strategyFactory,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
      buildWebhookSapAudit: jest.fn().mockReturnValue({}),
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    await useCase.execute(buildQuotationEvent());

    expect(strategyFactory).toHaveBeenCalledWith(expect.objectContaining({ sapFlavor: undefined }));
  });
});
```

**Nota para el implementador:** `buildRuntimeRepositoryStub` y `buildQuotationEvent` son
helpers que hay que leer del archivo de test existente y extender para que el contexto
devuelto incluya `sapFlavor`. Si el archivo no los tiene con esos nombres, usar los que sí
tenga y adaptar los dos tests nuevos a esas firmas. **No reescribir los tests existentes.**

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/application/processQuotationFlows.test.js`

Esperado: FAIL en los dos casos nuevos, PASS en los existentes.

- [ ] **Step 4: Modificar el caso de uso**

1. Importar la factory y los repositorios de configuración:

```js
import { createSalesDocumentStrategy } from '#infrastructure/sap/salesDocuments/salesDocumentStrategyFactory.js';
import { S4SalesDocumentConfigRepository } from '#infrastructure/config/S4SalesDocumentConfigRepository.js';
import { WarehouseStockConfigRepository } from '#infrastructure/config/WarehouseStockConfigRepository.js';
```

2. Agregar al constructor, junto a los demás parámetros, con sus asignaciones a `this`:

```js
salesDocumentStrategyFactory = createSalesDocumentStrategy,
salesDocumentConfigRepository = new S4SalesDocumentConfigRepository(),
warehouseStockConfigRepository = new WarehouseStockConfigRepository(),
```

3. **Borrar** la línea 75 actual:

```js
const sapQuotationAdapter = sapCallRecorder.wrap(this.sapQuotationAdapter);
```

El adapter ahora se construye después de resolver el contexto, porque necesita el `sapConfig`
del tenant para armar el transporte. La línea 74 (`sapOrderAdapter`) se queda donde está: el
resolver de B1 la sigue necesitando.

4. Después de desestructurar `context` (línea 89), construir la strategy. El
`quotationAdapter` que se le pasa va **ya envuelto** por el grabador, que es lo que preserva
la auditoría que hoy daba la línea 75:

```js
const { documentBusinessPartnerResolver, salesDocumentBuilder, salesDocumentAdapter } =
  this.salesDocumentStrategyFactory({
    sapFlavor: context.sapFlavor,
    sapConfig,
    sapCallRecorder,
    deps: {
      quotationAdapter: sapCallRecorder.wrap(this.sapQuotationAdapter),
      hubspotWebhookAdapter: this.hubspotWebhookAdapter,
      runtimeRepository: this.runtimeRepository,
      webhookReferenceRepository: this.webhookReferenceRepository,
      businessPartnerPayloadStrategyFactory: this.businessPartnerPayloadStrategyFactory,
      salesDocumentConfigRepository: this.salesDocumentConfigRepository,
      logger: this.logger,
    },
  });
```

El tráfico de S/4 lo graba el transporte envuelto dentro de la factory
(`wrapS4TransportWithRecorder`), así que ninguno de los dos caminos pierde auditoría.

5. Resolver el área de ventas y la config de documento **antes** de crear el cliente, moviendo
hacia arriba el `mapHubspotToSapFields` del deal que hoy está en la línea 172:

```js
const mappedDeal = mapHubspotToSapFields(deal || {}, mappings.dealOrdersQuotationsMappings, { logger: this.logger });
const salesDocumentConfig = await this.salesDocumentConfigRepository.getSalesDocumentConfig({ tenantModels });
const salesArea = {
  salesOrganization: mappedDeal.SalesOrganization ?? salesDocumentConfig.salesOrganization,
  distributionChannel: mappedDeal.DistributionChannel ?? salesDocumentConfig.distributionChannel,
  division: mappedDeal.OrganizationDivision ?? salesDocumentConfig.division,
};
```

El área tiene que conocerse antes del alta del cliente porque el deep create lo registra en
esa área; resolverla después dejaría al cliente nuevo en un área distinta de la del documento
y SAP rechazaría la oferta con "cliente no existe en el área de ventas".

6. Reemplazar la llamada a `resolveBusinessPartnerForDocument` (líneas 119-137) por:

```js
const businessPartner = await documentBusinessPartnerResolver.findOrCreateForDocument({
  sapOrderAdapter,
  WebhookEvent,
  eventId: event?._id,
  payload,
  company,
  contact,
  companyExists,
  contactExists,
  contactEmployees,
  bpAddress,
  context,
  auditTrail,
  salesArea,
});
```

7. Reemplazar la construcción del payload y el envío (líneas 146-193). El bloque de
`mapDocumentLines` queda solo para B1: en S/4 las posiciones las arma su propio builder desde
los `lineItems` crudos.

```js
const documentLines = context.sapFlavor === 'S4' ? [] : mapDocumentLines({
  lineItems,
  productMappings: mappings.productMappings,
  lineMappings: mappings.productOrdersQuotationsMappings,
  taxCodes,
  miscPriceCalculationConfig,
  discountConfig,
  logger: this.logger,
});

const { rawFields: warehouseFields } = await this.warehouseStockConfigRepository
  .getWarehouseStockConfig({ tenantModels });

const groupCodeDefaults = await this.runtimeRepository.resolveGroupCodeDefaults(tenantModels);

const quotationPayload = salesDocumentBuilder.buildQuotationPayload({
  // B1
  cardCode,
  documentLines,
  slpCode,
  documentsOwner,
  paymentGroupCode: resolvePaymentGroupCode({ mappedDeal, groupCodeDefaults }),
  mappedDealFields: mappedDeal,
  // S/4
  soldToParty: cardCode,
  lineItems,
  productMappings: mappings.productMappings,
  lineMappings: mappings.productOrdersQuotationsMappings,
  salesDocumentConfig,
  warehouseFields: Array.isArray(warehouseFields) ? warehouseFields : [],
  salesPersonId: slpCode === null ? null : String(slpCode),
  logger: this.logger,
});

auditTrail.payload_SAP.quotation = quotationPayload;

quotationResponse = await salesDocumentAdapter.createQuotation({
  sapConfig,
  quotationPayload,
});
```

**Por qué un solo objeto de argumentos con las claves de los dos flavors:** el caso de uso no
puede ramificar por flavor sin volver a meter adentro el `if` que este diseño saca. Cada
builder desestructura lo suyo e ignora el resto, que es exactamente lo que ya hacen las
funciones de `order-builder.service.js` con sus parámetros opcionales.

8. En la creación del `SapDocumentLink` (líneas 201-217), hacer que `sapObject` y `sapBaseType`
   dependan del flavor:

```js
sapObject: context.sapFlavor === 'S4' ? 'A_SalesQuotation' : 'Quotations',
// BaseType 23 es de B1: identifica la oferta como documento base de una conversión. En S/4 no
// significa nada, y guardarlo haría creer que se puede convertir por ese camino.
sapBaseType: context.sapFlavor === 'S4' ? null : 23,
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/application/processQuotationFlows.test.js`

Esperado: PASS, los existentes **y** los dos nuevos.

- [ ] **Step 6: Cablear la composición**

En `buildProcessHubspotCreateQuotationUseCase`
([webhook-processing.composition.js:73](../../../src/composition/webhook-processing.composition.js)),
agregar al objeto que se le pasa al constructor:

```js
salesDocumentStrategyFactory: createSalesDocumentStrategy,
salesDocumentConfigRepository: new S4SalesDocumentConfigRepository(),
warehouseStockConfigRepository: new WarehouseStockConfigRepository(),
```

con sus imports arriba. **No tocar las otras cinco funciones `build*UseCase`.**

- [ ] **Step 7: Verificación obligatoria de cableado**

Run: `grep -n "salesDocumentStrategyFactory\|salesDocumentConfigRepository\|warehouseStockConfigRepository" src/composition/webhook-processing.composition.js`

Esperado: las tres claves presentes. Un parámetro de constructor que queda sin cablear en
composición pasa todos los tests en verde y falla solo en producción; ya pasó tres veces en
este repo. No alcanza con que el test use `expect.any(Object)`.

- [ ] **Step 8: Correr las suites de regresión**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/application tests/unit/composition tests/unit/domain/quotationBuilder.test.js tests/unit/webhookProcessor.flow.test.js`

Esperado: sin rojas nuevas respecto al baseline. Si aparece alguna, confirmar con `git stash`
+ correr + `git stash pop` si ya estaba roja antes.

- [ ] **Step 9: Correr la suite completa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js`

Esperado: 178 suites, 5 rojas — las mismas de antes. Reportar el número exacto.

- [ ] **Step 10: Dejar el cambio en el working tree y reportar**

---

## Task 8: Configuración pegable y documentación

**Files:**
- Modify: `configuration_examples.md`
- Modify: `docs/superpowers/specs/2026-09-14-s4-create-quotation-design.md` (resultados de la Tarea 0)

**Interfaces:**
- Consumes: las llaves de configuración de la Task 2.
- Produces: documentación. Ningún módulo la importa.

- [ ] **Step 1: Documentar las llaves nuevas**

Agregar a `configuration_examples.md` una entrada por cada llave —`s4SalesDocument`,
`s4BusinessPartnerCreation`, `defaultFindSAP`— siguiendo el formato que ya usa el archivo:
descripción de para qué sirve, y un ejemplo con valores reales. Leer primero una entrada
existente y copiar su estructura exacta.

- [ ] **Step 2: Escribir el JSON pegable en Compass**

Entregarlo **en el chat**, no en un archivo. Formato extended JSON (`$oid`, `$date`), sin
`ISODate()` ni `new Date()`, diciendo explícitamente qué NO tocar.

```jsonc
// Colección: Configurations, base sap_integration_multiquimica — tres documentos NUEVOS.
// No modificar los 16 documentos existentes.
{
  "key": "s4SalesDocument",
  "value": {
    "quotationType": "<PENDIENTE: clase de oferta sin documento de referencia obligatorio>",
    "salesOrganization": "<PENDIENTE>",
    "distributionChannel": "<PENDIENTE>",
    "division": "<PENDIENTE>",
    "salesPersonPartnerFunction": "VE",
    "priceConditionType": null
  },
  "userUpdated": "admin"
}
```

Los otros dos documentos (`s4BusinessPartnerCreation` y `defaultFindSAP`) con la misma forma
que la sección "Configuración nueva" del spec.

Para los `FieldMappings`, un `insertMany` con las cinco filas de la tabla del spec, cada una
con `hubspotCredentialId: {"$oid": "6a68dc4203837bce4474fd32"}`, `isActive: true`,
`editable: true`, `includeInServiceLayerSelect: false`.

- [ ] **Step 3: Actualizar el spec con el resultado de la Tarea 0**

Si la Tarea 0 llegó a correr con red, reemplazar en el spec la frase "Todo lo marcado como
'por verificar' abajo se escribió contra la documentación de las APIs de SAP" por los
hallazgos reales, y corregir cualquier nombre de campo que no haya coincidido. Si no hubo red,
dejar el spec como está y anotar la fecha del intento.

- [ ] **Step 4: Dejar el cambio en el working tree y reportar**

Reportar el resumen completo de las 8 tareas: qué se creó, qué se modificó, conteo final de la
suite, y lo que queda bloqueado (red, valores del equipo funcional, `OwnerMappings.sapOwnerId`).

---

## Cobertura del spec

| Requisito del spec | Tarea |
|---|---|
| D1 Bifurcación por puerto + factory | 5, 6, 7 |
| D2 Respuesta normalizada a forma B1 | 5 |
| D3 Área de ventas mapeo → default → error | 3 |
| D4 Precio omitido por defecto | 3 |
| D5 Vendedor por función de interlocutor | 3 |
| D6 Sin creación de contactos | 6 |
| Expansión de claves punteadas | 1 |
| Resolución y creación del cliente | 6 |
| Payload de la oferta | 3 |
| Payload de creación del cliente | 4 |
| Persistencia y write-back | 7 |
| Errores y validaciones | 3, 4, 6 |
| Configuración nueva | 2, 8 |
| Verificación en vivo | 0 |
| Regresión B1 | 3 (paso 5), 7 (pasos 8 y 9) |
