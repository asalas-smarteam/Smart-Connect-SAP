# ContactEmployees con email duplicado — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que dos ContactEmployees con el mismo email se sincronicen como DOS contactos de HubSpot — el dueño del email limpio lo conserva y el otro va con `localpart+InternalCode@domain` — buscando por `internalcode` primero y por email al final, en los dos caminos (secuencial y batch).

**Architecture:** un servicio puro nuevo (`contactEmployeeIdentity.service.js`) es la única fuente de la regla; el camino secuencial (`HandleHubspotAssociations.syncCompanyContacts`) le pasa una búsqueda por email + un Map por llamada, el batch (`SyncCompanyContactsInBatches`) le pasa el `CrmObjectIndex` (accessor nuevo `emailOwner`) + un Map por `execute`. El find de CE deja de usar `defaultFindHubspot` y pasa a orden fijo internalcode→email vía función nueva en `contact.handler.js`.

**Tech Stack:** Node ESM, jest con `--experimental-vm-modules`.

**Spec:** `docs/superpowers/specs/2026-08-25-contact-employee-email-dedup-design.md` (leerlo antes de empezar).

## Global Constraints

- Trabajar en el **checkout principal** `C:\Users\ale_1\OneDrive\Escritorio\Proyectos\SAP`, NUNCA en `.claude/worktrees/` (regla del repo; un worktree nace del último commit y deja fuera lo no commiteado).
- Jest se corre así (nunca `npm test` — en Windows lanza cmd.exe y falla):
  `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees <ruta>`
  El patrón de ignore va SIN barras (`worktrees`, no `/worktrees/`) porque las rutas llegan con backslash, y SIEMPRE con `=`.
- Baseline al 2026-08-25: **5 suites rojas preexistentes** con `--testPathIgnorePatterns=worktrees`: `tests/integration/internalTenant.test.js`, `tests/unit/application/sendMappedItemsToHubspot.test.js`, `tests/unit/lineItemPriceWebhook.service.test.js`, `tests/unit/serviceLayerFlow.test.js` (caso de fecha fija `builds dynamic ge filter using intervalMinutes`), `tests/unit/serviceLayerService.test.js`. Cualquier rojo NUEVO es del cambio.
- Verificar `git status -sb` justo ANTES de cada commit (el usuario cambia de rama en paralelo; ya se fue un commit a `main` por no verificar).
- El árbol puede traer cambios sin commitear ajenos a este plan (operador `ne`/`ne_or_null`, booleano `Active`, normalización de teléfono). En los commits de este plan, `git add` SOLO los archivos listados en cada tarea — nunca `git add -A`.
- Comentarios de código en español, siguiendo el estilo del repo (explican el porqué, no el qué).
- Normalización de claves: reutilizar `normalizeIndexKey` de `src/application/services/crmObjectIndex.service.js:4-6` (`String(v ?? '').trim().toLowerCase()`), no reinventarla.

---

### Task 1: Servicio puro `contactEmployeeIdentity.service.js`

**Files:**
- Create: `src/application/services/contactEmployeeIdentity.service.js`
- Test: `tests/unit/application/contactEmployeeIdentity.test.js`

**Interfaces:**
- Consumes: `normalizeIndexKey(value)` de `src/application/services/crmObjectIndex.service.js` (export existente).
- Produces (las tareas 3 y 4 dependen de estas firmas exactas):
  - `plusAddressEmail(email, internalCode) -> string | null`
  - `resolveContactEmployeeEmail({ email, internalCode, owner, claimedEmails }) -> string` — `owner` es `{ internalcode } | null`; `claimedEmails` es `Map<string, string>` (email normalizado → internalCode normalizado). Devuelve el email ORIGINAL intacto cuando es limpio, o el plus-addressed (lowercase) cuando hay dueño distinto.
  - `claimEmail(claimedEmails, email, internalCode) -> void` — first-claim-wins.

- [ ] **Step 1: Escribir los tests que fallan**

