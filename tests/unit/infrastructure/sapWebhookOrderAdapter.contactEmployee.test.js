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
