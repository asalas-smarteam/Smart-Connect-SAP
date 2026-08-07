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