```js
// tests/unit/application/contactEmployeeIdentity.test.js
import {
  plusAddressEmail,
  resolveContactEmployeeEmail,
  claimEmail,
} from '../../../src/application/services/contactEmployeeIdentity.service.js';

describe('plusAddressEmail', () => {
  it('inserta el internalCode como plus addressing', () => {
    expect(plusAddressEmail('recepcion@tecnopack.net', 91643)).toBe('recepcion+91643@tecnopack.net');
    expect(plusAddressEmail('  RECEPCION@Tecnopack.NET  ', 'IC-2')).toBe('recepcion+IC-2@tecnopack.net');
  });

  it('devuelve null cuando el email base o el código no sirven', () => {
    expect(plusAddressEmail('sin-arroba', 91643)).toBeNull();
    expect(plusAddressEmail('@dominio.com', 91643)).toBeNull();
    expect(plusAddressEmail('local@', 91643)).toBeNull();
    expect(plusAddressEmail('', 91643)).toBeNull();
    expect(plusAddressEmail('a@b.com', null)).toBeNull();
    expect(plusAddressEmail('a@b.com', '  ')).toBeNull();
  });
});

describe('resolveContactEmployeeEmail', () => {
  it('sin dueño ni reclamo devuelve el email original intacto', () => {
    expect(resolveContactEmployeeEmail({
      email: 'Recepcion@Tecnopack.net',
      internalCode: 91643,
      owner: null,
      claimedEmails: new Map(),
    })).toBe('Recepcion@Tecnopack.net');
  });

  it('dueño con el MISMO internalcode conserva el email limpio (es él mismo)', () => {
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91643,
      owner: { internalcode: '91643' },
      claimedEmails: new Map(),
    })).toBe('recepcion@tecnopack.net');
  });

  it('dueño con OTRO internalcode fuerza el plus addressing', () => {
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91794,
      owner: { internalcode: '91643' },
      claimedEmails: new Map(),
    })).toBe('recepcion+91794@tecnopack.net');
  });

  it('dueño SIN internalcode (contacto manual o BP con solo idsap) también fuerza el plus', () => {
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91794,
      owner: { internalcode: undefined },
      claimedEmails: new Map(),
    })).toBe('recepcion+91794@tecnopack.net');
  });

  it('un email ya reclamado en la corrida por otro código fuerza el plus sin consultar owner', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, 'recepcion@tecnopack.net', 91643);
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91794,
      owner: null,
      claimedEmails,
    })).toBe('recepcion+91794@tecnopack.net');
  });

  it('un email reclamado por el MISMO código sigue limpio (mismo CE en dos empresas)', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, 'shared@x.com', 9);
    expect(resolveContactEmployeeEmail({
      email: 'shared@x.com',
      internalCode: 9,
      owner: null,
      claimedEmails,
    })).toBe('shared@x.com');
  });

  it('si el plus no se puede construir, conserva el email original (colapso viejo)', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, 'x@y.com', 1);
    // internalCode vacío: no hay con qué distinguirlo, mejor el comportamiento viejo
    expect(resolveContactEmployeeEmail({
      email: 'x@y.com',
      internalCode: '',
      owner: null,
      claimedEmails,
    })).toBe('x@y.com');
  });

  it('email vacío vuelve intacto', () => {
    expect(resolveContactEmployeeEmail({
      email: '',
      internalCode: 91643,
      owner: null,
      claimedEmails: new Map(),
    })).toBe('');
  });
});

describe('claimEmail', () => {
  it('normaliza y respeta first-claim-wins', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, ' A@B.com ', 'IC-1');
    claimEmail(claimedEmails, 'a@b.com', 'IC-2');
    expect(claimedEmails.get('a@b.com')).toBe('ic-1');
  });

  it('ignora emails vacíos', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, '', 1);
    claimEmail(claimedEmails, null, 1);
    expect(claimedEmails.size).toBe(0);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees tests/unit/application/contactEmployeeIdentity.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementación**

```js
// src/application/services/contactEmployeeIdentity.service.js
// Regla de identidad de los ContactEmployees frente al email único de HubSpot.
//
// HubSpot fuerza email único en contacts, pero en SAP es normal que dos
// ContactEmployees del mismo BP compartan correo (recepción, facturación...).
// La llave real de un CE es su InternalCode: cuando el email limpio ya tiene
// dueño, el CE se envía como localpart+InternalCode@domain y el dueño lo
// conserva. Vive en un servicio puro por la misma razón que
// mappingValueResolver: los caminos secuencial y batch consumen LA MISMA regla
// (duplicarla inline es el bug que ya se pagó con el mapeo de campos).
import { normalizeIndexKey } from './crmObjectIndex.service.js';

// recepcion@tecnopack.net + 91643 -> recepcion+91643@tecnopack.net.
// Misma validación de base que generateFallbackEmail (email.utils.js): si el
// email o el código no sirven devuelve null y el caller conserva el original.
export function plusAddressEmail(email, internalCode) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const code = String(internalCode ?? '').trim();

  if (!code || !normalizedEmail.includes('@')) {
    return null;
  }

  const [localPart, domain] = normalizedEmail.split('@');

  if (!localPart || !domain) {
    return null;
  }

  return `${localPart}+${code}@${domain}`;
}

