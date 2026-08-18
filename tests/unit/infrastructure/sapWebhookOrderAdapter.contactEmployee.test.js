import { jest } from '@jest/globals';
import { SapWebhookOrderAdapter } from '#infrastructure/sap/SapWebhookOrderAdapter.js';

describe('SapWebhookOrderAdapter.addContactEmployeeIfNeeded', () => {
  it('does not send EmailAddress on the ContactEmployee payload (SAP B1 rejects it)', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, { method }) => {
      if (method === 'patch') {
        return {};
      }
      // refetch after patch
      return { ContactEmployees: [] };
    });

    const businessPartner = { ContactEmployees: [] };
    const contact = { email: 'nuevo.contacto@example.com', firstname: 'Nuevo' };

    await adapter.addContactEmployeeIfNeeded({
      sapConfig: { serviceLayerBaseUrl: 'https://sap.example.com:50000' },
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings: [
        { sourceField: 'E_Mail', targetField: 'email', sourceContext: 'contactEmployee' },
        { sourceField: 'Name', targetField: 'firstname', sourceContext: 'contactEmployee' },
      ],
    });

    const patchCall = requestSpy.mock.calls.find(([, options]) => options.method === 'patch');
    expect(patchCall).toBeDefined();

    const [, { data }] = patchCall;
    const newEmployee = data.ContactEmployees[data.ContactEmployees.length - 1];

    expect(newEmployee).not.toHaveProperty('EmailAddress');
    expect(newEmployee.E_Mail).toBe('nuevo.contacto@example.com');
  });
});

