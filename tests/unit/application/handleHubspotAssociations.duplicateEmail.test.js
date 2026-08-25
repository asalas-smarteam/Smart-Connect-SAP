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