// Decide el email final de UN ContactEmployee.
//
// - Sin dueño y sin reclamo en la corrida -> el email original, intacto.
// - Dueño (o reclamo) con el MISMO internalcode -> intacto: es él mismo.
// - Cualquier otro dueño (otro internalcode, un contacto sin internalcode, el
//   BP padre, otro CE anterior de la corrida) -> plus addressing.
// - Si el plus no se puede construir (código vacío, email inválido) se
//   devuelve el original: mejor el colapso viejo que inventar un email.
//
// `claimedEmails` existe porque la Search API es eventualmente consistente:
// un contacto creado hace segundos puede no aparecer en la búsqueda, así que
// los gemelos de la MISMA corrida se resuelven en memoria.
export function resolveContactEmployeeEmail({
  email,
  internalCode,
  owner = null,
  claimedEmails = new Map(),
}) {
  const emailKey = normalizeIndexKey(email);
  const codeKey = normalizeIndexKey(internalCode);

  if (!emailKey) {
    return email;
  }

  const claimedBy = claimedEmails.get(emailKey);

  if (claimedBy !== undefined) {
    if (codeKey && claimedBy === codeKey) {
      return email;
    }
    return plusAddressEmail(email, internalCode) ?? email;
  }

  if (!owner) {
    return email;
  }

  const ownerCode = normalizeIndexKey(owner.internalcode);

  if (codeKey && ownerCode === codeKey) {
    return email;
  }

  return plusAddressEmail(email, internalCode) ?? email;
}

// First-claim-wins: el primer CE que reclama un email es su dueño en la
// corrida; los siguientes con otro código reciben el plus.
export function claimEmail(claimedEmails, email, internalCode) {
  const emailKey = normalizeIndexKey(email);

  if (emailKey && !claimedEmails.has(emailKey)) {
    claimedEmails.set(emailKey, normalizeIndexKey(internalCode));
  }
}

export default {
  plusAddressEmail,
  resolveContactEmployeeEmail,
  claimEmail,
};
```

- [ ] **Step 4: Verificar que pasan**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees tests/unit/application/contactEmployeeIdentity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (antes: `git status -sb` y confirmar rama)

```bash
git add src/application/services/contactEmployeeIdentity.service.js tests/unit/application/contactEmployeeIdentity.test.js
git commit -m "feat: regla de identidad de ContactEmployees (email +InternalCode)"
```

---

### Task 2: `findByEmail` y `findContactEmployee` en `contact.handler.js`

**Files:**
- Modify: `src/infrastructure/hubspot/handlers/contact.handler.js` (después de `find`, ~línea 45; y el default export del final)
- Test: `tests/unit/infrastructure/contactEmployeeFind.test.js`

**Interfaces:**
- Consumes: `hubspotClient.findContactByProperty(token, propertyName, value, { properties })` y `findContactByEmail(token, email, { properties })` (`src/infrastructure/hubspot/hubspotClient.js:132-144`); `buildMappedSearchProperties` ya importado en el handler.
- Produces (Task 3 depende de estas firmas):
  - `findByEmail({ token, email, clientConfig, tenantModels }) -> record | null`
  - `findContactEmployee({ token, internalcode, email, clientConfig, tenantModels }) -> record | null` — internalcode PRIMERO, email al final.
- El `find` genérico (líneas 18-44, gobernado por `defaultFindHubspot`) NO se toca.

- [ ] **Step 1: Escribir el test que falla**

```js
// tests/unit/infrastructure/contactEmployeeFind.test.js
import { jest } from '@jest/globals';

// El handler importa hubspotClient y las utils de búsqueda estáticamente:
// se mockean ANTES del import dinámico del handler (patrón ESM del repo).
jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  findContactByProperty: jest.fn(async () => null),
  findContactByEmail: jest.fn(async () => null),
  createContact: jest.fn(),
  updateContact: jest.fn(),
}));

jest.unstable_mockModule(
  '../../../src/infrastructure/hubspot/handlers/utils/searchProperties.utils.js',
  () => ({ buildMappedSearchProperties: jest.fn(async () => ['email', 'internalcode']) })
);

const hubspotClient = await import('../../../src/infrastructure/hubspot/hubspotClient.js');
const { findContactEmployee, findByEmail } = await import(
  '../../../src/infrastructure/hubspot/handlers/contact.handler.js'
);

beforeEach(() => jest.clearAllMocks());

describe('findContactEmployee', () => {
  it('busca por internalcode PRIMERO y no toca el email si lo encuentra', async () => {
    hubspotClient.findContactByProperty.mockResolvedValueOnce({ id: 'hs-1' });

    const result = await findContactEmployee({
      token: 't', internalcode: 91643, email: 'recepcion@tecnopack.net', clientConfig: {}, tenantModels: {},
    });

    expect(result).toEqual({ id: 'hs-1' });
    expect(hubspotClient.findContactByProperty).toHaveBeenCalledWith(
      't', 'internalcode', '91643', { properties: ['email', 'internalcode'] }
    );
    expect(hubspotClient.findContactByEmail).not.toHaveBeenCalled();
  });

  it('cae al email al FINAL cuando el internalcode no matchea', async () => {
    hubspotClient.findContactByEmail.mockResolvedValueOnce({ id: 'hs-2' });

    const result = await findContactEmployee({
      token: 't', internalcode: 91643, email: 'recepcion@tecnopack.net', clientConfig: {}, tenantModels: {},
    });

    expect(result).toEqual({ id: 'hs-2' });
    expect(hubspotClient.findContactByEmail).toHaveBeenCalledWith(
      't', 'recepcion@tecnopack.net', { properties: ['email', 'internalcode'] }
    );
  });

  it('sin internalcode va directo al email; sin nada devuelve null', async () => {
    await findContactEmployee({ token: 't', internalcode: null, email: 'a@b.com', clientConfig: {}, tenantModels: {} });
    expect(hubspotClient.findContactByProperty).not.toHaveBeenCalled();
    expect(hubspotClient.findContactByEmail).toHaveBeenCalledTimes(1);

    const empty = await findContactEmployee({ token: 't', internalcode: '', email: '', clientConfig: {}, tenantModels: {} });
    expect(empty).toBeNull();
  });
});