describe('SapWebhookOrderAdapter.addContactEmployeeIfNeeded matching por InternalCode', () => {
  const mappingsWithInternalCode = [
    { sourceField: 'E_Mail', targetField: 'email', sourceContext: 'contactEmployee' },
    { sourceField: 'Name', targetField: 'firstname', sourceContext: 'contactEmployee' },
    { sourceField: 'InternalCode', targetField: 'internalcode', sourceContext: 'contactEmployee' },
  ];

  it('encuentra al existente por InternalCode aunque el nombre y el email hayan cambiado', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = jest.spyOn(adapter, 'request');

    const businessPartner = {
      ContactEmployees: [{ InternalCode: 91848, Name: 'Nombre Viejo', E_Mail: 'viejo@example.com' }],
    };
    // El contacto trae internalcode="91848" (ya se sincronizó antes), pero su
    // nombre y email en HubSpot cambiaron desde entonces.
    const contact = { email: 'nuevo@example.com', firstname: 'Nombre Nuevo', internalcode: '91848' };

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    expect(result.created).toBe(false);
    expect(result.internalCode).toBe(91848);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('el InternalCode gana sobre una coincidencia por nombre con otro empleado', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = jest.spyOn(adapter, 'request');

    const businessPartner = {
      ContactEmployees: [
        { InternalCode: 1, Name: 'Juan', E_Mail: 'juan.viejo@example.com' },
        { InternalCode: 2, Name: 'Otro Nombre', E_Mail: 'juan@example.com' },
      ],
    };
    // El nombre "Juan" coincidiría con InternalCode 1 por el fallback, pero el
    // internalcode que trae el contacto apunta al InternalCode 2: debe ganar ese.
    const contact = { email: 'juan@example.com', firstname: 'Juan', internalcode: '2' };

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    expect(result.created).toBe(false);
    expect(result.internalCode).toBe(2);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('si el InternalCode no matchea a nadie, cae al fallback por email y no intenta crear un duplicado', async () => {
    // Reproduce el caso real: HubSpot trae un internalcode viejo/desactualizado
    // (91845) que ya no corresponde a nadie en SAP, pero el email sí coincide
    // con un ContactEmployee que ya existe (91896, reasignado en SAP).
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = jest.spyOn(adapter, 'request');

    const businessPartner = {
      ContactEmployees: [
        { InternalCode: 91896, Name: 'Emerson Flores', E_Mail: 'operadorcc1@grupoprinter.com' },
        { InternalCode: 91838, Name: 'LUIS DAVILA', E_Mail: 'soporte@top50.com.gt' },
      ],
    };
    const contact = {
      email: 'operadorcc1@grupoprinter.com',
      firstname: 'Emerson',
      lastname: 'Flores',
      internalcode: '91845',
    };

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO061620',
      businessPartner,
      contact,
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    expect(result.created).toBe(false);
    expect(result.internalCode).toBe(91896);
    // Nunca debe llegar a intentar el PATCH de alta: eso es lo que SAP rechazaba
    // con "This entry already exists" (ODBC -2035).
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('si SAP rechaza el alta (Name duplicado no detectado por el matching), no lanza y reporta el error', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const sapError = Object.assign(new Error('This entry already exists in the following tables (ODBC -2035)'), {
      response: { status: 400 },
    });
    jest.spyOn(adapter, 'request').mockRejectedValue(sapError);

    const businessPartner = { ContactEmployees: [] };
    const contact = { email: 'nuevo@example.com', firstname: 'Nuevo' };

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO061620',
      businessPartner,
      contact,
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    expect(result.created).toBe(false);
    expect(result.error).toBe(sapError);
  });

  it('addContactEmployeesIfNeeded sigue con el resto de contactos aunque uno falle en SAP', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const sapError = new Error('This entry already exists in the following tables (ODBC -2035)');
    adapter.addContactEmployeeIfNeeded = jest.fn()
      .mockResolvedValueOnce({ created: false, internalCode: null, requestPayload: {}, responsePayload: null, error: sapError })
      .mockResolvedValueOnce({ created: true, internalCode: 999, requestPayload: {}, responsePayload: {} });

    const result = await adapter.addContactEmployeesIfNeeded({
      sapConfig: {},
      cardCode: 'CLO061620',
      businessPartner: { ContactEmployees: [] },
      contacts: [{ email: 'uno@example.com' }, { email: 'dos@example.com' }],
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    expect(adapter.addContactEmployeeIfNeeded).toHaveBeenCalledTimes(2);
    expect(result.internalCodes).toEqual([{ contact: { email: 'dos@example.com' }, internalCode: 999 }]);
  });

  // Seguir con el resto no basta: el error del que falló tiene que salir del
  // adapter para que alguien pueda loguearlo y contarlo. Antes solo quedaba
  // enterrado en `results[i].error`, que ningún caso de uso lee.
  it('addContactEmployeesIfNeeded devuelve los fallos en `errors`', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const sapError = new Error("Value too long in property 'Title' of 'ContactEmployee'");
    adapter.addContactEmployeeIfNeeded = jest.fn()
      .mockResolvedValueOnce({
        created: false,
        internalCode: null,
        requestPayload: { Name: 'Uno', Title: 'MICROCREDITOS CNTRAL' },
        responsePayload: null,
        error: sapError,
      })
      .mockResolvedValueOnce({ created: true, internalCode: 999, requestPayload: {}, responsePayload: {} });

    const result = await adapter.addContactEmployeesIfNeeded({
      sapConfig: {},
      cardCode: 'CLO061620',
      businessPartner: { ContactEmployees: [] },
      contacts: [{ email: 'uno@example.com' }, { email: 'dos@example.com' }],
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    expect(result.errors).toEqual([
      {
        contact: { email: 'uno@example.com' },
        requestPayload: { Name: 'Uno', Title: 'MICROCREDITOS CNTRAL' },
        error: sapError,
      },
    ]);
  });

  it('addContactEmployeesIfNeeded devuelve `errors` vacio cuando todos entran', async () => {
    const adapter = new SapWebhookOrderAdapter();
    adapter.addContactEmployeeIfNeeded = jest.fn()
      .mockResolvedValue({ created: true, internalCode: 999, requestPayload: {}, responsePayload: {} });

    const result = await adapter.addContactEmployeesIfNeeded({
      sapConfig: {},
      cardCode: 'CLO061620',
      businessPartner: { ContactEmployees: [] },
      contacts: [{ email: 'uno@example.com' }],
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    expect(result.errors).toEqual([]);
  });

  it('nunca manda InternalCode de vuelta al crear un ContactEmployee nuevo', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = jest.spyOn(adapter, 'request').mockImplementation(async (sapConfig, { method }) => {
      if (method === 'patch') {
        return {};
      }
      return { ContactEmployees: [] };
    });

    const businessPartner = { ContactEmployees: [] };
    // Contacto nuevo: nunca se sincronizó, así que su propiedad internalcode viene vacía.
    const contact = { email: 'nuevo@example.com', firstname: 'Nuevo', internalcode: '' };

    await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings: mappingsWithInternalCode,
    });

    const patchCall = requestSpy.mock.calls.find(([, options]) => options.method === 'patch');
    const newEmployee = patchCall[1].data.ContactEmployees[0];

    expect(newEmployee).not.toHaveProperty('InternalCode');
  });
});

describe('SapWebhookOrderAdapter.addContactEmployeeIfNeeded upsert hook', () => {
  const contactEmployeeMappings = [
    { sourceField: 'E_Mail', targetField: 'email', sourceContext: 'contactEmployee' },
    { sourceField: 'Name', targetField: 'firstname', sourceContext: 'contactEmployee' },
  ];

  it('does not touch SAP when upsertConfig.required is false, even on a match', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const requestSpy = jest.spyOn(adapter, 'request');

    const businessPartner = {
      ContactEmployees: [{ InternalCode: 1, Name: 'Juan', E_Mail: 'juan@old.com' }],
    };
    const contact = { email: 'juan@old.com', firstname: 'Juan' };

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings,
      upsertConfig: { required: false, fieldsUpdated_BP: [], fieldsUpdated_CE: ['Name'] },
    });

    expect(result.created).toBe(false);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('PATCHes only the diffed employee fields, keeping every other employee untouched', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const otherEmployee = { InternalCode: 2, Name: 'Otro', E_Mail: 'otro@example.com' };
    const businessPartner = {
      ContactEmployees: [
        otherEmployee,
        { InternalCode: 1, Name: 'Juan Viejo', E_Mail: 'juan@old.com' },
      ],
    };
    const contact = { email: 'juan@old.com', firstname: 'Juan Nuevo' };

    const requestSpy = jest.spyOn(adapter, 'request').mockResolvedValue({});

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings,
      upsertConfig: { required: true, fieldsUpdated_BP: [], fieldsUpdated_CE: ['Name'] },
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [, { method, path, data }] = requestSpy.mock.calls[0];
    expect(method).toBe('patch');
    expect(path).toBe("/BusinessPartners('CLO017007')");
    expect(data.ContactEmployees).toEqual([
      otherEmployee,
      { InternalCode: 1, Name: 'Juan Nuevo', E_Mail: 'juan@old.com' },
    ]);

    expect(result.updateResult.updated).toBe(true);
    expect(result.updateResult.requestPayload).toEqual({ Name: 'Juan Nuevo' });
  });

  it('does not PATCH when the configured field has not changed', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const businessPartner = {
      ContactEmployees: [{ InternalCode: 1, Name: 'Juan', E_Mail: 'juan@old.com' }],
    };
    const contact = { email: 'juan@old.com', firstname: 'Juan' };
    const requestSpy = jest.spyOn(adapter, 'request');

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings,
      upsertConfig: { required: true, fieldsUpdated_BP: [], fieldsUpdated_CE: ['Name'] },
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(result.updateResult.updated).toBe(false);
  });

  it('supports EmailAddress in fieldsUpdated_CE by writing E_Mail', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const businessPartner = {
      ContactEmployees: [{ InternalCode: 1, Name: 'Juan', E_Mail: 'juan@old.com' }],
    };
    const contact = { email: 'juan@new.com', firstname: 'Juan' };
    const requestSpy = jest.spyOn(adapter, 'request').mockResolvedValue({});

    await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings,
      upsertConfig: { required: true, fieldsUpdated_BP: [], fieldsUpdated_CE: ['EmailAddress'] },
    });

    const [, { data }] = requestSpy.mock.calls[0];
    expect(data.ContactEmployees[0].E_Mail).toBe('juan@new.com');
    expect(data.ContactEmployees[0]).not.toHaveProperty('EmailAddress');
  });

  it('swallows SAP errors from the update PATCH without throwing', async () => {
    const adapter = new SapWebhookOrderAdapter();
    const businessPartner = {
      ContactEmployees: [{ InternalCode: 1, Name: 'Juan', E_Mail: 'juan@old.com' }],
    };
    const contact = { email: 'juan@old.com', firstname: 'Juan Nuevo' };
    jest.spyOn(adapter, 'request').mockRejectedValue(new Error('SAP is down'));

    const result = await adapter.addContactEmployeeIfNeeded({
      sapConfig: {},
      cardCode: 'CLO017007',
      businessPartner,
      contact,
      contactEmployeeMappings,
      upsertConfig: { required: true, fieldsUpdated_BP: [], fieldsUpdated_CE: ['Name'] },
    });

    expect(result.updateResult.updated).toBe(false);
    expect(result.updateResult.error).toBeInstanceOf(Error);
  });
});
