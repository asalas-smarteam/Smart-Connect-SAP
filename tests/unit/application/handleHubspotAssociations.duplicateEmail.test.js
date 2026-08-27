import { jest } from '@jest/globals';
import { HandleHubspotAssociations } from '../../../src/application/use-cases/HandleHubspotAssociations.js';

// Identidad de los ContactEmployees en el camino secuencial. La regla vigente
// (el plus addressing +InternalCode se probó y se REVIRTIÓ porque duplicaba
// contactos cuando el dueño del email no tenía internalcode):
//   1. si existe por internalcode -> update;
//   2. si no, existe por email -> update (adopta el internalcode);
//   3. si no existe por ninguno -> create + asociación al BP.
function buildHandler() {
  const contactHandler = {
    find: jest.fn(async () => null),
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

describe('syncCompanyContacts — identidad de ContactEmployees (sin plus addressing)', () => {
  it('el email del CE se envía TAL CUAL viene de SAP, nunca reescrito', async () => {
    const { handler, contactHandler } = buildHandler();

    const { contactErrors } = await handler.syncCompanyContacts({
      token: 't',
      item: buildCompanyItem([
        { InternalCode: 91643, Name: 'Marleni', E_Mail: 'recepcion@tecnopack.net' },
      ]),
      clientConfig,
      tenantModels: {},
      companyHubspotId: 'hs-co-1',
    });

    expect(contactErrors).toEqual([]);
    expect(contactHandler.create.mock.calls[0][0].item.properties.email)
      .toBe('recepcion@tecnopack.net');
  });

  it('regla 1: si existe por internalcode, actualiza ese contacto', async () => {
    const { handler, contactHandler } = buildHandler();
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
    // El find del CE es findContactEmployee (internalcode primero, email al
    // final), nunca el find genérico gobernado por defaultFindHubspot.
    expect(contactHandler.findContactEmployee).toHaveBeenCalledWith(expect.objectContaining({
      internalcode: 91643,
      email: 'recepcion@tecnopack.net',
    }));
    expect(contactHandler.find).not.toHaveBeenCalled();
  });

  it('regla 2: dos CEs con el mismo email resuelven al MISMO contacto (update, no duplicado ni 409)', async () => {
    const { handler, contactHandler, associationService } = buildHandler();
    // Marleni no existe todavía; Sofia matchea por email al contacto que
    // Marleni acaba de crear (el mock emula el fallback por email del handler).
    contactHandler.findContactEmployee
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'hs-91643',
        properties: { internalcode: '91643', email: 'recepcion@tecnopack.net' },
      });

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
    expect(contactHandler.create).toHaveBeenCalledTimes(1);
    expect(contactHandler.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'hs-91643' }));
    // Los emails salen tal cual vienen de SAP, sin sufijos.
    expect(contactHandler.create.mock.calls[0][0].item.properties.email)
      .toBe('recepcion@tecnopack.net');
    // Ambos sapIds quedan asociados al BP aunque compartan contacto.
    expect(associationService.associateObjectsBySapId).toHaveBeenCalledTimes(2);
  });

  it('regla 3: si no existe por internalcode ni email, crea y asocia al BP', async () => {
    const { handler, contactHandler, associationService, associationRegistry } = buildHandler();

    await handler.syncCompanyContacts({
      token: 't',
      item: buildCompanyItem([{ InternalCode: 91643, Name: 'Marleni', E_Mail: 'recepcion@tecnopack.net' }]),
      clientConfig,
      tenantModels: {},
      companyHubspotId: 'hs-co-1',
    });

    expect(contactHandler.create).toHaveBeenCalledTimes(1);
    expect(associationRegistry.registerBaseObjectMapping).toHaveBeenCalledWith(
      'cred-1', 'contact', 91643, 'hs-91643', {}
    );
    expect(associationService.associateObjectsBySapId).toHaveBeenCalledWith(
      't', 'cred-1', 'company', 'hs-co-1', 'contact',
      [{ hubspotId: 'hs-91643', sapId: 91643 }], {}
    );
  });
});