describe('findByEmail', () => {
  it('delega en findContactByEmail con las search properties mapeadas', async () => {
    hubspotClient.findContactByEmail.mockResolvedValueOnce({ id: 'hs-3', properties: { internalcode: '91643' } });

    const result = await findByEmail({ token: 't', email: 'x@y.com', clientConfig: {}, tenantModels: {} });

    expect(result?.id).toBe('hs-3');
  });

  it('devuelve null sin email', async () => {
    expect(await findByEmail({ token: 't', email: '', clientConfig: {}, tenantModels: {} })).toBeNull();
    expect(hubspotClient.findContactByEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees tests/unit/infrastructure/contactEmployeeFind.test.js`
Expected: FAIL — `findContactEmployee`/`findByEmail` no exportados.

- [ ] **Step 3: Implementación** (en `contact.handler.js`, después de `find`)

```js
// Dueño actual de un email, con las search properties mapeadas (incluyen
// internalcode). Lo usa la resolución de emails duplicados de los CE.
export async function findByEmail({ token, email, clientConfig, tenantModels }) {
  if (!email) {
    return null;
  }

  const properties = await buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'contact',
    defaults: CONTACT_SEARCH_PROPERTIES,
  });

  return hubspotClient.findContactByEmail(token, email, { properties });
}

// Find de ContactEmployees con orden FIJO: internalcode primero, email al
// final. No usa defaultFindHubspot a propósito: esa config identifica BPs
// (idsap), que los CE no traen — con ella el find devolvía null siempre y
// cada corrida intentaba un create.
export async function findContactEmployee({ token, internalcode, email, clientConfig, tenantModels }) {
  const properties = await buildMappedSearchProperties({
    tenantModels,
    clientConfig,
    objectType: 'contact',
    defaults: CONTACT_SEARCH_PROPERTIES,
  });

  const code = String(internalcode ?? '').trim();

  if (code) {
    const byCode = await hubspotClient.findContactByProperty(token, 'internalcode', code, { properties });

    if (byCode) {
      return byCode;
    }
  }

  if (email) {
    return hubspotClient.findContactByEmail(token, email, { properties });
  }

  return null;
}
```

Y agregar ambos al default export:

```js
export default {
  find,
  findByEmail,
  findContactEmployee,
  create,
  update,
  getSearchProperties,
  buildBatchUpdateEntry,
};
```

- [ ] **Step 4: Verificar que pasa**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees tests/unit/infrastructure/contactEmployeeFind.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (antes: `git status -sb`)

```bash
git add src/infrastructure/hubspot/handlers/contact.handler.js tests/unit/infrastructure/contactEmployeeFind.test.js
git commit -m "feat: find de ContactEmployees por internalcode primero, email al final"
```

---

### Task 3: Camino secuencial — `HandleHubspotAssociations.syncCompanyContacts`

**Files:**
- Modify: `src/application/use-cases/HandleHubspotAssociations.js` (imports ~línea 5; `syncCompanyContacts` — Map junto a `let sapContacts;` ~línea 242, reclamo del padre tras `getBypassEmail` ~línea 276, resolución + find nuevo ~líneas 337-364)
- Modify: `tests/unit/application/syncCompanyContactsS4.test.js` (harness `contactHandler`, líneas 8-12)
- Modify: `tests/unit/application/handleHubspotAssociations.emailBypass.test.js` (mismo ajuste de harness si define `contactHandler`)
- Test: Create `tests/unit/application/handleHubspotAssociations.duplicateEmail.test.js`

**Interfaces:**
- Consumes: `resolveContactEmployeeEmail` / `claimEmail` (Task 1), `contactHandler.findByEmail` / `findContactEmployee` (Task 2), `normalizeIndexKey`.
- Produces: nada nuevo hacia afuera — `syncCompanyContacts` conserva firma y retorno `{ contactErrors }`.

- [ ] **Step 1: Escribir el test que falla**

```js
// tests/unit/application/handleHubspotAssociations.duplicateEmail.test.js
import { jest } from '@jest/globals';
import { HandleHubspotAssociations } from '../../../src/application/use-cases/HandleHubspotAssociations.js';

// Harness calcado del de syncCompanyContactsS4.test.js, con los finders nuevos.
function buildHandler() {
  const contactHandler = {
    find: jest.fn(async () => null),
    findByEmail: jest.fn(async () => null),
    findContactEmployee: jest.fn(async () => null),
    create: jest.fn(async ({ item }) => ({ id: `hs-${item.properties.internalcode}` })),
    update: jest.fn(async () => ({})),
  };
  const associationService = { associateObjectsBySapId: jest.fn(async () => ({})) };
  const associationRegistry = { registerBaseObjectMapping: jest.fn(async () => ({})) };
  const fieldMappingService = {
    getMappingsByObjectType: jest.fn(async () => [
      { sourceField: 'InternalCode', targetField: 'internalcode', sourceContext: 'contactEmployee' },
    ]),
    mapRecords: jest.fn(async (records) => records.map((r) => ({
      properties: { internalcode: r.InternalCode, firstname: r.Name, email: r.E_Mail ?? '' },
    }))),
  };

  const handler = new HandleHubspotAssociations({
    associationFetcher: { fetch: jest.fn() },
    associationRegistry,
    associationService,
    fieldMappingService,
    contactHandler,
    fallbackEmailGenerator: () => '',
    bypassEmailConfigRepository: { isBypassEmailEnabled: async () => false },
    syncWarningRepository: { record: jest.fn(async () => ({})) },
    logger: { warn: jest.fn(), error: jest.fn() },
  });

  return { handler, contactHandler, associationService, associationRegistry };
}

const clientConfig = { hubspotCredentialId: 'cred-1' };

function buildCompanyItem(contactEmployees) {
  return {
    properties: { idsap: 'CLO061498' },
    rawSapData: { CardCode: 'CLO061498', EmailAddress: 'recepcion@tecnopack.net', ContactEmployees: contactEmployees },
  };
}

describe('syncCompanyContacts — emails duplicados entre ContactEmployees', () => {
  it('el primero conserva el email limpio y el segundo va con +InternalCode', async () => {
    const { handler, contactHandler } = buildHandler();

    const { contactErrors } = await handler.syncCompanyContacts({
      token: 't',
      item: buildCompanyItem([
        { InternalCode: 91643, Name: 'Marleni', E_Mail: 'recepcion@tecnopack.net' },
        { InternalCode: 91794, Name: 'Sofia', E_Mail: 'recepcion@tecnopack.net' },
      ]),
      clientConfig,
      tenantModels: {},
      companyHubspotId: 'hs-co-1',
    });

    expect(contactErrors).toEqual([]);
    const emails = contactHandler.create.mock.calls.map(([{ item }]) => item.properties.email);
    expect(emails).toEqual(['recepcion@tecnopack.net', 'recepcion+91794@tecnopack.net']);
  });

  it('si el email limpio ya es de otro contacto en HubSpot, aplica el plus', async () => {
    const { handler, contactHandler } = buildHandler();
    contactHandler.findByEmail.mockResolvedValueOnce({
      id: 'hs-viejo',
      properties: { internalcode: '99999', email: 'recepcion@tecnopack.net' },
    });

    await handler.syncCompanyContacts({
      token: 't',
      item: buildCompanyItem([{ InternalCode: 91643, Name: 'Marleni', E_Mail: 'recepcion@tecnopack.net' }]),
      clientConfig,
      tenantModels: {},
      companyHubspotId: 'hs-co-1',
    });

    expect(contactHandler.create.mock.calls[0][0].item.properties.email)
      .toBe('recepcion+91643@tecnopack.net');
  });

  it('el dueño del email limpio (mismo internalcode) lo conserva y se actualiza', async () => {
    const { handler, contactHandler } = buildHandler();
    contactHandler.findByEmail.mockResolvedValue({
      id: 'hs-mismo',
      properties: { internalcode: '91643', email: 'recepcion@tecnopack.net' },
    });
    contactHandler.findContactEmployee.mockResolvedValue({
      id: 'hs-mismo',
      properties: { internalcode: '91643', email: 'recepcion@tecnopack.net' },
    });

    await handler.syncCompanyContacts({
      token: 't',
      item: buildCompanyItem([{ InternalCode: 91643, Name: 'Marleni', E_Mail: 'recepcion@tecnopack.net' }]),
      clientConfig,
      tenantModels: {},
      companyHubspotId: 'hs-co-1',
    });

    expect(contactHandler.create).not.toHaveBeenCalled();
    expect(contactHandler.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'hs-mismo' }));
    // El find del CE va por findContactEmployee (internalcode primero), no por el find genérico.
    expect(contactHandler.findContactEmployee).toHaveBeenCalledWith(expect.objectContaining({
      internalcode: 91643,
    }));
    expect(contactHandler.find).not.toHaveBeenCalled();
  });

  it('padre contact: el CE con el mismo email del padre se separa con +InternalCode y se asocia', async () => {
    const { handler, contactHandler, associationService } = buildHandler();

    await handler.syncCompanyContacts({
      token: 't',
      item: {
        properties: { idsap: 'BP-P1', email: 'na@gmail.com' },
        rawSapData: { CardCode: 'BP-P1', EmailAddress: 'na@gmail.com', ContactEmployees: [
          { InternalCode: 91643, Name: 'LUIS GOMEZ', E_Mail: 'na@gmail.com' },
        ] },
      },
      clientConfig,
      tenantModels: {},
      companyHubspotId: 'hs-parent-contact',
      parentObjectType: 'contact',
    });

    expect(contactHandler.create.mock.calls[0][0].item.properties.email).toBe('na+91643@gmail.com');
    expect(associationService.associateObjectsBySapId).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees tests/unit/application/handleHubspotAssociations.duplicateEmail.test.js`
Expected: FAIL — el segundo create sale con el email limpio (sin plus) y `findContactEmployee` nunca se llama.

- [ ] **Step 3: Implementación en `HandleHubspotAssociations.js`**

Imports (junto al de `buildCompanyContactPayload`, línea 5):

```js
import {
  claimEmail,
  resolveContactEmployeeEmail,
} from '#application/services/contactEmployeeIdentity.service.js';
import { normalizeIndexKey } from '#application/services/crmObjectIndex.service.js';
```

En `syncCompanyContacts`, junto a las declaraciones previas al `try` de setup (línea ~242, donde están `let sapContacts;` etc.):

```js
    // Emails reclamados en ESTA llamada. Vive acá y no en la instancia: el
    // use-case se comparte entre tenants. Cubre a los gemelos del mismo BP;
    // entre BPs lo cubre la búsqueda, con el 409 del create como respaldo
    // para la ventana de consistencia eventual de la Search API.
    const claimedEmails = new Map();
```

Dentro del `try` de setup, después de `bypassEmail = await this.getBypassEmail({ tenantModels });` (línea ~276):

```js
      // Un BP persona ya existe como contacto con su propio email: cualquier
      // CE que lo comparta debe separarse con +InternalCode, no resolverse al
      // padre (era el caso "auto-asociación -> skip" que dejaba al CE sin crear).
      if (parentObjectType === 'contact') {
        claimEmail(claimedEmails, item?.properties?.email, '#parent');
      }
```

Dentro del loop por CE, DESPUÉS del bloque `if (!contactPayload.properties.email && !emailWasBypassed) { ... continue; }` (líneas 337-357) y ANTES del find (línea 358):

```js
        // Resolución de email duplicado: el dueño del email limpio lo
        // conserva; cualquier otro CE va con localpart+InternalCode@domain.
        if (contactPayload.properties.email) {
          const cleanEmail = contactPayload.properties.email;
          // El código del CE en el espacio del payload (en B1 y S/4 coincide
          // con sapInternalCode; el payload manda porque es lo que HubSpot
          // guarda en `internalcode` y contra lo que se compara al dueño).
          const ceCode = contactPayload.properties.internalcode ?? sapInternalCode;

          let owner = null;
          if (!claimedEmails.has(normalizeIndexKey(cleanEmail))) {
            const ownerRecord = await this.contactHandler.findByEmail({
              token,
              email: cleanEmail,
              clientConfig,
              tenantModels,
            });
            owner = ownerRecord
              ? { internalcode: ownerRecord.properties?.internalcode }
              : null;
          }

          const resolvedEmail = resolveContactEmployeeEmail({
            email: cleanEmail,
            internalCode: ceCode,
            owner,
            claimedEmails,
          });

          if (resolvedEmail !== cleanEmail) {
            this.logger.warn?.('Contact employee con email duplicado: se aplica plus addressing', {
              sapInternalCode,
              sapCompanyId,
              cleanEmail,
              resolvedEmail,
            });
          }

          contactPayload.properties.email = resolvedEmail;
          claimEmail(claimedEmails, resolvedEmail, ceCode);
        }
```

Reemplazar el find del CE (líneas 358-364, `const existingContact = await this.contactHandler.find({...})`):

```js
        const existingContact = await this.contactHandler.findContactEmployee({
          token,
          internalcode: contactPayload.properties.internalcode ?? sapInternalCode,
          email: contactPayload.properties.email,
          clientConfig,
          tenantModels,
        });
```

- [ ] **Step 4: Actualizar los harnesses existentes**

En `tests/unit/application/syncCompanyContactsS4.test.js` (líneas 8-12) y en `tests/unit/application/handleHubspotAssociations.emailBypass.test.js` (si su mock de `contactHandler` no los tiene), agregar al mock:

```js
    findByEmail: jest.fn(async () => null),
    findContactEmployee: jest.fn(async () => null),
```

- [ ] **Step 5: Verificar**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees tests/unit/application/handleHubspotAssociations.duplicateEmail.test.js tests/unit/application/syncCompanyContactsS4.test.js tests/unit/application/handleHubspotAssociations.emailBypass.test.js`
Expected: PASS los tres. Si algún caso de S4/emailBypass asserta llamadas a `contactHandler.find` para CEs, actualizar esa aserción a `findContactEmployee` (el flujo BP no cambia).

- [ ] **Step 6: Commit** (antes: `git status -sb`)

```bash
git add src/application/use-cases/HandleHubspotAssociations.js tests/unit/application/handleHubspotAssociations.duplicateEmail.test.js tests/unit/application/syncCompanyContactsS4.test.js tests/unit/application/handleHubspotAssociations.emailBypass.test.js
git commit -m "feat: emails duplicados de ContactEmployees se separan con +InternalCode (secuencial)"
```

---

### Task 4: Camino batch — `CrmObjectIndex.emailOwner` + resolución en el loop de claims

**Files:**
- Modify: `src/application/services/crmObjectIndex.service.js` (método nuevo tras `find`, ~línea 117)
- Modify: `src/application/use-cases/SyncCompanyContactsInBatches.js` (import; loop de claims, líneas 205-215)
- Modify: `tests/unit/application/crmObjectIndex.test.js` (casos de `emailOwner`)
- Modify: `tests/unit/application/syncCompanyContactsInBatches.test.js` (reescribir la guarda de regresión de la línea 612; verificar 110/239/311/644)

**Interfaces:**
- Consumes: `resolveContactEmployeeEmail` / `claimEmail` (Task 1), `normalizeIndexKey`.
- Produces: `CrmObjectIndex.emailOwner(email) -> record | null` (solo lectura del tier único de email).

- [ ] **Step 1: Test de `emailOwner` que falla** (agregar a `tests/unit/application/crmObjectIndex.test.js`, siguiendo el estilo de sus describes existentes)

```js
describe('emailOwner', () => {
  it('devuelve el dueño actual de un email del tier único', () => {
    const index = new CrmObjectIndex({
      records: [{ id: 'hs-1', properties: { internalcode: 'IC-1', email: 'Shared@X.com' } }],
      identityProperty: 'internalcode',
      uniqueProperties: ['email'],
    });

    expect(index.emailOwner(' shared@x.COM ')?.id).toBe('hs-1');
    expect(index.emailOwner('libre@x.com')).toBeNull();
    expect(index.emailOwner('')).toBeNull();
  });

  it('devuelve null cuando el índice no declara email como único (companies)', () => {
    const index = new CrmObjectIndex({
      records: [{ id: 'hs-1', properties: { idsap: 'C1', email: 'a@b.com' } }],
      identityProperty: 'idsap',
      uniqueProperties: [],
    });

    expect(index.emailOwner('a@b.com')).toBeNull();
  });
});
```

- [ ] **Step 2: Verificar que falla, implementar `emailOwner`**

```js
  // Dueño actual de un email según el tier único. Solo lectura: la resolución
  // de emails duplicados de los CE decide con esto si aplica +InternalCode
  // ANTES de find(), así el tier único solo matchea cuando es el mismo contacto.
  emailOwner(email) {
    const bucket = this.byUnique.get('email');

    if (!bucket) {
      return null;
    }

    const key = normalizeIndexKey(email);

    return key ? (bucket.get(key) ?? null) : null;
  }
```

Run de nuevo: PASS.

- [ ] **Step 3: Resolución en `SyncCompanyContactsInBatches`**

Import (junto a los de la cabecera):

```js
import {
  claimEmail,
  resolveContactEmployeeEmail,
} from '#application/services/contactEmployeeIdentity.service.js';
```

(`normalizeIndexKey` ya está importado en este archivo desde `crmObjectIndex.service.js`; si no, agregarlo al mismo import.)

En `execute`, junto a los maps del loop (líneas 198-205, donde ya están `claimedBy` y `collisions`):

```js
    // Emails reclamados en ESTA corrida, para la regla +InternalCode.
    const claimedEmails = new Map();
```

Al inicio del `for (const entry of entries)` (línea 207), reemplazando la línea existente `const properties = entry.contactPayload?.properties;` y ANTES de `const existing = index.find(properties)`:

```js
      const properties = entry.contactPayload?.properties;

      // Resolución de email duplicado ANTES de find(): con el email ya
      // resuelto, el tier único de email solo matchea cuando es el mismo
      // contacto, y la fila que hoy va a un create condenado al 409 llega con
      // +InternalCode y entra.
      if (properties?.email) {
        const cleanEmail = properties.email;
        const emailKey = normalizeIndexKey(cleanEmail);
        const ownerRecord = claimedEmails.has(emailKey) ? null : index.emailOwner(cleanEmail);
        const owner = ownerRecord
          ? { internalcode: ownerRecord.properties?.internalcode }
          : null;
        const ceCode = properties.internalcode ?? entry.sapInternalCode;

        const resolvedEmail = resolveContactEmployeeEmail({
          email: cleanEmail,
          internalCode: ceCode,
          owner,
          claimedEmails,
        });

        if (resolvedEmail !== cleanEmail) {
          this.logger.warn?.('Contact employee con email duplicado: se aplica plus addressing', {
            sapInternalCode: entry.sapInternalCode,
            cleanEmail,
            resolvedEmail,
          });
          properties.email = resolvedEmail;
          // El email limpio sigue duplicado EN SAP: el reporte de calidad de
          // datos lo tiene que seguir mostrando aunque el sync ya lo resuelva.
          collisions.get(`email:${emailKey}`)?.entries.push(entry);
        }

        claimEmail(claimedEmails, resolvedEmail, ceCode);
      }
```

- [ ] **Step 4: Reescribir la guarda de regresión del colapso**

En `tests/unit/application/syncCompanyContactsInBatches.test.js`, el caso de la línea 612 (`does not create a second contact for a row whose email an internalcode row already claimed`) describe el comportamiento viejo. Reemplazarlo por:

```js
  it('separa con +InternalCode la fila cuyo email ya reclamó otra fila de la corrida', async () => {
    const useCase = buildUseCase();
    useCase.fieldMappingService.mapRecords.mockResolvedValue([
      { properties: { firstname: 'Ana', internalcode: 'IC-1' } },
      { properties: { firstname: 'Ana again' } },
    ]);

    const companies = [{
      hubspotId: 'hs-co-1',
      item: {
        properties: {},
        rawSapData: {
          CardCode: 'C1',
          ContactEmployees: [
            { InternalCode: 1, E_Mail: 'ana@x.com' },
            { InternalCode: 2, E_Mail: 'ana@x.com' },
          ],
        },
      },
    }];

    await useCase.execute({ companies, clientConfig, tenantModels: {}, getToken, syncLogId: null });

    // Antes colapsaban en un solo contacto; ahora la segunda fila conserva su
    // identidad: mismo email en SAP != mismo contacto en HubSpot. La segunda
    // fila no trae internalcode en el payload, así que el sufijo sale de su
    // sapInternalCode (2).
    const inputs = useCase.crmBatchClient.batchCreateObjects.mock.calls[0][2].inputs;
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.properties.email).sort()).toEqual(['ana+2@x.com', 'ana@x.com']);
    const mappings = useCase.associationRegistry.registerBaseObjectMappings.mock.calls
      .flatMap((call) => call[2]);
    expect(mappings).toContainEqual({ sapId: 1, hubspotId: 'hs-c-0' });
    expect(mappings).toContainEqual({ sapId: 2, hubspotId: 'hs-c-1' });
  });
```

Nota: los ids `hs-c-0`/`hs-c-1` siguen la convención del mock de `batchCreateObjects` de ese archivo; si el harness numera distinto, ajustar a lo que devuelva el mock, no al revés.

- [ ] **Step 5: Correr la suite batch completa y validar los casos vecinos**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees tests/unit/application/syncCompanyContactsInBatches.test.js tests/unit/application/crmObjectIndex.test.js`
Expected: PASS, verificando específicamente que estos casos existentes siguen verdes con la lógica nueva (si alguno cambia, revisar la implementación antes de tocar el test — sus expectativas SIGUEN siendo válidas):
- `dedupes contacts sharing an email but associates every company` (línea 110): el MISMO CE (mismo InternalCode) en dos empresas sigue colapsando en un contacto.
- `reports two SAP contacts sharing an email as a duplicate report` (línea 239): el reporte se sigue generando (por el push a `collisions` del Step 3).
- `does not report twins that collapse into one contact as duplicates` (línea 311).
- `creates a row carrying its own distinct internalcode even when an earlier row claimed its email` (línea 644): sigue creando la fila IC-2 (ahora con email `x+ic-2@x.com`; el caso no asserta el email).
- `links a conflicting child contact to the id HubSpot named instead of duplicating it` (línea 207): el respaldo del 409 no se toca.

- [ ] **Step 6: Commit** (antes: `git status -sb`)

```bash
git add src/application/services/crmObjectIndex.service.js src/application/use-cases/SyncCompanyContactsInBatches.js tests/unit/application/crmObjectIndex.test.js tests/unit/application/syncCompanyContactsInBatches.test.js
git commit -m "feat: emails duplicados de ContactEmployees se separan con +InternalCode (batch)"
```

---

### Task 5: Suite completa y verificación contra baseline

**Files:** ninguno nuevo.

- [ ] **Step 1: Correr TODA la suite del checkout principal**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=worktrees`
Expected: exactamente las 5 suites rojas del baseline (ver Global Constraints), ninguna nueva. Si aparece un rojo nuevo, es del cambio: arreglarlo antes de seguir.

- [ ] **Step 2: Verificación manual (la hace el usuario)**

El usuario prueba con `POST /sap-sync/run` dejando activa solo la config de empresas de Printer (su flujo habitual). Resultado esperado con `CLO061498`: dos contactos en HubSpot — `recepcion@tecnopack.net` (quien hoy sea su dueño) y `recepcion+<InternalCode>@tecnopack.net` — ambos asociados a la empresa. Requiere reiniciar el proceso antes (los módulos se leen al importar).

- [ ] **Step 3: Cierre**

`git status -sb`; si quedó algo del plan sin commitear, commitearlo con el mensaje de su tarea. El push y el PR los maneja el usuario (no hay `gh` CLI): dejarle en el chat el título y cuerpo del PR pegables.
