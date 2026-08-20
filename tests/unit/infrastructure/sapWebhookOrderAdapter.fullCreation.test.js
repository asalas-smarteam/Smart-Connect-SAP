import { jest } from '@jest/globals';
import SapWebhookOrderAdapter from '../../../src/infrastructure/sap/SapWebhookOrderAdapter.js';
import FullMappedBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { mapHubspotToSapFields } from '../../../src/domain/orders/order-builder.service.js';

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

// El merge `{ ...mappedContact, ...mappedCompany }` (SapWebhookOrderAdapter.js linea ~339) le da
// prioridad a la company por estar despues en el spread. Antes del fix a mapHubspotToSapFields,
// un texto "null" mal serializado por el workflow de la company SI generaba la clave en
// mappedCompany, y esa clave ganaba la mezcla aunque el contacto trajera el valor real. Ahora
// mapHubspotToSapFields filtra ese sentinel antes de que llegue aca: mappedCompany nunca tiene la
// clave, asi que el spread deja pasar el valor del contacto. Este test fija ese comportamiento de
// punta a punta (pasando por mapHubspotToSapFields real, no un mapeado a mano) porque el efecto
// depende de que la clave este AUSENTE, no de que valga null.
describe('findOrCreateBusinessPartner — el merge company+contact ante un valor sucio de la company', () => {
  it('cuando la company manda el texto "null" y el contacto un valor real, el payload final lleva el del contacto', async () => {
    const companyMappings = [{ sourceField: 'U_ACO_Telefono2', targetField: 'phone' }];
    const contactMappings = [{ sourceField: 'U_ACO_Telefono2', targetField: 'mobilephone' }];

    const mappedCompany = mapHubspotToSapFields({ phone: 'null' }, companyMappings);
    const mappedContact = mapHubspotToSapFields({ mobilephone: '8888-1234' }, contactMappings);

    // Confirma la premisa: el sentinel filtrado deja la clave ausente, no en null.
    expect(mappedCompany).not.toHaveProperty('U_ACO_Telefono2');
    expect(mappedContact.U_ACO_Telefono2).toBe('8888-1234');

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
      mappedCompany: { CardName: 'ACME', ...mappedCompany },
      mappedContact,
      payloadStrategy: new FullMappedBusinessPartnerPayloadStrategy(),
    });

    const postCall = adapter.request.mock.calls.find(([, options]) => options.method === 'post');
    expect(postCall[1].data.U_ACO_Telefono2).toBe('8888-1234');
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

  it('agrega updateResults en paralelo a results, uno por contacto', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const updateResultAna = { updated: true, requestPayload: { Name: 'Ana' }, responsePayload: {} };
    const updateResultLuis = { updated: false, requestPayload: null, responsePayload: null };
    adapter.addContactEmployeeIfNeeded = jest.fn()
      .mockResolvedValueOnce({
        created: false, internalCode: 11, requestPayload: null, responsePayload: {}, updateResult: updateResultAna,
      })
      .mockResolvedValueOnce({
        created: false, internalCode: 12, requestPayload: null, responsePayload: {}, updateResult: updateResultLuis,
      });

    const contacts = [{ firstname: 'Ana' }, { firstname: 'Luis' }];
    const result = await adapter.addContactEmployeesIfNeeded({
      sapConfig: {}, cardCode: 'CL999', businessPartner: { CardCode: 'CL999' },
      contacts, contactEmployeeMappings: [], upsertConfig: null,
    });

    expect(result.updateResults).toEqual([updateResultAna, updateResultLuis]);
  });
});

describe('addContactEmployeesIfNeeded — anti-clobber threading (real addContactEmployeeIfNeeded)', () => {
  const contactEmployeeMappings = [
    { sourceField: 'E_Mail', targetField: 'email', sourceContext: 'contactEmployee' },
    { sourceField: 'Name', targetField: 'firstname', sourceContext: 'contactEmployee' },
  ];

  it('el segundo PATCH conserva al primer contacto agregado (no lo borra)', async () => {
    const adapter = new SapWebhookOrderAdapter();
    let getCallCount = 0;

    // Modela sapWebhookOrderAdapter.contactEmployee.test.js: patch responde {},
    // y el re-GET posterior (findBusinessPartnerByCardCode) devuelve el estado
    // ya actualizado en SAP tras ese patch.
    const requestSpy = jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, options) => {
      if (options.method === 'patch') {
        return {};
      }
      getCallCount += 1;
      if (getCallCount === 1) {
        return { ContactEmployees: [{ InternalCode: 11, Name: 'Ana', E_Mail: 'ana@example.com' }] };
      }
      return {
        ContactEmployees: [
          { InternalCode: 11, Name: 'Ana', E_Mail: 'ana@example.com' },
          { InternalCode: 12, Name: 'Luis', E_Mail: 'luis@example.com' },
        ],
      };
    });

    const businessPartner = { CardCode: 'CL999', ContactEmployees: [] };
    const contacts = [
      { email: 'ana@example.com', firstname: 'Ana' },
      { email: 'luis@example.com', firstname: 'Luis' },
    ];

    const result = await adapter.addContactEmployeesIfNeeded({
      sapConfig: {},
      cardCode: 'CL999',
      businessPartner,
      contacts,
      contactEmployeeMappings,
      upsertConfig: null,
    });

    const patchCalls = requestSpy.mock.calls.filter(([, options]) => options.method === 'patch');
    expect(patchCalls).toHaveLength(2);

    // Sin el threading de la BP recargada, este segundo PATCH mandaría solo
    // a Luis (porque currentEmployees seguiría siendo el array vacío
    // original) y el PATCH real de B1 borraría a Ana de ContactEmployees.
    const secondPatchData = patchCalls[1][1].data;
    expect(secondPatchData.ContactEmployees.map((employee) => employee.Name)).toEqual(['Ana', 'Luis']);

    expect(result.internalCodes).toEqual([
      { contact: contacts[0], internalCode: 11 },
      { contact: contacts[1], internalCode: 12 },
    ]);
  });
});
